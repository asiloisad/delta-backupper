// Delta Backupper native snapshot lease. This helper never reads source files,
// changes their ACLs, exposes a privileged read API or mounts writable copies.
// Shared bounded VSS async and cleanup primitives live beside the lease helper.
#define wmain deltaQualifiedVssProbeMain
#include "vss-support.cpp"
#undef wmain
#include <aclapi.h>
#include <sddl.h>
#include <shellapi.h>
#include <array>
#include <algorithm>
#include <cstdint>
#include <cstring>
#include <thread>
#pragma comment(lib, "User32.lib")
#pragma comment(lib, "Shell32.lib")

namespace lease {
constexpr DWORD limit = 65536;
constexpr DWORD pipeRights = FILE_READ_DATA | FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE;
struct Handle {
    HANDLE value = INVALID_HANDLE_VALUE;
    Handle() = default; explicit Handle(HANDLE h) : value(h) {}
    Handle(const Handle&) = delete; Handle& operator=(const Handle&) = delete;
    Handle(Handle&& other) noexcept : value(other.release()) {}
    Handle& operator=(Handle&& other) noexcept { reset(other.release()); return *this; }
    ~Handle() { reset(); }
    HANDLE release() { HANDLE h = value; value = INVALID_HANDLE_VALUE; return h; }
    void reset(HANDLE h = INVALID_HANDLE_VALUE) { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); value = h; }
    explicit operator bool() const { return value && value != INVALID_HANDLE_VALUE; }
};
[[noreturn]] void error(const std::string& message, DWORD code = GetLastError()) { throw Failure{message, HRESULT_FROM_WIN32(code ? code : ERROR_INVALID_DATA)}; }
std::vector<BYTE> information(HANDLE token, TOKEN_INFORMATION_CLASS kind) {
    DWORD size = 0; GetTokenInformation(token, kind, nullptr, 0, &size); if (!size) error("token information size");
    std::vector<BYTE> result(size); if (!GetTokenInformation(token, kind, result.data(), size, &size)) error("token information"); return result;
}
Handle token(HANDLE process) { HANDLE result = nullptr; if (!OpenProcessToken(process, TOKEN_QUERY, &result)) error("OpenProcessToken(identity)"); return Handle(result); }
std::vector<BYTE> copySid(PSID sid) { if (!IsValidSid(sid)) error("invalid SID", ERROR_INVALID_SID); std::vector<BYTE> value(GetLengthSid(sid)); if (!CopySid(static_cast<DWORD>(value.size()), value.data(), sid)) error("CopySid"); return value; }
struct Identity { std::vector<BYTE> user, logon; DWORD session = 0, integrity = 0; bool elevated = false; };
Identity identity(HANDLE process) {
    auto access = token(process); Identity result; auto user = information(access.value, TokenUser); result.user = copySid(reinterpret_cast<TOKEN_USER*>(user.data())->User.Sid);
    auto groups = information(access.value, TokenGroups); const auto list = reinterpret_cast<TOKEN_GROUPS*>(groups.data());
    for (DWORD i = 0; i < list->GroupCount; ++i) if ((list->Groups[i].Attributes & SE_GROUP_LOGON_ID) == SE_GROUP_LOGON_ID) result.logon = copySid(list->Groups[i].Sid);
    if (result.logon.empty()) error("token logon SID missing", ERROR_NO_SUCH_LOGON_SESSION);
    auto session = information(access.value, TokenSessionId); result.session = *reinterpret_cast<DWORD*>(session.data());
    auto level = information(access.value, TokenIntegrityLevel); const PSID sid = reinterpret_cast<TOKEN_MANDATORY_LABEL*>(level.data())->Label.Sid;
    result.integrity = *GetSidSubAuthority(sid, *GetSidSubAuthorityCount(sid) - 1);
    auto elevatedInfo = information(access.value, TokenElevation); result.elevated = reinterpret_cast<TOKEN_ELEVATION*>(elevatedInfo.data())->TokenIsElevated != 0; return result;
}
bool same(const Identity& first, const Identity& second) {
    return first.session == second.session && EqualSid(const_cast<BYTE*>(first.user.data()), const_cast<BYTE*>(second.user.data())) && EqualSid(const_cast<BYTE*>(first.logon.data()), const_cast<BYTE*>(second.logon.data()));
}
std::wstring wide(const std::vector<BYTE>& value) {
    if (value.empty() || value.size() > limit) error("invalid UTF-8 string size", ERROR_INVALID_DATA);
    const int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, reinterpret_cast<const char*>(value.data()), static_cast<int>(value.size()), nullptr, 0);
    if (!size) error("invalid UTF-8 string"); std::wstring result(size, L'\0');
    if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, reinterpret_cast<const char*>(value.data()), static_cast<int>(value.size()), result.data(), size) || result.find(L'\0') != std::wstring::npos) error("invalid UTF-8 string"); return result;
}
uint32_t get32(const BYTE* data) { return data[0] | (static_cast<uint32_t>(data[1]) << 8) | (static_cast<uint32_t>(data[2]) << 16) | (static_cast<uint32_t>(data[3]) << 24); }
void put32(BYTE* data, uint32_t value) { for (size_t i = 0; i < 4; ++i) data[i] = static_cast<BYTE>(value >> (i * 8)); }
struct Frame { BYTE opcode = 0; std::vector<BYTE> payload; };
DWORD transfer(HANDLE handle, BYTE* data, DWORD size, bool write, bool overlapped, DWORD timeout = 120000) {
    Handle event; OVERLAPPED operation{}; DWORD done = 0;
    if (overlapped) { event.reset(CreateEventW(nullptr, TRUE, FALSE, nullptr)); if (!event) error("create IPC event"); operation.hEvent = event.value; }
    BOOL ok = write ? WriteFile(handle, data, size, &done, overlapped ? &operation : nullptr) : ReadFile(handle, data, size, &done, overlapped ? &operation : nullptr);
    if (ok) return done; DWORD code = GetLastError();
    if (code == ERROR_BROKEN_PIPE || code == ERROR_PIPE_NOT_CONNECTED || code == ERROR_HANDLE_EOF) return 0;
    if (!overlapped || code != ERROR_IO_PENDING) error("IPC transfer", code);
    if (WaitForSingleObject(event.value, timeout) != WAIT_OBJECT_0) {
        CancelIoEx(handle, &operation); if (WaitForSingleObject(event.value, 5000) != WAIT_OBJECT_0) ExitProcess(1);
        error("snapshot lease channel timed out", ERROR_TIMEOUT);
    }
    if (!GetOverlappedResult(handle, &operation, &done, FALSE)) { code = GetLastError(); if (code == ERROR_BROKEN_PIPE || code == ERROR_PIPE_NOT_CONNECTED) return 0; error("IPC completion", code); }
    return done;
}
bool exact(HANDLE handle, BYTE* data, DWORD size, bool write, bool overlapped) {
    DWORD offset = 0;
    while (offset < size) { const DWORD count = transfer(handle, data + offset, size - offset, write, overlapped); if (!count) { if (!offset && !write) return false; error("truncated IPC frame", ERROR_BROKEN_PIPE); } offset += count; } return true;
}
bool receive(HANDLE handle, Frame& frame, bool overlapped = true) {
    std::array<BYTE, 12> header{}; if (!exact(handle, header.data(), static_cast<DWORD>(header.size()), false, overlapped)) return false;
    if (memcmp(header.data(), "DV02", 4) || header[5] || header[6] || header[7] || get32(header.data() + 8) > limit) error("invalid snapshot lease frame", ERROR_INVALID_DATA);
    frame.opcode = header[4]; frame.payload.resize(get32(header.data() + 8));
    if (!frame.payload.empty() && !exact(handle, frame.payload.data(), static_cast<DWORD>(frame.payload.size()), false, overlapped)) error("truncated snapshot lease payload", ERROR_BROKEN_PIPE); return true;
}
void send(HANDLE handle, BYTE opcode, const std::vector<BYTE>& payload = {}, bool overlapped = true) {
    if (payload.size() > limit) error("snapshot lease response exceeds limit", ERROR_INVALID_DATA);
    std::array<BYTE, 12> header{}; memcpy(header.data(), "DV02", 4); header[4] = opcode; put32(header.data() + 8, static_cast<DWORD>(payload.size()));
    exact(handle, header.data(), static_cast<DWORD>(header.size()), true, overlapped);
    if (!payload.empty()) exact(handle, const_cast<BYTE*>(payload.data()), static_cast<DWORD>(payload.size()), true, overlapped);
}
void textFrame(HANDLE handle, BYTE opcode, const std::string& value, bool overlapped = true) { send(handle, opcode, std::vector<BYTE>(value.begin(), value.end()), overlapped); }
struct Cursor {
    const std::vector<BYTE>& bytes; size_t offset = 0;
    uint32_t number() { if (bytes.size() - offset < 4) error("short lease request", ERROR_INVALID_DATA); const auto value = get32(bytes.data() + offset); offset += 4; return value; }
    std::wstring string() { const auto length = number(); if (!length || length > 32768 || bytes.size() - offset < length) error("invalid lease string length", ERROR_INVALID_DATA); const std::vector<BYTE> value(bytes.begin() + offset, bytes.begin() + offset + length); offset += length; return wide(value); }
    void end() { if (offset != bytes.size()) error("trailing lease request data", ERROR_INVALID_DATA); }
};
void appendNumber(std::vector<BYTE>& output, uint32_t value) { const size_t start = output.size(); output.resize(start + 4); put32(output.data() + start, value); }
void appendString(std::vector<BYTE>& output, const std::wstring& value) { const std::string bytes = utf8(value); appendNumber(output, static_cast<uint32_t>(bytes.size())); output.insert(output.end(), bytes.begin(), bytes.end()); if (output.size() > limit) error("lease request exceeds limit", ERROR_INVALID_DATA); }
bool volumeName(const std::wstring& value) {
    if (value.size() != 49 || _wcsnicmp(value.c_str(), L"\\\\?\\Volume", 10) || value.back() != L'\\') return false;
    GUID id{}; const std::wstring part = value.substr(10, 38); return SUCCEEDED(CLSIDFromString(part.c_str(), &id)) && _wcsicmp(guidText(id).c_str(), part.c_str()) == 0;
}
bool snapshotDevice(const std::wstring& value) {
    const std::wstring prefix = L"\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy";
    if (value.size() <= prefix.size() || _wcsnicmp(value.c_str(), prefix.c_str(), prefix.size())) return false;
    for (size_t i = prefix.size(); i < value.size(); ++i) if (value[i] < L'0' || value[i] > L'9') return false; return true;
}
struct Volume { std::wstring root, guid, device; VSS_ID snapshot = GUID_NULL; };
std::vector<Volume> sourceVolumes(const std::vector<BYTE>& payload, bool& writers) {
    Cursor cursor{payload}; const uint32_t mode = cursor.number(); if (mode > 1) error("unknown VSS context", ERROR_INVALID_DATA); writers = mode == 1;
    const auto count = cursor.number(); if (!count || count > 64) error("invalid source count", ERROR_INVALID_DATA); std::vector<Volume> result;
    for (uint32_t i = 0; i < count; ++i) {
        const std::wstring source = cursor.string();
        if (source.size() < 3 || source[1] != L':' || source[2] != L'\\' || source.find(L':', 2) != std::wstring::npos) error("VSS sources must be local drive paths", ERROR_INVALID_NAME);
        wchar_t root[32768]{}, guid[128]{};
        if (!GetVolumePathNameW(source.c_str(), root, 32768) || !GetVolumeNameForVolumeMountPointW(root, guid, 128)) error("resolve ordinary source volume");
        if (!volumeName(guid)) error("invalid resolved volume GUID", ERROR_INVALID_DATA);
        if (std::none_of(result.begin(), result.end(), [&](const Volume& item) { return _wcsicmp(item.root.c_str(), root) == 0; })) result.push_back(Volume{root, guid, L"", GUID_NULL});
    }
    cursor.end(); return result;
}
Handle privateServer(const std::wstring& name, const Identity& owner) {
    EXPLICIT_ACCESSW access{}; access.grfAccessPermissions = pipeRights; access.grfAccessMode = SET_ACCESS; access.grfInheritance = NO_INHERITANCE;
    access.Trustee.TrusteeForm = TRUSTEE_IS_SID; access.Trustee.ptstrName = reinterpret_cast<LPWSTR>(const_cast<BYTE*>(owner.logon.data()));
    PACL acl = nullptr; const DWORD status = SetEntriesInAclW(1, &access, nullptr, &acl); if (status != ERROR_SUCCESS) error("private pipe ACL", status);
    SECURITY_DESCRIPTOR descriptor{}; PSECURITY_DESCRIPTOR label = nullptr;
    if (!InitializeSecurityDescriptor(&descriptor, SECURITY_DESCRIPTOR_REVISION) || !SetSecurityDescriptorDacl(&descriptor, TRUE, acl, FALSE) ||
        !ConvertStringSecurityDescriptorToSecurityDescriptorW(L"S:(ML;;NW;;;ME)", SDDL_REVISION_1, &label, nullptr)) { const DWORD code = GetLastError(); LocalFree(acl); error("pipe security descriptor", code); }
    PACL sacl = nullptr; BOOL present = FALSE, defaulted = FALSE;
    const bool valid = GetSecurityDescriptorSacl(label, &present, &sacl, &defaulted) && present && SetSecurityDescriptorSacl(&descriptor, TRUE, sacl, FALSE);
    if (!valid) { const DWORD code = GetLastError(); LocalFree(label); LocalFree(acl); error("pipe mandatory label", code); }
    SECURITY_ATTRIBUTES attributes{sizeof(attributes), &descriptor, FALSE};
    Handle pipe(CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, limit, limit, 0, &attributes));
    const DWORD code = GetLastError(); LocalFree(label); LocalFree(acl); if (!pipe) error("create private snapshot pipe", code); return pipe;
}
void accept(HANDLE pipe) {
    Handle event(CreateEventW(nullptr, TRUE, FALSE, nullptr)); if (!event) error("create accept event"); OVERLAPPED operation{}; operation.hEvent = event.value;
    if (ConnectNamedPipe(pipe, &operation)) return; DWORD code = GetLastError(); if (code == ERROR_PIPE_CONNECTED) return; if (code != ERROR_IO_PENDING) error("connect snapshot pipe", code);
    if (WaitForSingleObject(event.value, 120000) != WAIT_OBJECT_0) { CancelIoEx(pipe, &operation); if (WaitForSingleObject(event.value, 5000) != WAIT_OBJECT_0) ExitProcess(1); error("elevated helper connection timed out", ERROR_TIMEOUT); }
    DWORD ignored = 0; if (!GetOverlappedResult(pipe, &operation, &ignored, FALSE)) error("complete snapshot pipe connection");
}
std::wstring executable() { std::vector<wchar_t> value(32768); const DWORD size = GetModuleFileNameW(nullptr, value.data(), static_cast<DWORD>(value.size())); if (!size || size >= value.size()) error("helper executable path"); return std::wstring(value.data(), size); }
std::wstring quoteArgument(const std::wstring& value) { if (value.find_first_of(L"\"\r\n") != std::wstring::npos) error("invalid helper argument", ERROR_INVALID_PARAMETER); return L"\"" + value + L"\""; }
void checkPeer(HANDLE pipe, HANDLE peer, DWORD expectedPid, bool peerShouldBeElevated) {
    ULONG actual = 0; const BOOL ok = peerShouldBeElevated ? GetNamedPipeClientProcessId(pipe, &actual) : GetNamedPipeServerProcessId(pipe, &actual);
    if (!ok || actual != expectedPid || GetProcessId(peer) != expectedPid || WaitForSingleObject(peer, 0) != WAIT_TIMEOUT) error("snapshot IPC peer PID mismatch", ERROR_ACCESS_DENIED);
    const Identity own = identity(GetCurrentProcess()), remote = identity(peer);
    if (!same(own, remote) || remote.elevated != peerShouldBeElevated || (!peerShouldBeElevated && remote.integrity > SECURITY_MANDATORY_MEDIUM_RID)) error("snapshot IPC peer token mismatch", ERROR_ACCESS_DENIED);
}
std::string mappingJson(const std::vector<Volume>& roots, bool writers) {
    std::string result = "{\"schemaVersion\":1,\"mode\":" + quoted(writers ? "writers" : "snapshot-only") +
        ",\"consistentSnapshot\":true,\"helperElevated\":true,\"clientUnelevated\":true,\"sourceAccess\":\"worker-token\",\"volumes\":[";
    for (size_t i = 0; i < roots.size(); ++i) { const auto& item = roots[i]; if (i) result += ','; result += "{\"root\":" + quoted(utf8(item.root)) + ",\"guid\":" + quoted(utf8(item.guid)) + ",\"device\":" + quoted(utf8(item.device)) + ",\"snapshotId\":" + quoted(utf8(guidText(item.snapshot))) + '}'; }
    return result + "]}";
}
void writerStatus(IVssBackupComponents* backup, IVssAsync*& async, Report& report) {
    report.check("GatherWriterStatus", backup->GatherWriterStatus(&async)); awaitSnapshot(async, report); async->Release(); async = nullptr;
    UINT count = 0; report.check("GetWriterStatusCount", backup->GetWriterStatusCount(&count));
    bool healthy = true;
    for (UINT i = 0; i < count; ++i) { VSS_ID instance{}, writer{}; BSTR name = nullptr; VSS_WRITER_STATE state{}; HRESULT failure = S_OK;
        const HRESULT query = backup->GetWriterStatus(i, &instance, &writer, &name, &state, &failure); if (name) SysFreeString(name);
        report.check("GetWriterStatus", query); if (FAILED(failure) || state >= VSS_WS_FAILED_AT_IDENTIFY) healthy = false;
    }
    report.check("FreeWriterStatus", backup->FreeWriterStatus()); if (!healthy) error("a VSS writer reported failure", ERROR_INVALID_DATA);
}
int serveLease(HANDLE pipe, Frame input) {
    Report report; bool com = false, initialized = false, settled = true, completed = false, failed = false, writers = false, metadata = false;
    std::vector<Volume> volumes; IVssBackupComponents* backup = nullptr; IVssAsync* async = nullptr; VSS_ID set = GUID_NULL;
    std::string failureMessage; HRESULT failureCode = E_FAIL;
    try {
        if (input.opcode != 0x20) error("snapshot volume request missing", ERROR_INVALID_DATA);
        Cursor cursor{input.payload}; const auto mode = cursor.number(); if (mode > 1) error("unknown snapshot context", ERROR_INVALID_DATA); writers = mode == 1;
        const auto count = cursor.number(); if (!count || count > 64) error("invalid snapshot volume count", ERROR_INVALID_DATA);
        for (uint32_t i = 0; i < count; ++i) { const auto guid = cursor.string(); if (!volumeName(guid) || std::any_of(volumes.begin(), volumes.end(), [&](const Volume& item) { return _wcsicmp(item.guid.c_str(), guid.c_str()) == 0; })) error("invalid or duplicate volume GUID", ERROR_INVALID_DATA); volumes.push_back(Volume{L"", guid, L"", GUID_NULL}); }
        cursor.end();
        report.check("CoInitializeEx", CoInitializeEx(nullptr, COINIT_MULTITHREADED)); com = true;
        IGlobalOptions* options = nullptr; report.check("CoCreateInstance(IGlobalOptions)", CoCreateInstance(CLSID_GlobalOptions, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&options)));
        const HRESULT optionResult = options->Set(COMGLB_EXCEPTION_HANDLING, COMGLB_EXCEPTION_DONOT_HANDLE); options->Release(); report.check("disable COM exception handling", optionResult);
        static bool securityInitialized = false;
        if (!securityInitialized) { report.check("CoInitializeSecurity", CoInitializeSecurity(nullptr, -1, nullptr, nullptr, RPC_C_AUTHN_LEVEL_PKT_PRIVACY, RPC_C_IMP_LEVEL_IDENTIFY, nullptr, EOAC_NONE, nullptr)); securityInitialized = true; }
        report.check("CreateVssBackupComponents", CreateVssBackupComponents(&backup)); report.check("InitializeForBackup", backup->InitializeForBackup()); initialized = true;
        report.check("SetContext", backup->SetContext(writers ? VSS_CTX_BACKUP : VSS_CTX_FILE_SHARE_BACKUP));
        if (writers) {
            report.check("SetBackupState(copy; non-component)", backup->SetBackupState(false, false, VSS_BT_COPY, false));
            report.check("GatherWriterMetadata", backup->GatherWriterMetadata(&async)); awaitSnapshot(async, report); async->Release(); async = nullptr; metadata = true;
            UINT writerCount = 0; report.check("GetWriterMetadataCount", backup->GetWriterMetadataCount(&writerCount));
            for (UINT i = 0; i < writerCount; ++i) {
                VSS_ID writerInstance{}; IVssExamineWriterMetadata* writer = nullptr;
                report.check("GetWriterMetadata", backup->GetWriterMetadata(i, &writerInstance, &writer));
                DWORD schema = 0; const HRESULT schemaResult = writer->GetBackupSchema(&schema); writer->Release();
                report.check("GetBackupSchema", schemaResult);
                if (!(schema & VSS_BS_COPY)) error("a VSS writer does not explicitly support copy-only backup; refusing a possible full-backup fallback", ERROR_NOT_SUPPORTED);
            }
        }
        report.check("StartSnapshotSet", backup->StartSnapshotSet(&set));
        for (auto& item : volumes) { BOOL supported = FALSE; report.check("IsVolumeSupported", backup->IsVolumeSupported(GUID_NULL, item.guid.data(), &supported)); if (!supported) error("source volume does not support VSS", ERROR_NOT_SUPPORTED); report.check("AddToSnapshotSet", backup->AddToSnapshotSet(item.guid.data(), GUID_NULL, &item.snapshot)); }
        if (writers) { report.check("PrepareForBackup", backup->PrepareForBackup(&async)); awaitSnapshot(async, report); async->Release(); async = nullptr; writerStatus(backup, async, report); }
        report.check("DoSnapshotSet", backup->DoSnapshotSet(&async)); awaitSnapshot(async, report); async->Release(); async = nullptr;
        if (writers) writerStatus(backup, async, report);
        std::vector<BYTE> prepared; appendNumber(prepared, static_cast<uint32_t>(volumes.size()));
        for (auto& item : volumes) {
            VSS_SNAPSHOT_PROP properties{}; report.check("GetSnapshotProperties", backup->GetSnapshotProperties(item.snapshot, &properties));
            item.device = properties.m_pwszSnapshotDeviceObject ? properties.m_pwszSnapshotDeviceObject : L"";
            const bool own = properties.m_SnapshotId == item.snapshot && properties.m_SnapshotSetId == set && properties.m_pwszOriginalVolumeName && _wcsicmp(properties.m_pwszOriginalVolumeName, item.guid.c_str()) == 0;
            const bool context = !(properties.m_lSnapshotAttributes & (VSS_VOLSNAP_ATTR_PERSISTENT | VSS_VOLSNAP_ATTR_NO_AUTO_RELEASE)) &&
                (((properties.m_lSnapshotAttributes & VSS_VOLSNAP_ATTR_NO_WRITERS) != 0) == !writers);
            VssFreeSnapshotProperties(&properties); if (!own || !context || !snapshotDevice(item.device)) error("snapshot identity or context mismatch", ERROR_INVALID_DATA);
            appendString(prepared, item.guid); appendString(prepared, item.device); appendString(prepared, guidText(item.snapshot));
        }
        send(pipe, 0x81, prepared);
        for (;;) { if (!receive(pipe, input)) break; if (input.opcode == 3 && input.payload.empty()) continue; if (input.opcode == 2 && input.payload.empty()) { completed = true; break; } if (input.opcode == 4 && input.payload.empty()) break; error("unknown snapshot lease operation", ERROR_INVALID_DATA); }
        if (writers && completed) { report.check("BackupComplete", backup->BackupComplete(&async)); awaitSnapshot(async, report); async->Release(); async = nullptr; writerStatus(backup, async, report); }
    } catch (const Failure& failure) { failed = true; failureMessage = failure.step; failureCode = failure.hr; }
    catch (const std::exception& failure) { failed = true; failureMessage = failure.what(); }
    if (async) { settled = settleCancelledSnapshot(async, report); async->Release(); async = nullptr; }
    if (backup && initialized && (!completed || failed)) report.step("AbortBackup", backup->AbortBackup());
    bool deleted = settled;
    if (backup && settled) for (const auto& item : volumes) if (item.snapshot != GUID_NULL) {
        LONG count = 0; VSS_ID notDeleted = GUID_NULL; const HRESULT removal = backup->DeleteSnapshots(item.snapshot, VSS_OBJECT_SNAPSHOT, FALSE, &count, &notDeleted);
        VSS_SNAPSHOT_PROP properties{}; const HRESULT query = backup->GetSnapshotProperties(item.snapshot, &properties); if (SUCCEEDED(query)) VssFreeSnapshotProperties(&properties);
        if (query != VSS_E_OBJECT_NOT_FOUND || (FAILED(removal) && removal != VSS_E_OBJECT_NOT_FOUND)) deleted = false;
    }
    if (backup && metadata) backup->FreeWriterMetadata(); if (backup) backup->Release(); if (com) CoUninitialize();
    try {
        if (failed) textFrame(pipe, 0xff, "{\"message\":" + quoted(failureMessage) + ",\"code\":" + quoted(hex(failureCode)) + ",\"cleanupVerified\":" + (deleted ? "true" : "false") + '}');
        else textFrame(pipe, 0x82, std::string("{\"schemaVersion\":1,\"cleanupVerified\":") + (deleted ? "true" : "false") + ",\"ownedSnapshotsDeleted\":" + (deleted ? "true" : "false") + '}');
    } catch (...) {}
    return !deleted ? 1 : failed ? 2 : 0;
}
int server(const std::wstring& name, DWORD ownerPid) {
    if (!elevated()) error("snapshot server must be explicitly elevated", ERROR_ELEVATION_REQUIRED);
    if (name.rfind(L"\\\\.\\pipe\\delta-vss-lease-", 0) || name.find(L'\\', 9) != std::wstring::npos) error("invalid snapshot pipe name", ERROR_INVALID_NAME);
    Handle owner(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, ownerPid)); if (!owner) error("open original ordinary lease owner");
    // Identification-only SQOS prevents the ordinary pipe server from acquiring
    // an impersonatable administrator token from this elevated pipe client.
    Handle pipe(CreateFileW(name.c_str(), pipeRights, 0, nullptr, OPEN_EXISTING,
        FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr)); if (!pipe) error("connect ordinary snapshot owner");
    checkPeer(pipe.value, owner.value, ownerPid, false);
    Frame input;
    while (receive(pipe.value, input)) {
        if (WaitForSingleObject(owner.value, 0) != WAIT_TIMEOUT) error("ordinary VSS owner exited", ERROR_BROKEN_PIPE);
        if (input.opcode == 3 && input.payload.empty()) continue;
        if (input.opcode == 4 && input.payload.empty()) { textFrame(pipe.value, 0x82, "{\"schemaVersion\":1,\"cleanupVerified\":true,\"ownedSnapshotsDeleted\":true}"); return 0; }
        if (input.opcode != 0x20) error("unknown idle VSS operation", ERROR_INVALID_DATA);
        if (serveLease(pipe.value, input) == 1) return 1;
    }
    return 0;
}
int client(bool persistent) {
    const Identity own = identity(GetCurrentProcess());
    if (own.elevated || own.integrity > SECURITY_MANDATORY_MEDIUM_RID) error("VSS lease client must run without administrator privileges", ERROR_ACCESS_DENIED);
    const HANDLE input = GetStdHandle(STD_INPUT_HANDLE), output = GetStdHandle(STD_OUTPUT_HANDLE);
    Frame request; if (!receive(input, request, false) || request.opcode != 1) error("VSS prepare request missing", ERROR_INVALID_DATA);
    bool writers = false; auto roots = sourceVolumes(request.payload, writers);
    GUID id{}; if (FAILED(CoCreateGuid(&id))) error("lease pipe GUID", ERROR_INVALID_DATA);
    const std::wstring name = L"\\\\.\\pipe\\delta-vss-lease-" + guidText(id); auto pipe = privateServer(name, own);
    const std::wstring parameters = L"--server --pipe " + quoteArgument(name) + L" --owner-pid " + std::to_wstring(GetCurrentProcessId());
    const std::wstring binary = executable(); SHELLEXECUTEINFOW launch{}; launch.cbSize = sizeof(launch); launch.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI;
    launch.lpVerb = L"runas"; launch.lpFile = binary.c_str(); launch.lpParameters = parameters.c_str(); launch.nShow = SW_HIDE;
    // This UAC request occurs only in the real application after the user starts
    // a VSS task. Qualification tools never execute --lease automatically.
    if (!ShellExecuteExW(&launch) || !launch.hProcess) error("VSS administrator authorization was not granted"); Handle helper(launch.hProcess);
    accept(pipe.value); const DWORD helperPid = GetProcessId(helper.value); checkPeer(pipe.value, helper.value, helperPid, true);
    bool shutdown = false, shutdownAcknowledged = false, operationFailed = false;
    for (;;) {
        std::vector<Volume> volumes;
        for (const auto& root : roots) if (std::none_of(volumes.begin(), volumes.end(), [&](const Volume& item) { return _wcsicmp(item.guid.c_str(), root.guid.c_str()) == 0; })) volumes.push_back(root);
        std::vector<BYTE> payload; appendNumber(payload, writers ? 1 : 0); appendNumber(payload, static_cast<uint32_t>(volumes.size())); for (const auto& item : volumes) appendString(payload, item.guid);
        send(pipe.value, 0x20, payload); Frame response; if (!receive(pipe.value, response)) error("elevated snapshot helper disconnected", ERROR_BROKEN_PIPE);
        if (response.opcode == 0xff) { send(output, response.opcode, response.payload, false); operationFailed = true; if (!persistent) break; }
        else {
            if (response.opcode != 0x81) error("unexpected snapshot prepare response", ERROR_INVALID_DATA);
            Cursor prepared{response.payload}; if (prepared.number() != volumes.size()) error("snapshot volume count mismatch", ERROR_INVALID_DATA);
            for (auto& item : volumes) { const auto guid = prepared.string(); item.device = prepared.string(); const auto snapshot = prepared.string();
                if (_wcsicmp(guid.c_str(), item.guid.c_str()) || !snapshotDevice(item.device) || FAILED(CLSIDFromString(snapshot.c_str(), &item.snapshot)) || item.snapshot == GUID_NULL) error("snapshot mapping mismatch", ERROR_INVALID_DATA);
                for (auto& root : roots) if (_wcsicmp(root.guid.c_str(), guid.c_str()) == 0) { root.device = item.device; root.snapshot = item.snapshot; }
            }
            prepared.end(); textFrame(output, 0x81, mappingJson(roots, writers), false);
            for (;;) {
                if (!receive(input, request, false)) { send(pipe.value, 4); shutdown = true; break; }
                if (!request.payload.empty() || (request.opcode != 2 && request.opcode != 3 && request.opcode != 4)) error("invalid ordinary lease operation", ERROR_INVALID_DATA);
                send(pipe.value, request.opcode); if (request.opcode == 2 || request.opcode == 4) { shutdown = request.opcode == 4; break; }
            }
            if (!receive(pipe.value, response)) error("snapshot cleanup response missing", ERROR_BROKEN_PIPE); send(output, response.opcode, response.payload, false); shutdownAcknowledged = shutdown;
            if (shutdown || !persistent) break;
        }
        for (;;) {
            if (!receive(input, request, false)) { shutdown = true; break; }
            if (request.opcode == 3 && request.payload.empty()) { send(pipe.value, 3); continue; }
            if (request.opcode == 4 && request.payload.empty()) { shutdown = true; break; }
            if (request.opcode != 1) error("next VSS prepare request missing", ERROR_INVALID_DATA);
            roots = sourceVolumes(request.payload, writers); break;
        }
        if (shutdown) break;
    }
    // Ensure even the one-lease client explicitly shuts down its otherwise-idle
    // elevated server, and verifies that process exit after cleanup.
    if (pipe) { send(pipe.value, 4); Frame closed; if (!receive(pipe.value, closed) || closed.opcode != 0x82) error("VSS session shutdown was not acknowledged", ERROR_INVALID_DATA); if (persistent && shutdown && !shutdownAcknowledged) send(output, closed.opcode, closed.payload, false); }
    if (WaitForSingleObject(helper.value, 120000) != WAIT_OBJECT_0) error("snapshot helper exit timed out; cleanup unverified", ERROR_TIMEOUT);
    DWORD exitCode = 1; if (!GetExitCodeProcess(helper.value, &exitCode)) error("snapshot helper exit status"); return !persistent && operationFailed ? 1 : static_cast<int>(exitCode);
}
void selfTest() {
    unsigned tests = 0; const auto require = [&](bool condition) { if (!condition) error("native lease self-test", ERROR_ASSERTION_FAILURE); ++tests; };
    require(volumeName(L"\\\\?\\Volume{01234567-89AB-CDEF-0123-456789ABCDEF}\\")); require(!volumeName(L"C:\\"));
    require(snapshotDevice(L"\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy12")); require(!snapshotDevice(L"\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy12\\..\\Windows"));
    require((pipeRights & FILE_CREATE_PIPE_INSTANCE) == 0); std::vector<BYTE> encoded; appendNumber(encoded, 7); appendString(encoded, L"za\u017C\u00F3\u0142\u0107"); Cursor cursor{encoded}; require(cursor.number() == 7); require(cursor.string() == L"za\u017C\u00F3\u0142\u0107"); cursor.end();
    std::cout << "{\"schemaVersion\":1,\"probe\":\"native-vss-lease\",\"status\":\"passed\",\"selfTestsPassed\":" << tests << ",\"createdSnapshot\":false,\"sourceFilesRead\":false}\n";
}
} // namespace lease
int wmain(int argc, wchar_t** argv) {
    SetConsoleOutputCP(CP_UTF8);
    try {
        if (argc == 2 && std::wstring(argv[1]) == L"--self-test") { lease::selfTest(); return 0; }
        if (argc == 2 && (std::wstring(argv[1]) == L"--lease" || std::wstring(argv[1]) == L"--session")) return lease::client(std::wstring(argv[1]) == L"--session");
        if (argc == 6 && std::wstring(argv[1]) == L"--server" && std::wstring(argv[2]) == L"--pipe" && std::wstring(argv[4]) == L"--owner-pid") {
            wchar_t* end = nullptr; const DWORD pid = wcstoul(argv[5], &end, 10); if (!pid || !end || *end) lease::error("invalid original lease owner PID", ERROR_INVALID_PARAMETER); return lease::server(argv[3], pid);
        }
        lease::error("Use --lease or --self-test", ERROR_INVALID_PARAMETER);
    } catch (const Failure& failure) { try { lease::textFrame(GetStdHandle(STD_OUTPUT_HANDLE), 0xff, "{\"message\":" + quoted(failure.step) + ",\"code\":" + quoted(hex(failure.hr)) + '}', false); } catch (...) {} }
    catch (const std::exception& failure) { try { lease::textFrame(GetStdHandle(STD_OUTPUT_HANDLE), 0xff, "{\"message\":" + quoted(failure.what()) + '}', false); } catch (...) {} }
    return 1;
}
