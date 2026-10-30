// Copyright (c) 2026 Delta Backupper contributors. MIT licensed.
// The helper owns APFS leases; source contents never cross this privileged channel.
#import <Foundation/Foundation.h>
#import <CoreFoundation/CoreFoundation.h>
#include <sys/attr.h>
#include <sys/mount.h>
#include <sys/socket.h>
#include <sys/snapshot.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <sys/sysctl.h>
#include <sys/proc_info.h>
#include <sys/un.h>
#include <uuid/uuid.h>
#include <dirent.h>
#include <libproc.h>
#include <fstream>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <unistd.h>
#include <algorithm>
#include <array>
#include <cerrno>
#include <chrono>
#include <climits>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <iostream>
#include <map>
#include <set>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace {
constexpr size_t FrameLimit = 65536;
constexpr int HeartbeatSeconds = 45;
constexpr uint64_t SafeMountFlags = MNT_RDONLY | MNT_NOSUID | MNT_NODEV | MNT_NOEXEC;
constexpr const char *RuntimeRoot = "/private/var/run/delta-backupper";
constexpr const char *JournalRoot = "/private/var/db/delta-backupper/snapshots";
volatile sig_atomic_t interrupted = 0;
void stopSignal(int) { interrupted = 1; }
struct Failure : std::runtime_error {
  std::string code;
  bool cleanupUnknown;
  Failure(std::string code_, std::string message, bool unknown = false) : std::runtime_error(std::move(message)), code(std::move(code_)), cleanupUnknown(unknown) {}
};
[[noreturn]] void systemFailure(const std::string &operation, int error = errno) {
  const bool permission = error == EPERM || error == EACCES;
  throw Failure(permission ? "SNAPSHOT_PERMISSION_OR_ENTITLEMENT" : "SNAPSHOT_SYSTEM_ERROR",
    operation + ": " + std::strerror(error) + (permission ? "; APFS snapshot APIs require an Apple-authorized snapshot entitlement and the required system permissions. Administrator access alone is insufficient." : ""));
}
struct Descriptor {
  int fd = -1;
  Descriptor() = default;
  explicit Descriptor(int value) : fd(value) {}
  Descriptor(const Descriptor &) = delete;
  Descriptor &operator=(const Descriptor &) = delete;
  Descriptor(Descriptor &&other) noexcept : fd(std::exchange(other.fd, -1)) {}
  Descriptor &operator=(Descriptor &&other) noexcept { if (this != &other) { if (fd >= 0) close(fd); fd = std::exchange(other.fd, -1); } return *this; }
  ~Descriptor() { if (fd >= 0) close(fd); }
};
bool uuidText(const std::string &value) {
  if (value.size() != 36) return false;
  uuid_t bytes;
  return uuid_parse(value.c_str(), bytes) == 0;
}
std::string newUuid() { uuid_t value; uuid_generate_random(value); char text[37]; uuid_unparse_lower(value, text); return text; }
bool hexNonce(const std::string &value) { return value.size() == 64 && std::all_of(value.begin(), value.end(), [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); }); }
bool absolutePath(const std::string &value) {
  if (value.empty() || value[0] != '/' || value.size() >= PATH_MAX || value.find('\0') != std::string::npos || value.find("//") != std::string::npos) return false;
  size_t offset = 1;
  while (offset <= value.size()) { auto end = value.find('/', offset); if (end == std::string::npos) end = value.size(); const auto part = value.substr(offset, end - offset); if (part == "." || part == "..") return false; offset = end + 1; }
  return value.size() == 1 || value.back() != '/';
}
bool inside(const std::string &parent, const std::string &value) { return parent == "/" || parent == value || (value.size() > parent.size() && value.compare(0, parent.size(), parent) == 0 && value[parent.size()] == '/'); }
std::string parentPath(const std::string &value) { const auto offset = value.find_last_of('/'); return offset == 0 ? "/" : value.substr(0, offset); }
std::string suffix(const std::string &root, const std::string &value) { if (!inside(root, value)) throw Failure("SNAPSHOT_PATH_UNAVAILABLE", "Source path is outside its APFS volume"); return root == "/" ? value.substr(1) : value == root ? "" : value.substr(root.size() + 1); }
std::string joined(const std::string &parent, const std::string &child) { return child.empty() ? parent : parent + (parent == "/" ? "" : "/") + child; }
NSString *string(const std::string &value) { NSString *result = [[NSString alloc] initWithBytes:value.data() length:value.size() encoding:NSUTF8StringEncoding]; if (!result) throw Failure("SNAPSHOT_INVALID_REQUEST", "Invalid UTF-8 text"); return result; }
std::string text(id value, const char *field, size_t limit = PATH_MAX - 1) {
  if (![value isKindOfClass:[NSString class]]) throw Failure("SNAPSHOT_INVALID_REQUEST", std::string("Expected text: ") + field);
  NSData *data = [(NSString *)value dataUsingEncoding:NSUTF8StringEncoding allowLossyConversion:NO];
  if (!data || data.length > limit) throw Failure("SNAPSHOT_INVALID_REQUEST", std::string("Invalid or oversized text: ") + field);
  std::string result(static_cast<const char *>(data.bytes), data.length);
  if (result.find('\0') != std::string::npos) throw Failure("SNAPSHOT_INVALID_REQUEST", "NUL is forbidden in protocol text");
  return result;
}
void exactKeys(NSDictionary *value, std::initializer_list<const char *> names) {
  if (![value isKindOfClass:[NSDictionary class]]) throw Failure("SNAPSHOT_INVALID_REQUEST", "Expected a JSON object");
  for (id key in value) {
    const auto current = text(key, "key", 64);
    if (std::none_of(names.begin(), names.end(), [&](const char *expected) { return current == expected; })) throw Failure("SNAPSHOT_INVALID_REQUEST", "Unexpected request field");
  }
}
NSDictionary *parseFrame(const std::string &frame) {
  if (frame.empty() || frame.size() > FrameLimit) throw Failure("SNAPSHOT_INVALID_REQUEST", "Invalid protocol frame length");
  NSData *bytes = [NSData dataWithBytes:frame.data() length:frame.size()]; NSError *error = nil;
  id result = [NSJSONSerialization JSONObjectWithData:bytes options:0 error:&error];
  if (error || ![result isKindOfClass:[NSDictionary class]]) throw Failure("SNAPSHOT_INVALID_REQUEST", "Expected a UTF-8 JSON object");
  return result;
}
uint32_t unsignedId(const std::string &value, bool allowZero = false) {
  if (value.empty() || value.size() > 10 || !std::all_of(value.begin(), value.end(), [](char c) { return c >= '0' && c <= '9'; })) throw Failure("SNAPSHOT_INVALID_REQUEST", "Invalid user identity");
  const auto result = std::stoull(value);
  if ((!allowZero && result == 0) || result >= UINT32_MAX) throw Failure("SNAPSHOT_INVALID_REQUEST", "A non-root user identity and a valid group identity are required");
  return static_cast<uint32_t>(result);
}
void ensureNotInterrupted() { if (interrupted) throw Failure("SNAPSHOT_CANCELLED", "Snapshot helper was interrupted"); }
void directoryComponents(const std::string &value, uid_t client, bool socketParent) {
  if (!absolutePath(value)) throw Failure("SNAPSHOT_UNSAFE_SOCKET", "Unsafe absolute directory path");
  std::string current;
  size_t offset = 1;
  while (offset <= value.size()) {
    auto end = value.find('/', offset); if (end == std::string::npos) end = value.size();
    const auto component = value.substr(offset, end - offset); offset = end + 1;
    if (component.empty()) continue;
    current += "/" + component;
    struct stat info{};
    if (lstat(current.c_str(), &info) || !S_ISDIR(info.st_mode) || S_ISLNK(info.st_mode)) throw Failure("SNAPSHOT_UNSAFE_SOCKET", "Socket directory contains an unavailable or symbolic component");
    if (info.st_uid != 0 && info.st_uid != client) throw Failure("SNAPSHOT_UNSAFE_SOCKET", "Socket directory is owned by another user");
    const bool sharedSticky = info.st_uid == 0 && (info.st_mode & S_ISVTX);
    if ((info.st_mode & 0022) && !sharedSticky) throw Failure("SNAPSHOT_UNSAFE_SOCKET", "Socket directory is writable by another user");
    if (socketParent && current == value && (info.st_uid != client || (info.st_mode & 0777) != 0700)) throw Failure("SNAPSHOT_UNSAFE_SOCKET", "Socket parent must be caller-owned with mode 0700");
  }
}
Descriptor connectSocket(const std::string &path, uid_t client, gid_t clientGroup) {
  if (!absolutePath(path) || path.size() >= sizeof(sockaddr_un::sun_path)) throw Failure("SNAPSHOT_UNSAFE_SOCKET", "Invalid local socket path");
  directoryComponents(parentPath(path), client, true);
  struct stat before{};
  if (lstat(path.c_str(), &before) || !S_ISSOCK(before.st_mode) || before.st_uid != client || (before.st_mode & 0077)) throw Failure("SNAPSHOT_UNSAFE_SOCKET", "Socket must be caller-owned and private");
  Descriptor connection(socket(AF_UNIX, SOCK_STREAM, 0)); if (connection.fd < 0) systemFailure("Create local socket");
  if (fcntl(connection.fd, F_SETFD, FD_CLOEXEC)) systemFailure("Protect local socket descriptor");
  sockaddr_un address{}; address.sun_family = AF_UNIX; address.sun_len = sizeof(address); std::memcpy(address.sun_path, path.c_str(), path.size() + 1);
  if (connect(connection.fd, reinterpret_cast<sockaddr *>(&address), sizeof(address))) systemFailure("Connect local snapshot channel");
  uid_t peer = 0; gid_t group = 0;
  if (getpeereid(connection.fd, &peer, &group) || peer != client || group != clientGroup) throw Failure("SNAPSHOT_UNSAFE_SOCKET", "Snapshot channel peer identity differs from the requesting user");
  struct stat after{};
  if (lstat(path.c_str(), &after) || before.st_dev != after.st_dev || before.st_ino != after.st_ino || !S_ISSOCK(after.st_mode) || after.st_uid != client) throw Failure("SNAPSHOT_UNSAFE_SOCKET", "Snapshot socket identity changed during connection");
  timeval timeout{5, 0};
  if (setsockopt(connection.fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout))) systemFailure("Bound snapshot response writes");
  return connection;
}
void sendJson(int connection, NSDictionary *value) {
  NSError *error = nil; NSData *bytes = [NSJSONSerialization dataWithJSONObject:value options:0 error:&error];
  if (error || !bytes || bytes.length > FrameLimit) throw Failure("SNAPSHOT_PROTOCOL_ERROR", "Snapshot response exceeds its bounded frame");
  const auto *pointer = static_cast<const uint8_t *>(bytes.bytes); size_t offset = 0;
  while (offset < bytes.length) { const auto result = send(connection, pointer + offset, bytes.length - offset, 0); if (result < 0 && errno == EINTR) continue; if (result <= 0) systemFailure("Write snapshot response"); offset += static_cast<size_t>(result); }
  const char newline = '\n'; if (send(connection, &newline, 1, 0) != 1) systemFailure("Write snapshot frame boundary");
}
std::string readFrame(int connection, std::string &pending) {
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(HeartbeatSeconds);
  for (;;) {
    ensureNotInterrupted();
    const auto end = pending.find('\n');
    if (end != std::string::npos) { const auto result = pending.substr(0, end); pending.erase(0, end + 1); if (result.size() > FrameLimit) throw Failure("SNAPSHOT_PROTOCOL_ERROR", "Snapshot request is too large"); return result; }
    if (pending.size() > FrameLimit) throw Failure("SNAPSHOT_PROTOCOL_ERROR", "Snapshot request is too large");
    if (std::chrono::steady_clock::now() >= deadline) throw Failure("SNAPSHOT_HEARTBEAT_TIMEOUT", "Snapshot client heartbeat timed out");
    pollfd item{connection, POLLIN, 0}; const auto ready = poll(&item, 1, 500);
    if (ready < 0 && errno == EINTR) continue;
    if (ready < 0) systemFailure("Read snapshot channel");
    if (!ready) continue;
    char buffer[4096]; const auto count = recv(connection, buffer, std::min(sizeof(buffer), FrameLimit + 1 - pending.size()), 0);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) throw Failure("SNAPSHOT_CLIENT_DISCONNECTED", "Snapshot client disconnected");
    pending.append(buffer, static_cast<size_t>(count));
  }
}
std::string fdCanonical(int fd) {
  char path[PATH_MAX];
  // realpath and F_GETPATH preserve /Users firmlinks; this public fcntl
  // operation identifies the physical Data volume path instead.
  if (fcntl(fd, F_GETPATH_NOFIRMLINK, path)) systemFailure("Resolve source without firmlinks");
  std::string result(path);
  if (!absolutePath(result)) throw Failure("SNAPSHOT_PATH_UNAVAILABLE", "Source has no stable physical volume path");
  return result;
}
struct RootMetadata {
  Descriptor source;
  std::string canonical;
  struct stat info{};
  struct statfs filesystem{};
};
RootMetadata inspectSourceRoot(const std::string &original) {
  struct stat leaf{}; if (lstat(original.c_str(), &leaf)) systemFailure("Inspect source root without following its final link");
  const bool rootLink = S_ISLNK(leaf.st_mode);
  RootMetadata result;
  result.source = Descriptor(open((rootLink ? parentPath(original) : original).c_str(), O_EVTONLY | O_CLOEXEC));
  if (result.source.fd < 0) systemFailure("Open APFS source identity");
  result.canonical = fdCanonical(result.source.fd);
  if (fstat(result.source.fd, &result.info) || fstatfs(result.source.fd, &result.filesystem)) systemFailure("Read source filesystem metadata");
  if (rootLink) {
    if (!S_ISDIR(result.info.st_mode)) throw Failure("SNAPSHOT_SOURCE_UNSUPPORTED", "Source link parent is not a directory");
    struct stat confirmed{};
    if (lstat(original.c_str(), &confirmed) || confirmed.st_dev != leaf.st_dev || confirmed.st_ino != leaf.st_ino || !S_ISLNK(confirmed.st_mode)) throw Failure("SNAPSHOT_PATH_UNAVAILABLE", "Source link changed while its parent filesystem was being resolved");
    result.canonical = joined(result.canonical, original.substr(original.find_last_of('/') + 1)); result.info = leaf;
  } else if (result.info.st_dev != leaf.st_dev || result.info.st_ino != leaf.st_ino) throw Failure("SNAPSHOT_PATH_UNAVAILABLE", "Source root changed while its filesystem was being resolved");
  return result;
}
std::string volumeUuid(int fd) {
  attrlist request{}; request.bitmapcount = ATTR_BIT_MAP_COUNT; request.volattr = ATTR_VOL_INFO | ATTR_VOL_UUID;
  std::array<uint8_t, 128> buffer{};
  if (fgetattrlist(fd, &request, buffer.data(), buffer.size(), 0)) systemFailure("Read APFS volume identity");
  uint32_t length = 0; std::memcpy(&length, buffer.data(), sizeof(length));
  if (length != sizeof(uint32_t) + sizeof(uuid_t)) throw Failure("SNAPSHOT_IDENTITY_ERROR", "Unexpected APFS volume identity attributes");
  uuid_t identifier; std::memcpy(identifier, buffer.data() + sizeof(uint32_t), sizeof(identifier));
  if (uuid_is_null(identifier)) throw Failure("SNAPSHOT_IDENTITY_ERROR", "APFS volume has no UUID");
  char result[37]; uuid_unparse_lower(identifier, result); return result;
}
bool volumeCaseSensitive(int fd) {
  attrlist request{}; request.bitmapcount = ATTR_BIT_MAP_COUNT; request.volattr = ATTR_VOL_INFO | ATTR_VOL_CAPABILITIES;
  std::array<uint8_t, 128> buffer{};
  if (fgetattrlist(fd, &request, buffer.data(), buffer.size(), 0)) systemFailure("Read APFS case-sensitivity capabilities");
  uint32_t length = 0; std::memcpy(&length, buffer.data(), sizeof(length));
  vol_capabilities_attr_t capabilities{};
  if (length != sizeof(uint32_t) + sizeof(capabilities)) throw Failure("SNAPSHOT_IDENTITY_ERROR", "Unexpected APFS filesystem capabilities");
  std::memcpy(&capabilities, buffer.data() + sizeof(uint32_t), sizeof(capabilities));
  if (!(capabilities.valid[VOL_CAPABILITIES_FORMAT] & VOL_CAP_FMT_CASE_SENSITIVE)) throw Failure("SNAPSHOT_IDENTITY_ERROR", "APFS case-sensitivity capability was not attested");
  return (capabilities.capabilities[VOL_CAPABILITIES_FORMAT] & VOL_CAP_FMT_CASE_SENSITIVE) != 0;
}
std::set<std::string> snapshotNames(int volumeFd) {
  Descriptor enumeration(openat(volumeFd, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW));
  if (enumeration.fd < 0) systemFailure("Open APFS snapshot enumeration");
  attrlist request{}; request.bitmapcount = ATTR_BIT_MAP_COUNT; request.commonattr = ATTR_CMN_NAME;
  std::set<std::string> result; std::array<uint8_t, 65536> buffer{};
  for (;;) {
    const auto count = fs_snapshot_list(enumeration.fd, &request, buffer.data(), buffer.size(), 0);
    if (count < 0) systemFailure("List APFS snapshots");
    if (!count) return result;
    size_t offset = 0;
    for (int index = 0; index < count; ++index) {
      if (offset > buffer.size() - sizeof(uint32_t) - sizeof(attrreference_t)) throw Failure("SNAPSHOT_IDENTITY_ERROR", "Truncated APFS snapshot attributes");
      uint32_t length = 0; attrreference_t name{}; std::memcpy(&length, buffer.data() + offset, sizeof(length)); std::memcpy(&name, buffer.data() + offset + sizeof(length), sizeof(name));
      if (length < sizeof(uint32_t) + sizeof(attrreference_t) || length > buffer.size() - offset || name.attr_dataoffset < static_cast<int32_t>(sizeof(attrreference_t)) || !name.attr_length) throw Failure("SNAPSHOT_IDENTITY_ERROR", "Invalid APFS snapshot attribute record");
      const size_t start = sizeof(uint32_t) + static_cast<size_t>(name.attr_dataoffset);
      if (start > length || name.attr_length > length - start || buffer[offset + start + name.attr_length - 1] != 0) throw Failure("SNAPSHOT_IDENTITY_ERROR", "Invalid APFS snapshot name attributes");
      const std::string value(reinterpret_cast<char *>(buffer.data() + offset + start), name.attr_length - 1);
      if (value.empty() || value.find('/') != std::string::npos || value.find('\0') != std::string::npos || !string(value)) throw Failure("SNAPSHOT_IDENTITY_ERROR", "Unsafe APFS snapshot name");
      result.insert(value); if (result.size() > 100000) throw Failure("SNAPSHOT_LIMIT", "APFS snapshot enumeration exceeded its limit"); offset += length;
    }
  }
}
std::vector<struct statfs> mounts() {
  const auto count = getfsstat(nullptr, 0, MNT_NOWAIT); if (count <= 0 || count > 65536) throw Failure("SNAPSHOT_MOUNT_ERROR", "Cannot enumerate mounted filesystems");
  std::vector<struct statfs> result(static_cast<size_t>(count) + 32);
  const auto read = getfsstat(result.data(), static_cast<int>(result.size() * sizeof(struct statfs)), MNT_NOWAIT);
  if (read < 0 || static_cast<size_t>(read) >= result.size()) throw Failure("SNAPSHOT_MOUNT_ERROR", "Mount table changed beyond the bounded snapshot plan");
  result.resize(static_cast<size_t>(read)); return result;
}
struct Volume {
  std::string root, uuid, device, name, mountPath;
  Descriptor directory;
  struct statfs original{}, mounted{};
  bool created = false, mountedOwned = false, mountAttested = false;
  bool caseSensitive = true;
  std::set<std::string> excluded;
};
bool sameMount(const struct statfs &left, const struct statfs &right) {
  return std::memcmp(&left.f_fsid, &right.f_fsid, sizeof(left.f_fsid)) == 0 && std::strcmp(left.f_mntonname, right.f_mntonname) == 0 && std::strcmp(left.f_mntfromname, right.f_mntfromname) == 0 && std::strcmp(left.f_fstypename, right.f_fstypename) == 0;
}
void verifyOriginal(const Volume &volume) {
  struct statfs current{};
  if (fstatfs(volume.directory.fd, &current) || !sameMount(volume.original, current) || volumeUuid(volume.directory.fd) != volume.uuid) throw Failure("SNAPSHOT_IDENTITY_ERROR", "APFS source volume identity changed");
}
void verifyMounted(const Volume &volume) {
  struct stat info{}; struct statfs current{};
  if (lstat(volume.mountPath.c_str(), &info) || !S_ISDIR(info.st_mode) || S_ISLNK(info.st_mode) || statfs(volume.mountPath.c_str(), &current) || !sameMount(volume.mounted, current) || (current.f_flags & SafeMountFlags) != SafeMountFlags) throw Failure("SNAPSHOT_IDENTITY_ERROR", "Owned APFS snapshot mount identity or safety flags changed");
}
void fixedDirectory(const std::string &path, mode_t mode) {
  const auto created = mkdir(path.c_str(), 0700) == 0;
  if (!created && errno != EEXIST) systemFailure("Create private snapshot workspace");
  if (created && chmod(path.c_str(), mode)) systemFailure("Set private snapshot workspace traversal permissions");
  struct stat info{};
  if (lstat(path.c_str(), &info) || !S_ISDIR(info.st_mode) || S_ISLNK(info.st_mode) || info.st_uid != 0 || (info.st_mode & 0777) != mode) throw Failure("SNAPSHOT_WORKSPACE_ERROR", "Snapshot runtime directory has unsafe ownership or permissions");
}
void durableDirectory(const std::string &path) {
  Descriptor directory(open(path.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
  if (directory.fd < 0 || fsync(directory.fd) || fcntl(directory.fd, F_FULLFSYNC)) systemFailure("Persist APFS journal directory");
}
std::string journalDirectory(uid_t uid) {
  directoryComponents("/private/var/db", 0, false);
  fixedDirectory("/private/var/db/delta-backupper", 0700); fixedDirectory(JournalRoot, 0700);
  const auto result = joined(JournalRoot, std::to_string(uid)); fixedDirectory(result, 0700); return result;
}
Descriptor journalLock(const std::string &directory) {
  Descriptor result(open(joined(directory, ".lock").c_str(), O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0600));
  struct stat info{};
  if (result.fd < 0 || fstat(result.fd, &info) || !S_ISREG(info.st_mode) || info.st_uid != 0 || (info.st_mode & 0777) != 0600 || info.st_nlink != 1) throw Failure("SNAPSHOT_RECOVERY_REQUIRED", "Unsafe APFS journal lock: " + directory, true);
  if (flock(result.fd, LOCK_EX | LOCK_NB)) throw Failure("SNAPSHOT_BUSY", "Another APFS snapshot lease for this user is active");
  return result;
}
struct BootIdentity { std::string uuid, seconds, microseconds; };
BootIdentity bootIdentity() {
  timeval boot{}; size_t size = sizeof(boot); int request[] = {CTL_KERN, KERN_BOOTTIME};
  if (sysctl(request, 2, &boot, &size, nullptr, 0) || size != sizeof(boot) || boot.tv_sec <= 0) systemFailure("Identify current boot for APFS journal recovery");
  BootIdentity result{"", std::to_string(boot.tv_sec), std::to_string(boot.tv_usec)};
  char identifier[128]{}; size = sizeof(identifier);
  if (sysctlbyname("kern.bootsessionuuid", identifier, &size, nullptr, 0) == 0 && size && size <= sizeof(identifier) && identifier[size - 1] == 0 && uuidText(identifier)) result.uuid = identifier;
  // A missing boot UUID never turns a changed wall clock into proof that a
  // live PID is dead. Such owners remain conservatively blocked below.
  return result;
}
uint64_t decimal(const std::string &value, const char *description, uint64_t maximum = UINT64_MAX) {
  if (value.empty() || value.size() > 20 || !std::all_of(value.begin(), value.end(), [](char c) { return c >= '0' && c <= '9'; })) throw Failure("SNAPSHOT_RECOVERY_REQUIRED", std::string("Invalid journal ") + description, true);
  try { const auto result = std::stoull(value); if (result <= maximum) return result; } catch (const std::exception &) {}
  throw Failure("SNAPSHOT_RECOVERY_REQUIRED", std::string("Out-of-range journal ") + description, true);
}
struct JournalVolume {
  std::string root, uuid, device, name, mountPath, mountedFrom;
  int32_t fsid0 = 0, fsid1 = 0;
  bool mountAttested = false;
};
struct Journal {
  std::string session, workspace, bootUuid, bootSeconds, bootMicroseconds, processStartSeconds, processStartMicroseconds;
  pid_t owner = 0;
  std::vector<JournalVolume> volumes;
};
bool jsonBoolean(id value) { return [value isKindOfClass:[NSNumber class]] && CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID(); }
Journal validateJournal(NSDictionary *document, uid_t uid, const std::string &filename) {
  exactKeys(document, {"schemaVersion", "platform", "sessionId", "clientUid", "pid", "bootUuid", "bootSeconds", "bootMicroseconds", "processStartSeconds", "processStartMicroseconds", "workspace", "volumes"});
  if (![document[@"schemaVersion"] isKindOfClass:[NSNumber class]] || jsonBoolean(document[@"schemaVersion"]) || ![document[@"schemaVersion"] isEqualToNumber:@1] || text(document[@"platform"], "journal platform", 8) != "darwin" || text(document[@"clientUid"], "journal UID", 10) != std::to_string(uid)) throw Failure("SNAPSHOT_RECOVERY_REQUIRED", "Journal has an invalid schema or user identity", true);
  Journal result; result.session = text(document[@"sessionId"], "journal session", 36);
  if (!uuidText(result.session) || filename != result.session + ".json") throw Failure("SNAPSHOT_RECOVERY_REQUIRED", "Journal filename does not match its session identity", true);
  result.owner = static_cast<pid_t>(decimal(text(document[@"pid"], "journal PID", 10), "PID", INT_MAX));
  if (result.owner <= 0) throw Failure("SNAPSHOT_RECOVERY_REQUIRED", "Journal has no owner PID", true);
  result.bootUuid = text(document[@"bootUuid"], "journal boot UUID", 36);
  if (!result.bootUuid.empty() && !uuidText(result.bootUuid)) throw Failure("SNAPSHOT_RECOVERY_REQUIRED", "Journal boot UUID is invalid", true);
  result.bootSeconds = text(document[@"bootSeconds"], "journal boot seconds", 20); (void)decimal(result.bootSeconds, "boot seconds");
  result.bootMicroseconds = text(document[@"bootMicroseconds"], "journal boot microseconds", 6); (void)decimal(result.bootMicroseconds, "boot microseconds", 999999);
  result.processStartSeconds = text(document[@"processStartSeconds"], "journal process start", 20); (void)decimal(result.processStartSeconds, "process start seconds");
  result.processStartMicroseconds = text(document[@"processStartMicroseconds"], "journal process start microseconds", 6); (void)decimal(result.processStartMicroseconds, "process start microseconds", 999999);
  result.workspace = text(document[@"workspace"], "journal workspace");
  const auto expectedWorkspace = joined(joined(RuntimeRoot, std::to_string(uid)), result.session);
  if (result.workspace != expectedWorkspace) throw Failure("SNAPSHOT_RECOVERY_REQUIRED", "Journal workspace escapes its fixed user/session directory", true);
  id volumes = document[@"volumes"];
  if (![volumes isKindOfClass:[NSArray class]] || [volumes count] == 0 || [volumes count] > 64) throw Failure("SNAPSHOT_RECOVERY_REQUIRED", "Journal has an invalid volume count", true);
  std::set<std::string> identities;
  for (id item in volumes) {
    exactKeys(item, {"root", "uuid", "device", "name", "mountPath", "mountAttested", "mountedFrom", "fsid0", "fsid1"});
    JournalVolume volume; volume.root = text(item[@"root"], "journal source volume"); volume.uuid = text(item[@"uuid"], "journal volume UUID", 36);
    volume.device = text(item[@"device"], "journal source device"); volume.name = text(item[@"name"], "journal snapshot name", 80); volume.mountPath = text(item[@"mountPath"], "journal mount path");
    if (!absolutePath(volume.root) || !uuidText(volume.uuid) || !absolutePath(volume.device) || volume.name != "delta-" + result.session + "-" + std::to_string(result.volumes.size()) || volume.mountPath != joined(expectedWorkspace, "volume-" + std::to_string(result.volumes.size())) || !identities.insert(volume.uuid + ":" + volume.name).second || !jsonBoolean(item[@"mountAttested"])) throw Failure("SNAPSHOT_RECOVERY_REQUIRED", "Journal has an unsafe volume, snapshot or mount identity", true);
    volume.mountAttested = [item[@"mountAttested"] boolValue];
    volume.mountedFrom = text(item[@"mountedFrom"], "journal mounted device");
    auto signedInteger = [&](id input) { const auto value = text(input, "journal filesystem ID", 11); size_t used = 0; try { const auto parsed = std::stoll(value, &used); if (used == value.size() && parsed >= INT32_MIN && parsed <= INT32_MAX) return static_cast<int32_t>(parsed); } catch (const std::exception &) {} throw Failure("SNAPSHOT_RECOVERY_REQUIRED", "Journal has an invalid filesystem ID", true); };
    volume.fsid0 = signedInteger(item[@"fsid0"]); volume.fsid1 = signedInteger(item[@"fsid1"]);
    if (volume.mountAttested && volume.mountedFrom.empty()) throw Failure("SNAPSHOT_RECOVERY_REQUIRED", "Journal is missing its attested mount source", true);
    if (!volume.mountAttested && (!volume.mountedFrom.empty() || volume.fsid0 || volume.fsid1)) throw Failure("SNAPSHOT_RECOVERY_REQUIRED", "Journal has ambiguous pre-mount state", true);
    result.volumes.push_back(std::move(volume));
  }
  return result;
}
NSDictionary *readJournal(const std::string &file) {
  Descriptor input(open(file.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC)); struct stat info{};
  if (input.fd < 0 || fstat(input.fd, &info) || !S_ISREG(info.st_mode) || info.st_uid != 0 || (info.st_mode & 0777) != 0600 || info.st_nlink != 1 || info.st_size <= 0 || info.st_size > static_cast<off_t>(FrameLimit)) throw Failure("SNAPSHOT_RECOVERY_REQUIRED", "Journal has unsafe ownership, type or size: " + file, true);
  std::string result(static_cast<size_t>(info.st_size), '\0'); size_t offset = 0;
  while (offset < result.size()) { const auto count = read(input.fd, result.data() + offset, result.size() - offset); if (count < 0 && errno == EINTR) continue; if (count <= 0) throw Failure("SNAPSHOT_RECOVERY_REQUIRED", "Could not read complete journal: " + file, true); offset += static_cast<size_t>(count); }
  char extra = 0; if (read(input.fd, &extra, 1) != 0) throw Failure("SNAPSHOT_RECOVERY_REQUIRED", "Journal changed while reading: " + file, true);
  return parseFrame(result);
}
void removeOwnedMetadata(const std::string &file) {
  struct stat info{};
  if (lstat(file.c_str(), &info)) { if (errno == ENOENT) return; systemFailure("Check owned APFS journal"); }
  if (!S_ISREG(info.st_mode) || S_ISLNK(info.st_mode) || info.st_uid != 0 || (info.st_mode & 0777) != 0600 || info.st_nlink != 1) throw Failure("SNAPSHOT_RECOVERY_REQUIRED", "Refusing to remove changed journal metadata: " + file, true);
  if (unlink(file.c_str())) systemFailure("Remove confirmed-clean APFS journal");
}
void recoverJournals(uid_t uid, const std::string &directory) {
  DIR *entries = opendir(directory.c_str()); if (!entries) throw Failure("SNAPSHOT_RECOVERY_REQUIRED", "Cannot enumerate APFS journals: " + directory, true);
  std::vector<std::string> files, pending; errno = 0;
  while (const auto *entry = readdir(entries)) {
    const std::string name(entry->d_name);
    if (name.ends_with(".json")) files.push_back(name);
    else if (name.starts_with('.') && name.ends_with(".new") && name.size() == 41 && uuidText(name.substr(1, 36))) pending.push_back(name);
    else if (name != "." && name != ".." && name != ".lock") { closedir(entries); throw Failure("SNAPSHOT_RECOVERY_REQUIRED", "Unrecognized metadata in APFS journal directory: " + joined(directory, name), true); }
    if (files.size() + pending.size() > 1024) { closedir(entries); throw Failure("SNAPSHOT_RECOVERY_REQUIRED", "APFS journal count exceeds its bounded recovery limit: " + directory, true); }
    errno = 0;
  }
  const auto enumerationError = errno; closedir(entries);
  if (enumerationError) throw Failure("SNAPSHOT_RECOVERY_REQUIRED", "APFS journal enumeration was incomplete: " + directory, true);
  // A committed intent is sufficient for recovery if a later atomic update
  // was interrupted. Process it first and only then any standalone new file.
  files.insert(files.end(), pending.begin(), pending.end());
  const auto boot = bootIdentity();
  for (const auto &filename : files) {
    const auto file = joined(directory, filename);
    try {
      const bool pendingIntent = filename.starts_with('.');
      struct stat candidate{};
      if (pendingIntent && lstat(file.c_str(), &candidate) && errno == ENOENT) continue;
      const auto validationFilename = pendingIntent ? filename.substr(1, 36) + ".json" : filename;
      const auto journal = validateJournal(readJournal(file), uid, validationFilename);
      const bool previousBoot = !boot.uuid.empty() && !journal.bootUuid.empty() && boot.uuid != journal.bootUuid;
      if (!previousBoot) {
        errno = 0;
        if (kill(journal.owner, 0) == 0 || errno != ESRCH) throw Failure("SNAPSHOT_RECOVERY_REQUIRED", "Journal owner PID is alive or cannot be proven dead", true);
      }
      for (const auto &volume : journal.volumes) {
        Descriptor source(open(volume.root.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)); struct statfs filesystem{};
        if (source.fd < 0 || fstatfs(source.fd, &filesystem) || std::strcmp(filesystem.f_fstypename, "apfs") != 0 || volumeUuid(source.fd) != volume.uuid || fdCanonical(source.fd) != volume.root) throw Failure("SNAPSHOT_RECOVERY_REQUIRED", "Original APFS volume is unavailable or has another UUID", true);
        const auto table = mounts();
        const auto mounted = std::find_if(table.begin(), table.end(), [&](const auto &entry) { return volume.mountPath == entry.f_mntonname; });
        if (mounted != table.end()) {
          directoryComponents(parentPath(volume.mountPath), 0, false);
          struct statfs actual{};
          if (statfs(volume.mountPath.c_str(), &actual) || volume.mountPath != actual.f_mntonname) throw Failure("SNAPSHOT_RECOVERY_REQUIRED", "Abandoned mount is hidden or changed during recovery", true);
          const auto expectedFrom = volume.name + "@" + filesystem.f_mntfromname;
          const bool recordedIdentity = volume.mountAttested && !previousBoot && volume.mountedFrom == actual.f_mntfromname && volume.fsid0 == actual.f_fsid.val[0] && volume.fsid1 == actual.f_fsid.val[1];
          const bool exactSnapshotIdentity = expectedFrom == actual.f_mntfromname && volumeUuid(source.fd) == volume.uuid;
          if (std::strcmp(actual.f_fstypename, "apfs") != 0 || (actual.f_flags & SafeMountFlags) != SafeMountFlags || (!recordedIdentity && !exactSnapshotIdentity)) throw Failure("SNAPSHOT_RECOVERY_REQUIRED", "Workspace contains an unverified or foreign mount", true);
          if (unmount(volume.mountPath.c_str(), 0)) systemFailure("Unmount exact abandoned APFS snapshot");
          for (const auto &entry : mounts()) if (volume.mountPath == entry.f_mntonname) throw Failure("SNAPSHOT_RECOVERY_REQUIRED", "Abandoned APFS mount still exists after unmount", true);
        }
        // An interrupted intent can have created the uniquely named snapshot
        // before its success state was persisted. Only this exact root-owned
        // journal name on the verified volume is eligible for deletion.
        if (snapshotNames(source.fd).contains(volume.name)) {
          if (fs_snapshot_delete(source.fd, volume.name.c_str(), 0)) systemFailure("Delete exact abandoned APFS snapshot");
          if (snapshotNames(source.fd).contains(volume.name)) throw Failure("SNAPSHOT_RECOVERY_REQUIRED", "Abandoned APFS snapshot still exists after deletion", true);
        }
        struct stat info{};
        if (lstat(volume.mountPath.c_str(), &info) == 0) {
          if (!S_ISDIR(info.st_mode) || S_ISLNK(info.st_mode) || info.st_uid != 0 || rmdir(volume.mountPath.c_str())) throw Failure("SNAPSHOT_RECOVERY_REQUIRED", "Abandoned mount directory cannot be removed safely", true);
        } else if (errno != ENOENT) systemFailure("Check abandoned mount directory");
      }
      struct stat info{};
      if (lstat(journal.workspace.c_str(), &info) == 0 && (!S_ISDIR(info.st_mode) || S_ISLNK(info.st_mode) || info.st_uid != 0 || rmdir(journal.workspace.c_str()))) throw Failure("SNAPSHOT_RECOVERY_REQUIRED", "Abandoned workspace has unrecognized contents", true);
      removeOwnedMetadata(joined(directory, "." + journal.session + ".new"));
      removeOwnedMetadata(file); durableDirectory(directory);
    } catch (const std::exception &error) { throw Failure("SNAPSHOT_RECOVERY_REQUIRED", "APFS cleanup must be resolved before another snapshot backup: " + file + "; " + error.what(), true); }
  }
}
class Lease {
  uid_t uid;
  std::string session = newUuid(), userDirectory, workspace;
  std::string journalFolder, journalFile;
  Descriptor recoveryLock;
  BootIdentity boot;
  struct proc_bsdinfo owner{};
  bool journalWritten = false;
  bool released = false;
  std::vector<Volume> volumes;
  std::set<std::string> originalMountRoots;
  NSMutableArray *sourceMappings = [NSMutableArray array];
  struct Alias { std::string root; size_t volume; std::string relative; };
  std::vector<Alias> aliases;
  void initializeRecovery() {
    if (recoveryLock.fd >= 0) return;
    try {
      journalFolder = journalDirectory(uid); recoveryLock = journalLock(journalFolder);
      recoverJournals(uid, journalFolder); boot = bootIdentity();
      if (proc_pidinfo(getpid(), PROC_PIDTBSDINFO, 0, &owner, sizeof(owner)) != static_cast<int>(sizeof(owner)) || owner.pbi_pid != static_cast<uint32_t>(getpid()) || !owner.pbi_start_tvsec) throw Failure("SNAPSHOT_RECOVERY_REQUIRED", "Cannot attest helper process identity for the APFS journal", true);
      journalFile = joined(journalFolder, session + ".json");
    } catch (const Failure &error) {
      if (error.code == "SNAPSHOT_BUSY") throw;
      throw Failure("SNAPSHOT_RECOVERY_REQUIRED", "APFS recovery gate could not be verified: " + journalFolder + "; " + error.what(), true);
    }
  }
  void persistJournal() {
    NSMutableArray *records = [NSMutableArray array];
    for (const auto &volume : volumes) {
      [records addObject:@{@"root":string(volume.root), @"uuid":string(volume.uuid), @"device":string(volume.device), @"name":string(volume.name), @"mountPath":string(volume.mountPath), @"mountAttested":@(volume.mountAttested), @"mountedFrom":string(volume.mountAttested ? volume.mounted.f_mntfromname : ""), @"fsid0":string(std::to_string(volume.mountAttested ? volume.mounted.f_fsid.val[0] : 0)), @"fsid1":string(std::to_string(volume.mountAttested ? volume.mounted.f_fsid.val[1] : 0))}];
    }
    NSDictionary *document = @{@"schemaVersion":@1, @"platform":@"darwin", @"sessionId":string(session), @"clientUid":string(std::to_string(uid)), @"pid":string(std::to_string(getpid())), @"bootUuid":string(boot.uuid), @"bootSeconds":string(boot.seconds), @"bootMicroseconds":string(boot.microseconds), @"processStartSeconds":string(std::to_string(owner.pbi_start_tvsec)), @"processStartMicroseconds":string(std::to_string(owner.pbi_start_tvusec)), @"workspace":string(workspace), @"volumes":records};
    (void)validateJournal(document, uid, session + ".json");
    NSError *error = nil; NSData *bytes = [NSJSONSerialization dataWithJSONObject:document options:0 error:&error];
    if (error || !bytes || bytes.length > FrameLimit) throw Failure("SNAPSHOT_LIMIT", "APFS journal exceeded its bounded metadata size");
    const auto temporary = joined(journalFolder, "." + session + ".new");
    Descriptor output(open(temporary.c_str(), O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW | O_CLOEXEC, 0600));
    if (output.fd < 0) systemFailure("Create APFS journal intent");
    const auto *pointer = static_cast<const uint8_t *>(bytes.bytes); size_t offset = 0;
    while (offset < bytes.length) { const auto count = write(output.fd, pointer + offset, bytes.length - offset); if (count < 0 && errno == EINTR) continue; if (count <= 0) systemFailure("Write APFS journal intent"); offset += static_cast<size_t>(count); }
    if (fsync(output.fd) || fcntl(output.fd, F_FULLFSYNC)) systemFailure("Persist APFS journal intent before snapshot mutation");
    if (journalWritten) {
      const auto prior = validateJournal(readJournal(journalFile), uid, session + ".json");
      if (prior.session != session) throw Failure("SNAPSHOT_RECOVERY_REQUIRED", "APFS journal identity changed while updating", true);
    } else {
      struct stat info{}; if (lstat(journalFile.c_str(), &info) == 0 || errno != ENOENT) throw Failure("SNAPSHOT_RECOVERY_REQUIRED", "Unique APFS journal path already exists", true);
    }
    if (rename(temporary.c_str(), journalFile.c_str())) systemFailure("Commit APFS journal intent");
    durableDirectory(journalFolder); journalWritten = true;
  }
public:
  explicit Lease(uid_t uid_) : uid(uid_) {}
  bool empty() const { return volumes.empty(); }
  NSDictionary *recover() { initializeRecovery(); return @{@"recovered":@YES, @"cleanupVerified":@YES}; }
  NSDictionary *prepare(NSDictionary *request) {
    exactKeys(request, {"id", "command", "sources", "mode"});
    if (text(request[@"mode"], "mode", 32) != "snapshot-only") throw Failure("SNAPSHOT_WRITERS_UNAVAILABLE", "APFS supports filesystem snapshots; VSS writer coordination is available only on Windows");
    id sources = request[@"sources"];
    if (![sources isKindOfClass:[NSArray class]] || [sources count] == 0 || [sources count] > 64) throw Failure("SNAPSHOT_INVALID_REQUEST", "A snapshot lease requires 1 to 64 source roots");
    initializeRecovery();
    std::set<std::string> ids;
    struct Source { std::string id, original, canonical; size_t volume; };
    std::vector<Source> planned;
    for (id item in sources) {
      ensureNotInterrupted(); exactKeys(item, {"id", "path"});
      const auto id_ = text(item[@"id"], "source id", 36), original = text(item[@"path"], "source path");
      if (!uuidText(id_) || !ids.insert(id_).second || !absolutePath(original)) throw Failure("SNAPSHOT_INVALID_REQUEST", "Unsafe or repeated source identity/path");
      // A root link belongs to the filesystem containing its parent, including
      // broken links. Following it here would lose preserve/skip semantics and
      // could accidentally prepare a snapshot of an unrelated target volume.
      const auto metadata = inspectSourceRoot(original);
      const auto &canonical = metadata.canonical;
      const auto &filesystem = metadata.filesystem;
      const auto &info = metadata.info;
      if (!S_ISDIR(info.st_mode) && !S_ISREG(info.st_mode) && !S_ISLNK(info.st_mode)) throw Failure("SNAPSHOT_SOURCE_UNSUPPORTED", "APFS source root must be an ordinary file, directory or symbolic link");
      if (std::strcmp(filesystem.f_fstypename, "apfs") != 0 || !(filesystem.f_flags & MNT_LOCAL) || (filesystem.f_flags & MNT_RDONLY)) throw Failure("SNAPSHOT_FILESYSTEM_UNSUPPORTED", "Source requires a writable local APFS volume; network filesystems and the sealed system snapshot are unsupported");
      const std::string mountedRoot(filesystem.f_mntonname);
      if (!absolutePath(mountedRoot)) throw Failure("SNAPSHOT_PATH_UNAVAILABLE", "APFS volume has no local mount path");
      Descriptor volumeDirectory(open(mountedRoot.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
      if (volumeDirectory.fd < 0) systemFailure("Open APFS source volume");
      const auto root = fdCanonical(volumeDirectory.fd);
      if (!absolutePath(root) || !inside(root, canonical)) throw Failure("SNAPSHOT_PATH_UNAVAILABLE", "APFS source volume path could not be resolved without firmlinks");
      auto position = std::find_if(volumes.begin(), volumes.end(), [&](const Volume &volume) { return volume.root == root; });
      size_t index;
      if (position == volumes.end()) {
        Volume volume; volume.root = root; volume.original = filesystem; volume.device = filesystem.f_mntfromname;
        volume.directory = std::move(volumeDirectory);
        volume.uuid = volumeUuid(volume.directory.fd); volume.caseSensitive = volumeCaseSensitive(volume.directory.fd); volume.name = "delta-" + session + "-" + std::to_string(volumes.size());
        verifyOriginal(volume); if (snapshotNames(volume.directory.fd).contains(volume.name)) throw Failure("SNAPSHOT_IDENTITY_ERROR", "Generated APFS snapshot name already exists");
        index = volumes.size(); volumes.push_back(std::move(volume));
      } else index = static_cast<size_t>(position - volumes.begin());
      if (mountedRoot != root) aliases.push_back({mountedRoot, index, ""});
      planned.push_back({id_, original, canonical, index});
    }
    const auto beforeMounts = mounts();
    for (const auto &mount : beforeMounts) originalMountRoots.insert(mount.f_mntonname);
    for (auto &volume : volumes) {
      for (const auto &mount : beforeMounts) {
        const std::string nested(mount.f_mntonname);
        if (nested != volume.root && inside(volume.root, nested)) volume.excluded.insert(nested);
      }
    }
    // Every selected nested mounted APFS volume gets its own mapping. Every
    // remaining nested mount stays an explicit scanner boundary, never an
    // apparently successful empty stub from the parent snapshot.
    for (auto &volume : volumes) for (const auto &other : volumes) if (&volume != &other) volume.excluded.erase(other.root);
    directoryComponents(parentPath(RuntimeRoot), 0, false);
    fixedDirectory(RuntimeRoot, 0755);
    userDirectory = joined(RuntimeRoot, std::to_string(uid)); fixedDirectory(userDirectory, 0711);
    workspace = joined(userDirectory, session);
    if (mkdir(workspace.c_str(), 0700)) systemFailure("Create unique snapshot session workspace");
    if (chmod(workspace.c_str(), 0711)) systemFailure("Permit ordinary-worker traversal of the snapshot workspace");
    for (size_t index = 0; index < volumes.size(); ++index) {
      auto &volume = volumes[index];
      volume.mountPath = joined(workspace, "volume-" + std::to_string(index));
      if (mkdir(volume.mountPath.c_str(), 0700)) systemFailure("Create unique snapshot mount directory");
    }
    persistJournal();
    for (size_t index = 0; index < volumes.size(); ++index) {
      auto &volume = volumes[index]; ensureNotInterrupted(); verifyOriginal(volume);
      // Durable intent scopes cleanup to this exact random name, including a
      // kernel operation whose result was interrupted before success recording.
      if (fs_snapshot_create(volume.directory.fd, volume.name.c_str(), 0)) systemFailure("Create APFS snapshot");
      volume.created = true;
      persistJournal();
      if (!snapshotNames(volume.directory.fd).contains(volume.name)) throw Failure("SNAPSHOT_IDENTITY_ERROR", "Created APFS snapshot was not found by exact owned name");
      ensureNotInterrupted();
      const uint32_t flags = SNAPSHOT_MNT_RESERVED1 | SNAPSHOT_MNT_NOSUID | SNAPSHOT_MNT_NODEV | SNAPSHOT_MNT_NOEXEC | SNAPSHOT_MNT_DONTBROWSE | SNAPSHOT_MNT_NOFOLLOW;
      if (fs_snapshot_mount(volume.directory.fd, volume.mountPath.c_str(), volume.name.c_str(), flags)) systemFailure("Mount APFS snapshot read-only");
      volume.mountedOwned = true;
      if (statfs(volume.mountPath.c_str(), &volume.mounted) || std::strcmp(volume.mounted.f_mntonname, volume.mountPath.c_str()) != 0 || (volume.mounted.f_flags & SafeMountFlags) != SafeMountFlags || std::strcmp(volume.mounted.f_fstypename, "apfs") != 0) throw Failure("SNAPSHOT_IDENTITY_ERROR", "APFS snapshot did not produce the expected read-only protected mount");
      volume.mountAttested = true; persistJournal();
    }
    const auto afterMounts = mounts();
    for (const auto &before : beforeMounts) {
      const auto found = std::find_if(afterMounts.begin(), afterMounts.end(), [&](const auto &after) { return sameMount(before, after); });
      if (found == afterMounts.end()) throw Failure("SNAPSHOT_MOUNT_ERROR", "Live mount topology changed while preparing APFS snapshots");
    }
    for (const auto &source : planned) {
      const auto &volume = volumes[source.volume];
      [sourceMappings addObject:@{@"id":string(source.id), @"originalPath":string(source.original), @"canonicalPath":string(source.canonical), @"snapshotPath":string(joined(volume.mountPath, suffix(volume.root, source.canonical)))}];
      // Ordinary caller aliases are intentionally not global mappings: an
      // overlapping source must still see a real symlink and preserve/skip it.
    }
    // Apple's firmlink table is root-controlled. Map the selected Data volume
    // aliases as a whole so absolute links in a snapshot can resolve /Users or
    // /Applications without falling through to the live filesystem.
    struct stat firmlinksInfo{};
    if (lstat("/usr/share/firmlinks", &firmlinksInfo) == 0) {
      if (!S_ISREG(firmlinksInfo.st_mode) || S_ISLNK(firmlinksInfo.st_mode) || firmlinksInfo.st_uid != 0 || (firmlinksInfo.st_mode & 0022) || firmlinksInfo.st_size > 65536) throw Failure("SNAPSHOT_PATH_UNAVAILABLE", "System firmlink table has unsafe identity or size");
      std::ifstream firmlinks("/usr/share/firmlinks"); std::string line; size_t lines = 0;
      while (std::getline(firmlinks, line)) {
        if (++lines > 256 || line.size() > PATH_MAX * 2) throw Failure("SNAPSHOT_LIMIT", "System firmlink table exceeded its bounded limit");
        const auto separator = line.find_first_of("\t "); if (line.empty() || line[0] == '#' || separator == std::string::npos) continue;
        const auto next = line.find_first_not_of("\t ", separator); if (next == std::string::npos) continue;
        const auto logical = line.substr(0, separator); auto physical = line.substr(next); const auto whitespace = physical.find_first_of("\t \r"); if (whitespace != std::string::npos) physical.resize(whitespace);
        const auto root = logical.starts_with('/') ? logical : "/" + logical;
        if (!absolutePath(root) || root == "/" || physical.empty()) throw Failure("SNAPSHOT_PATH_UNAVAILABLE", "Unsafe entry in system firmlink table");
        for (size_t index = 0; index < volumes.size(); ++index) if (volumes[index].root == "/System/Volumes/Data") {
          const auto canonical = physical.starts_with('/') ? physical : joined(volumes[index].root, physical);
          if (!absolutePath(canonical) || !inside(volumes[index].root, canonical)) throw Failure("SNAPSHOT_PATH_UNAVAILABLE", "System firmlink escapes the selected Data volume");
          aliases.push_back({root, index, suffix(volumes[index].root, canonical)});
        }
      }
      if (firmlinks.bad()) throw Failure("SNAPSHOT_PATH_UNAVAILABLE", "System firmlink table could not be read completely");
    } else if (errno != ENOENT) systemFailure("Check system firmlink table");
    return value();
  }
  NSDictionary *value() const {
    NSMutableArray *mappings = [NSMutableArray array];
    auto append = [&](const Volume &volume, const std::string &root, const std::string &snapshot, const std::string &relative) {
      NSMutableArray *excluded = [NSMutableArray array]; std::set<std::string> exclusions;
      const auto physical = joined(volume.root, relative);
      for (const auto &entry : volume.excluded) if (inside(physical, entry)) exclusions.insert(joined(root, suffix(physical, entry)));
      for (const auto &entry : originalMountRoots) {
        if (entry != root && inside(root, entry) && std::none_of(volumes.begin(), volumes.end(), [&](const auto &selected) { return selected.root == entry; })) exclusions.insert(entry);
        // A mount table path can itself use /Users rather than the physical
        // Data path. Project every trusted firmlink alias into the physical
        // volume before deriving this mapping's explicit boundary.
        for (const auto &alias : aliases) if (volumes[alias.volume].uuid == volume.uuid && entry != alias.root && inside(alias.root, entry)) {
          const auto canonical = joined(joined(volume.root, alias.relative), suffix(alias.root, entry));
          if (inside(physical, canonical) && std::none_of(volumes.begin(), volumes.end(), [&](const auto &selected) { return selected.root == canonical; })) exclusions.insert(joined(root, suffix(physical, canonical)));
        }
      }
      for (const auto &entry : exclusions) [excluded addObject:string(entry)];
      struct stat info{}; if (lstat(volume.mountPath.c_str(), &info)) systemFailure("Read snapshot mount device identity");
      [mappings addObject:@{@"root":string(root), @"snapshotPath":string(snapshot), @"identity":string(volume.uuid + ":" + volume.name), @"device":string(std::to_string(info.st_dev)), @"excludedRoots":excluded, @"caseSensitive":@(volume.caseSensitive)}];
    };
    for (const auto &volume : volumes) append(volume, volume.root, volume.mountPath, "");
    std::set<std::string> roots; for (const auto &volume : volumes) roots.insert(volume.root);
    for (const auto &alias : aliases) if (roots.insert(alias.root).second) append(volumes[alias.volume], alias.root, joined(volumes[alias.volume].mountPath, alias.relative), alias.relative);
    if (mappings.count > 256) throw Failure("SNAPSHOT_LIMIT", "APFS volume and firmlink mappings exceeded the bounded lease limit");
    return @{@"schemaVersion":@1, @"platform":@"darwin", @"backend":@"apfs", @"consistentSnapshot":@YES, @"atomicSet":@(volumes.size() == 1), @"sessionId":string(session), @"clientUid":@(uid), @"helperElevated":@YES, @"readOnly":@YES, @"consistency":@"filesystem", @"mappings":mappings, @"sourceMappings":sourceMappings};
  }
  void health() const {
    if (released || empty()) throw Failure("SNAPSHOT_NO_LEASE", "There is no active APFS snapshot lease");
    for (const auto &volume : volumes) { verifyOriginal(volume); verifyMounted(volume); if (!snapshotNames(volume.directory.fd).contains(volume.name)) throw Failure("SNAPSHOT_IDENTITY_ERROR", "Owned APFS snapshot disappeared"); }
  }
  bool cleanup() noexcept {
    if (released) return true;
    bool verified = true;
    for (auto position = volumes.rbegin(); position != volumes.rend(); ++position) {
      auto &volume = *position;
      try {
        verifyOriginal(volume);
        if (!volume.mountPath.empty()) {
          const auto table = mounts();
          const auto present = std::find_if(table.begin(), table.end(), [&](const auto &entry) { return volume.mountPath == entry.f_mntonname; });
          if (present == table.end()) volume.mountedOwned = false;
          else if (!volume.mountedOwned) {
            struct statfs actual{};
            if (!journalWritten || statfs(volume.mountPath.c_str(), &actual) || volume.mountPath != actual.f_mntonname || std::strcmp(actual.f_fstypename, "apfs") != 0 || (actual.f_flags & SafeMountFlags) != SafeMountFlags || volume.name + "@" + volume.original.f_mntfromname != actual.f_mntfromname) throw Failure("SNAPSHOT_CLEANUP_UNVERIFIED", "Snapshot workspace contains a foreign or unverified mount");
            volume.mounted = actual; volume.mountedOwned = true;
          }
        }
        if (volume.mountedOwned) {
          verifyMounted(volume);
          // Force/lazy unmount would conceal ordinary-worker use or a foreign
          // replacement mount. An EBUSY response deliberately fails cleanup.
          if (unmount(volume.mountPath.c_str(), 0)) systemFailure("Unmount owned APFS snapshot");
          volume.mountedOwned = false;
          struct statfs current{};
          if (statfs(volume.mountPath.c_str(), &current) || sameMount(volume.mounted, current)) throw Failure("SNAPSHOT_CLEANUP_UNVERIFIED", "Owned snapshot mount removal could not be verified");
        }
        if (volume.created || journalWritten) {
          if (snapshotNames(volume.directory.fd).contains(volume.name) && fs_snapshot_delete(volume.directory.fd, volume.name.c_str(), 0)) systemFailure("Delete owned APFS snapshot");
          if (snapshotNames(volume.directory.fd).contains(volume.name)) throw Failure("SNAPSHOT_CLEANUP_UNVERIFIED", "Owned APFS snapshot still exists after deletion");
          volume.created = false;
        }
        if (!volume.mountPath.empty()) {
          struct stat info{};
          if (lstat(volume.mountPath.c_str(), &info) == 0) {
            if (!S_ISDIR(info.st_mode) || S_ISLNK(info.st_mode) || info.st_uid != 0 || rmdir(volume.mountPath.c_str())) throw Failure("SNAPSHOT_CLEANUP_UNVERIFIED", "Owned mount directory could not be removed safely");
          } else if (errno != ENOENT) systemFailure("Check owned mount directory");
        }
      } catch (const std::exception &error) { verified = false; std::cerr << "APFS cleanup could not be verified: " << error.what() << '\n'; }
    }
    if (verified && !workspace.empty() && rmdir(workspace.c_str()) && errno != ENOENT) verified = false;
    if (verified && !journalFile.empty()) {
      try {
        removeOwnedMetadata(joined(journalFolder, "." + session + ".new")); removeOwnedMetadata(journalFile); durableDirectory(journalFolder);
        journalWritten = false;
      } catch (const std::exception &error) { verified = false; std::cerr << "APFS clean lease journal could not be removed: " << error.what() << '\n'; }
    }
    released = verified; return verified;
  }
};
int selfTest() {
  size_t passed = 0;
  auto require = [&](bool value) { if (!value) throw std::runtime_error("APFS deterministic self-test failed"); ++passed; };
  require(uuidText("3817778f-996a-4346-af0d-c537f10d82cb") && !uuidText("../unsafe"));
  require(absolutePath("/System/Volumes/Data/Users/a") && !absolutePath("/Users/../root") && !absolutePath("/Users//a"));
  require(inside("/Users/a", "/Users/a/file") && !inside("/Users/a", "/Users/another"));
  require(hexNonce(std::string(64, 'a')) && !hexNonce(std::string(64, 'z')));
  bool rejected = false; try { (void)parseFrame("[]"); } catch (const Failure &) { rejected = true; } require(rejected);
  rejected = false; try { (void)text(@"bad\0path", "test"); } catch (const Failure &) { rejected = true; } require(rejected);
  rejected = false; try { exactKeys(@{@"command":@"release", @"file":@"/etc/master.passwd"}, {"command"}); } catch (const Failure &) { rejected = true; } require(rejected);
  const std::string session = "3817778f-996a-4346-af0d-c537f10d82cb", filename = session + ".json";
  const auto workspace = joined(joined(RuntimeRoot, "501"), session);
  NSMutableDictionary *journal = [@{@"schemaVersion":@1, @"platform":@"darwin", @"sessionId":string(session), @"clientUid":@"501", @"pid":@"4242", @"bootUuid":@"", @"bootSeconds":@"1", @"bootMicroseconds":@"0", @"processStartSeconds":@"2", @"processStartMicroseconds":@"0", @"workspace":string(workspace), @"volumes":@[@{@"root":@"/System/Volumes/Data", @"uuid":@"b9c309b6-9c5e-4c06-ac68-b7dcf9410558", @"device":@"/dev/disk3s5", @"name":string("delta-" + session + "-0"), @"mountPath":string(joined(workspace, "volume-0")), @"mountAttested":@NO, @"mountedFrom":@"", @"fsid0":@"0", @"fsid1":@"0"}]} mutableCopy];
  require(validateJournal(journal, 501, filename).volumes.size() == 1);
  journal[@"workspace"] = @"/private/tmp/foreign";
  rejected = false; try { (void)validateJournal(journal, 501, filename); } catch (const Failure &) { rejected = true; } require(rejected); journal[@"workspace"] = string(workspace);
  NSMutableDictionary *volume = [journal[@"volumes"][0] mutableCopy]; volume[@"name"] = @"com.apple.TimeMachine.foreign.local"; journal[@"volumes"] = @[volume];
  rejected = false; try { (void)validateJournal(journal, 501, filename); } catch (const Failure &) { rejected = true; } require(rejected); volume[@"name"] = string("delta-" + session + "-0");
  rejected = false; try { (void)validateJournal(journal, 502, filename); } catch (const Failure &) { rejected = true; } require(rejected);
  rejected = false; try { (void)unsignedId("0"); } catch (const Failure &) { rejected = true; }
  require(rejected && unsignedId("501") == 501 && unsignedId("0", true) == 0);
  {
    char temporary[] = "/private/tmp/delta-apfs-selftest-XXXXXX";
    if (!mkdtemp(temporary)) systemFailure("Create unprivileged metadata self-test fixture");
    struct Fixture {
      std::string root;
      ~Fixture() { struct stat info{}; if (lstat(root.c_str(), &info) || !S_ISDIR(info.st_mode) || info.st_uid != geteuid()) return; for (const auto *name : {"broken", "directory-link", "file"}) unlink(joined(root, name).c_str()); rmdir(joined(root, "directory").c_str()); rmdir(root.c_str()); }
    } fixture{temporary};
    if (mkdir(joined(fixture.root, "directory").c_str(), 0700) || symlink("missing", joined(fixture.root, "broken").c_str()) || symlink("directory", joined(fixture.root, "directory-link").c_str())) systemFailure("Create source-link metadata self-test fixtures");
    Descriptor file(open(joined(fixture.root, "file").c_str(), O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW | O_CLOEXEC, 0600)); if (file.fd < 0) systemFailure("Create source-file metadata self-test fixture");
    const auto parent = inspectSourceRoot(fixture.root);
    const auto broken = inspectSourceRoot(joined(fixture.root, "broken"));
    require(S_ISLNK(broken.info.st_mode) && broken.canonical == joined(parent.canonical, "broken") && std::memcmp(&broken.filesystem.f_fsid, &parent.filesystem.f_fsid, sizeof(parent.filesystem.f_fsid)) == 0);
    const auto link = inspectSourceRoot(joined(fixture.root, "directory-link"));
    const auto regular = inspectSourceRoot(joined(fixture.root, "file"));
    const auto directory = inspectSourceRoot(joined(fixture.root, "directory"));
    require(S_ISLNK(link.info.st_mode) && !S_ISDIR(link.info.st_mode) && S_ISREG(regular.info.st_mode) && S_ISDIR(directory.info.st_mode));
  }
  std::cout << "{\"status\":\"passed\",\"selfTestsPassed\":" << passed << ",\"createdSnapshot\":false,\"platformQualification\":\"unverified\"}\n";
  return 0;
}
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    umask(0077); signal(SIGTERM, stopSignal); signal(SIGINT, stopSignal); signal(SIGHUP, stopSignal); signal(SIGPIPE, SIG_IGN);
    try {
      if (argc == 2 && std::string(argv[1]) == "--self-test") return selfTest();
      if (argc != 9) throw Failure("SNAPSHOT_INVALID_REQUEST", "Expected --socket PATH --nonce HEX --uid ID --gid ID");
      std::map<std::string, std::string> arguments;
      for (int index = 1; index < argc; index += 2) if (!arguments.emplace(argv[index], argv[index + 1]).second) throw Failure("SNAPSHOT_INVALID_REQUEST", "Repeated helper argument");
      if (!arguments.contains("--socket") || !arguments.contains("--nonce") || !arguments.contains("--uid") || !arguments.contains("--gid") || !hexNonce(arguments["--nonce"])) throw Failure("SNAPSHOT_INVALID_REQUEST", "Invalid helper arguments");
      const auto uid = static_cast<uid_t>(unsignedId(arguments["--uid"])), gid = static_cast<gid_t>(unsignedId(arguments["--gid"], true));
      if (geteuid() != 0 || getuid() != 0) throw Failure("SNAPSHOT_ADMIN_REQUIRED", "APFS snapshot helper must be started through administrator authorization");
      auto connection = connectSocket(arguments["--socket"], uid, gid);
      sendJson(connection.fd, @{@"type":@"hello", @"protocol":@1, @"nonce":string(arguments["--nonce"]), @"platform":@"darwin", @"elevated":@YES});
      Lease lease(uid); std::string pending; std::set<std::string> ids; std::deque<std::string> recentIds; bool prepared = false, cancelled = false, recoveryUnverified = false;
      try {
        for (;;) {
          @autoreleasepool {
            const auto frame = readFrame(connection.fd, pending); NSDictionary *request = parseFrame(frame);
            const auto command = text(request[@"command"], "command", 32);
            if (command == "cancel") {
              // Cancellation is a one-way request without an RPC identity.
              // A kernel operation already in progress settles first; this
              // event loop must never interleave a second RPC response.
              exactKeys(request, {"command"}); cancelled = true; (void)lease.cleanup(); continue;
            }
            const auto id_ = text(request[@"id"], "request id", 36);
            if (!uuidText(id_) || !ids.insert(id_).second) throw Failure("SNAPSHOT_INVALID_REQUEST", "Invalid or recently repeated request identity");
            recentIds.push_back(id_); if (recentIds.size() > 1024) { ids.erase(recentIds.front()); recentIds.pop_front(); }
            try {
              if (command == "prepare") {
                if (cancelled) throw Failure("SNAPSHOT_CANCELLED", "Snapshot client cancelled before lease preparation");
                if (prepared) throw Failure("SNAPSHOT_INVALID_REQUEST", "Only one APFS lease is allowed per helper");
                prepared = true; NSDictionary *value = lease.prepare(request); sendJson(connection.fd, @{@"id":string(id_), @"ok":@YES, @"value":value});
              } else if (command == "recover") {
                exactKeys(request, {"id", "command"}); if (prepared) throw Failure("SNAPSHOT_INVALID_REQUEST", "Recovery cannot run while an APFS lease is active");
                sendJson(connection.fd, @{@"id":string(id_), @"ok":@YES, @"value":lease.recover()});
              } else if (command == "ping" || command == "verify") {
                exactKeys(request, {"id", "command"}); lease.health(); sendJson(connection.fd, @{@"id":string(id_), @"ok":@YES, @"value":@{@"healthy":@YES}});
              } else if (command == "release") {
                exactKeys(request, {"id", "command"}); const auto clean = lease.cleanup() && !recoveryUnverified;
                if (!clean) throw Failure("SNAPSHOT_CLEANUP_UNVERIFIED", "APFS snapshot cleanup could not be verified; no live fallback is permitted", true);
                sendJson(connection.fd, @{@"id":string(id_), @"ok":@YES, @"value":@{@"cleanupVerified":@YES, @"ownedSnapshotsDeleted":@YES}}); return 0;
              } else throw Failure("SNAPSHOT_INVALID_REQUEST", "Unknown snapshot command");
            } catch (const Failure &error) {
              prepared = true;
              recoveryUnverified = recoveryUnverified || error.cleanupUnknown;
              const auto clean = lease.cleanup() && !recoveryUnverified;
              sendJson(connection.fd, @{@"id":string(id_), @"ok":@NO, @"error":@{@"code":string(error.code), @"message":string(error.what()), @"cleanupVerified":@(clean)}});
              if (command == "release") return clean ? 1 : 2;
              // The controller settles every failed RPC by explicitly releasing
              // the helper. Keep a clean failure (including entitlement denial)
              // connected until that release has received its own confirmation.
            }
          }
        }
      } catch (...) { if (!lease.cleanup()) { std::cerr << "APFS lease ended with cleanup unverified\n"; return 2; } throw; }
    } catch (const std::exception &error) { std::cerr << "Delta Backupper APFS helper: " << error.what() << '\n'; return 1; }
  }
}
