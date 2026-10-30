// Delta Backupper stage 0. This probe is not the production VSS adapter.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <objbase.h>
#include <vss.h>
#include <vswriter.h>
#include <vsbackup.h>
#include <vsserror.h>
#include <atomic>
#include <cstdio>
#include <functional>
#include <iostream>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
std::atomic<bool> cancelled{false};
BOOL WINAPI onControl(DWORD event) {
    if (event == CTRL_C_EVENT || event == CTRL_BREAK_EVENT) {
        cancelled = true;
        return TRUE;
    }
    return FALSE;
}
std::string utf8(const std::wstring& value) {
    if (value.empty()) return {};
    const int count = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
        static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    if (!count) throw std::runtime_error("UTF-8 conversion failed");
    std::string result(count, '\0');
    WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
        static_cast<int>(value.size()), result.data(), count, nullptr, nullptr);
    return result;
}
std::string quoted(const std::string& value) {
    std::string result = "\"";
    for (unsigned char ch : value) {
        if (ch == '"' || ch == '\\') { result += '\\'; result += ch; }
        else if (ch < 0x20) { char code[7]; sprintf_s(code, "\\u%04x", ch); result += code; }
        else result += ch;
    }
    return result + '"';
}
std::string hex(HRESULT hr) {
    char text[11]; sprintf_s(text, "0x%08lX", static_cast<unsigned long>(hr)); return text;
}
std::wstring guidText(GUID id) {
    wchar_t buffer[40]; StringFromGUID2(id, buffer, 40); return buffer;
}
struct Failure { std::string step; HRESULT hr; };
constexpr DWORD snapshotTimeoutMs = 90000;
constexpr DWORD cancellationTimeoutMs = 15000;
constexpr DWORD waitIntervalMs = 250;
enum class Scenario { normal, failAfterSnapshot, cancelAfterSnapshot };
struct Arguments { bool lifecycle = false; bool selfTest = false; Scenario scenario = Scenario::normal; };
Arguments parseArguments(int argc, wchar_t** argv) {
    Arguments args;
    bool modeSpecified = false;
    for (int index = 1; index < argc; ++index) {
        const std::wstring option = argv[index];
        if (option == L"--capabilities" || option == L"--lifecycle" || option == L"--self-test") {
            if (modeSpecified) throw Failure{"Only one probe mode may be selected", E_INVALIDARG};
            modeSpecified = true;
            args.lifecycle = option == L"--lifecycle";
            args.selfTest = option == L"--self-test";
        } else if (option == L"--fail-after-snapshot" || option == L"--cancel-after-snapshot") {
            if (args.scenario != Scenario::normal) throw Failure{"Only one injected termination may be selected", E_INVALIDARG};
            args.scenario = option == L"--fail-after-snapshot" ? Scenario::failAfterSnapshot : Scenario::cancelAfterSnapshot;
        } else throw Failure{"Use --capabilities, --self-test, or --lifecycle [--fail-after-snapshot|--cancel-after-snapshot]", E_INVALIDARG};
    }
    if (args.scenario != Scenario::normal && !args.lifecycle)
        throw Failure{"Injected termination requires --lifecycle", E_INVALIDARG};
    return args;
}
std::string scenarioName(Scenario scenario) {
    if (scenario == Scenario::failAfterSnapshot) return "fail-after-snapshot";
    if (scenario == Scenario::cancelAfterSnapshot) return "cancel-after-snapshot";
    return "normal";
}
struct Report {
    std::map<std::string, std::string> fields;
    std::vector<std::string> steps;
    void text(const std::string& key, const std::string& value) { fields[key] = quoted(value); }
    void boolean(const std::string& key, bool value) { fields[key] = value ? "true" : "false"; }
    void step(const std::string& name, HRESULT hr) {
        steps.push_back("{\"operation\":" + quoted(name) + ",\"hresult\":" + quoted(hex(hr)) + "}");
    }
    void check(const std::string& name, HRESULT hr) { step(name, hr); if (FAILED(hr)) throw Failure{name, hr}; }
    void print() {
        std::cout << '{';
        for (const auto& [key, value] : fields) std::cout << quoted(key) << ':' << value << ',';
        std::cout << "\"steps\":[";
        for (size_t i = 0; i < steps.size(); ++i) std::cout << (i ? "," : "") << steps[i];
        std::cout << "]}\n";
    }
};
void checkCancelled() {
    if (cancelled) throw Failure{"cancelled", HRESULT_FROM_WIN32(ERROR_CANCELLED)};
}
bool elevated() {
    HANDLE token = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token))
        throw Failure{"OpenProcessToken", HRESULT_FROM_WIN32(GetLastError())};
    TOKEN_ELEVATION info{}; DWORD size = 0;
    const BOOL ok = GetTokenInformation(token, TokenElevation, &info, sizeof(info), &size);
    const DWORD error = GetLastError(); CloseHandle(token);
    if (!ok) throw Failure{"GetTokenInformation", HRESULT_FROM_WIN32(error)};
    return info.TokenIsElevated != 0;
}
void writeMarker(const std::wstring& path, const std::string& data, DWORD creation) {
    HANDLE file = CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr,
        creation, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) throw Failure{"CreateFile(marker)", HRESULT_FROM_WIN32(GetLastError())};
    DWORD written = 0;
    BOOL ok = WriteFile(file, data.data(), static_cast<DWORD>(data.size()), &written, nullptr);
    DWORD error = GetLastError();
    if (ok && written == data.size()) { ok = FlushFileBuffers(file); error = GetLastError(); }
    CloseHandle(file);
    if (!ok || written != data.size()) throw Failure{"WriteFile(marker)", HRESULT_FROM_WIN32(error ? error : ERROR_WRITE_FAULT)};
}
std::string readMarker(const std::wstring& path) {
    HANDLE file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) throw Failure{"CreateFile(snapshot marker)", HRESULT_FROM_WIN32(GetLastError())};
    char buffer[1024]; DWORD read = 0;
    const BOOL ok = ReadFile(file, buffer, sizeof(buffer), &read, nullptr);
    const DWORD error = GetLastError(); CloseHandle(file);
    if (!ok) throw Failure{"ReadFile(snapshot marker)", HRESULT_FROM_WIN32(error)};
    return std::string(buffer, read);
}
// A mount point is removed only after checking the actual volume-root prefix.
// Snapshot paths are never used as arbitrary command lines or exposed as mounts.
std::wstring snapshotPath(const std::wstring& device, const std::wstring& volumeRoot, const std::wstring& source) {
    if (device.empty() || volumeRoot.empty() || volumeRoot.back() != L'\\' ||
        source.size() < volumeRoot.size() || _wcsnicmp(source.c_str(), volumeRoot.c_str(), volumeRoot.size()) != 0)
        throw Failure{"Source path is outside the snapshotted volume mount point", E_INVALIDARG};
    std::wstring result = device;
    if (result.back() != L'\\') result += L'\\';
    return result + source.substr(volumeRoot.size());
}
using Clock = std::function<ULONGLONG()>;
void awaitSnapshot(IVssAsync* operation, Report& report, const Clock& now = GetTickCount64) {
    const ULONGLONG start = now();
    for (;;) {
        // The common finally path cancels, waits for settling, and only then deletes.
        if (cancelled || now() - start >= snapshotTimeoutMs) {
            throw Failure{cancelled ? "cancelled" : "snapshot timeout", HRESULT_FROM_WIN32(cancelled ? ERROR_CANCELLED : ERROR_TIMEOUT)};
        }
        report.check("IVssAsync::Wait", operation->Wait(waitIntervalMs));
        HRESULT result = E_PENDING;
        report.check("IVssAsync::QueryStatus", operation->QueryStatus(&result, nullptr));
        if (result == VSS_S_ASYNC_PENDING) continue;
        if (result == VSS_S_ASYNC_CANCELLED) throw Failure{"snapshot operation cancelled", HRESULT_FROM_WIN32(ERROR_CANCELLED)};
        report.check("DoSnapshotSet result", result);
        if (result != VSS_S_ASYNC_FINISHED) throw Failure{"DoSnapshotSet unexpected result", E_UNEXPECTED};
        break;
    }
}
bool settleCancelledSnapshot(IVssAsync* operation, Report& report, const Clock& now = GetTickCount64) {
    report.step("IVssAsync::Cancel(finally)", operation->Cancel());
    const ULONGLONG start = now();
    for (;;) {
        HRESULT result = E_PENDING;
        const HRESULT query = operation->QueryStatus(&result, nullptr);
        report.step("IVssAsync::QueryStatus(finally)", query);
        if (FAILED(query)) return false; // Do not claim cleanup on an indeterminate COM status.
        report.text("asyncFinalResult", hex(result));
        if (result != VSS_S_ASYNC_PENDING) return true;
        if (now() - start >= cancellationTimeoutMs) return false;
        const HRESULT wait = operation->Wait(waitIntervalMs);
        report.step("IVssAsync::Wait(finally)", wait);
        if (FAILED(wait)) return false;
    }
}

// No COM, fixture, VSS object, or snapshot is created by this deterministic fake.
// It exercises pending/final statuses and a cancellation that never settles.
class FakeAsync final : public IVssAsync {
public:
    std::vector<HRESULT> results{VSS_S_ASYNC_PENDING, VSS_S_ASYNC_FINISHED};
    HRESULT queryReturn = S_OK, waitReturn = S_OK, cancelReturn = S_OK;
    size_t queries = 0, waits = 0, cancels = 0;
    bool completeOnCancel = true;
    ULONGLONG ticks = 0;
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** result) override {
        if (!result) return E_POINTER;
        *result = nullptr;
        if (iid != IID_IUnknown && iid != IID_IVssAsync) return E_NOINTERFACE;
        *result = static_cast<IVssAsync*>(this); AddRef(); return S_OK;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return 1; }
    ULONG STDMETHODCALLTYPE Release() override { return 1; }
    HRESULT STDMETHODCALLTYPE Cancel() override {
        ++cancels;
        if (completeOnCancel) { results = {VSS_S_ASYNC_CANCELLED}; queries = 0; }
        return cancelReturn;
    }
    HRESULT STDMETHODCALLTYPE Wait(DWORD milliseconds) override { ++waits; ticks += milliseconds; return waitReturn; }
    HRESULT STDMETHODCALLTYPE QueryStatus(HRESULT* result, INT*) override {
        if (!result) return E_POINTER;
        const size_t index = queries++;
        *result = results[index < results.size() ? index : results.size() - 1];
        return queryReturn;
    }
};
void runSelfTests(Report& report) {
    unsigned tests = 0;
    const auto require = [&tests](bool value, const std::string& message) {
        if (!value) throw Failure{"self-test: " + message, E_FAIL};
        ++tests;
    };
    const auto reject = [&require](const std::function<void()>& action, HRESULT expected, const std::string& message) {
        try { action(); } catch (const Failure& failure) { require(failure.hr == expected, message); return; }
        require(false, message);
    };
    Report scratch;
    FakeAsync normal;
    awaitSnapshot(&normal, scratch, [&normal]() { return normal.ticks; });
    require(normal.queries == 2 && normal.waits == 2, "pending operation must be queried until finished");
    FakeAsync externallyCancelled; externallyCancelled.results = {VSS_S_ASYNC_CANCELLED};
    reject([&]() { awaitSnapshot(&externallyCancelled, scratch); }, HRESULT_FROM_WIN32(ERROR_CANCELLED), "cancelled status is not success");
    FakeAsync failed; failed.results = {E_FAIL};
    reject([&]() { awaitSnapshot(&failed, scratch); }, E_FAIL, "asynchronous failure is propagated");
    FakeAsync unexpected; unexpected.results = {S_OK};
    reject([&]() { awaitSnapshot(&unexpected, scratch); }, E_UNEXPECTED, "unexpected successful HRESULT is not a finished operation");
    FakeAsync waitFailure; waitFailure.waitReturn = E_ACCESSDENIED;
    reject([&]() { awaitSnapshot(&waitFailure, scratch); }, E_ACCESSDENIED, "wait failure is propagated");
    FakeAsync queryFailure; queryFailure.queryReturn = E_ACCESSDENIED;
    reject([&]() { awaitSnapshot(&queryFailure, scratch); }, E_ACCESSDENIED, "query failure is propagated");
    FakeAsync signalled;
    cancelled = true;
    reject([&]() { awaitSnapshot(&signalled, scratch); }, HRESULT_FROM_WIN32(ERROR_CANCELLED), "console cancellation is observed before waiting");
    cancelled = false;
    require(signalled.waits == 0 && signalled.queries == 0, "cancelled requester does not start another wait");
    FakeAsync pending; pending.results = {VSS_S_ASYNC_PENDING};
    reject([&]() { awaitSnapshot(&pending, scratch, [&pending]() { return pending.ticks; }); }, HRESULT_FROM_WIN32(ERROR_TIMEOUT), "pending operation is bounded by timeout");
    require(settleCancelledSnapshot(&pending, scratch, [&pending]() { return pending.ticks; }) && pending.cancels == 1, "cancelled operation settles before deletion");
    FakeAsync neverSettles; neverSettles.results = {VSS_S_ASYNC_PENDING}; neverSettles.completeOnCancel = false;
    require(!settleCancelledSnapshot(&neverSettles, scratch, [&neverSettles]() { return neverSettles.ticks; }), "unsettled cancellation cannot verify cleanup");
    FakeAsync brokenQuery; brokenQuery.queryReturn = E_FAIL;
    require(!settleCancelledSnapshot(&brokenQuery, scratch), "failed status query cannot verify cleanup");
    require(snapshotPath(L"\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy1", L"C:\\", L"c:\\fixture\\za\u017C\u00F3\u0142\u0107.txt") ==
        L"\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy1\\fixture\\za\u017C\u00F3\u0142\u0107.txt", "drive-root mapping preserves Unicode");
    require(snapshotPath(L"device\\", L"C:\\mount\\", L"C:\\mount\\fixture.txt") == L"device\\fixture.txt", "mounted-volume mapping strips mount point");
    reject([&]() { snapshotPath(L"device", L"C:\\mount\\", L"C:\\mount-other\\fixture.txt"); }, E_INVALIDARG, "mapping rejects another volume path");
    const auto parse = [](std::vector<std::wstring> arguments) {
        std::vector<wchar_t*> argv;
        for (auto& argument : arguments) argv.push_back(argument.data());
        return parseArguments(static_cast<int>(argv.size()), argv.data());
    };
    require(parse({L"probe", L"--lifecycle", L"--fail-after-snapshot"}).scenario == Scenario::failAfterSnapshot, "valid lifecycle fault injection");
    reject([&]() { parse({L"probe", L"--fail-after-snapshot"}); }, E_INVALIDARG, "fault injection requires explicit lifecycle");
    reject([&]() { parse({L"probe", L"--self-test", L"--lifecycle"}); }, E_INVALIDARG, "ambiguous modes are rejected");
    reject([&]() { parse({L"probe", L"--lifecycle", L"--fail-after-snapshot", L"--cancel-after-snapshot"}); }, E_INVALIDARG, "ambiguous fault scenarios are rejected");
    report.fields["selfTestsPassed"] = std::to_string(tests);
    report.boolean("cleanupVerified", true);
    report.text("status", "passed");
    report.text("reason", "Deterministic argument, path, async completion, failure, timeout and cancellation tests; no VSS resources created");
}
}

int wmain(int argc, wchar_t** argv) {
    Report report;
    report.fields["schemaVersion"] = "2";
    Arguments args;
    try { args = parseArguments(argc, argv); } catch (const Failure& error) {
        report.text("status", "failed"); report.text("reason", error.step); report.text("hresult", hex(error.hr)); report.print(); return 2;
    }
    const bool lifecycle = args.lifecycle;
    report.text("mode", args.selfTest ? "self-test" : lifecycle ? "lifecycle" : "capabilities");
    report.text("scenario", scenarioName(args.scenario));
    report.text("context", "VSS_CTX_FILE_SHARE_BACKUP");
    report.text("consistency", "crash-consistent; no VSS writer participation");
    report.text("status", "unverified");
    report.boolean("createdSnapshot", false);
    report.boolean("snapshotReadVerified", false);
    report.boolean("expectedTerminationObserved", false);
    report.boolean("cleanupVerified", false);
    report.text("ordinaryWorkerRead", "unverified; lifecycle reads in its elevated process");
    report.text("inFlightCancellation", "unverified; injected cancellation happens after completed snapshot read");
    report.text("snapshotLifecycle", "unverified");
    report.text("writerIntegration", "unverified");
    report.fields["volumeSupported"] = "null";
    report.fields["snapshotTimeoutMs"] = std::to_string(snapshotTimeoutMs);
    report.fields["cancellationTimeoutMs"] = std::to_string(cancellationTimeoutMs);
    if (args.selfTest) {
        try { runSelfTests(report); } catch (const Failure& error) {
            report.text("status", "failed"); report.text("reason", error.step); report.text("hresult", hex(error.hr)); report.print(); return 1;
        } catch (const std::exception& error) {
            report.text("status", "failed"); report.text("reason", error.what()); report.print(); return 1;
        }
        report.print(); return 0;
    }
    bool com = false, initialized = false, fixtureCreated = false;
    bool snapshotSetStarted = false, snapshotCreated = false, snapshotReadVerified = false;
    bool asyncSettled = true, snapshotGone = false, fixtureGone = true;
    bool cancelledResult = false, cleanupFailed = false;
    IVssBackupComponents* backup = nullptr;
    IVssAsync* async = nullptr;
    HANDLE lockedMarker = INVALID_HANDLE_VALUE;
    VSS_ID snapshot = GUID_NULL, set = GUID_NULL;
    std::wstring fixtureDirectory, marker;
    bool failed = false;
    try {
        if (!SetConsoleCtrlHandler(onControl, TRUE)) throw Failure{"SetConsoleCtrlHandler", HRESULT_FROM_WIN32(GetLastError())};
        const bool isElevated = elevated();
        report.boolean("elevated", isElevated);
        if (lifecycle && !isElevated) throw Failure{"lifecycle requires explicitly elevated process; no UAC requested", E_ACCESSDENIED};
        wchar_t temporary[MAX_PATH + 1]{};
        const DWORD temporaryLength = GetTempPathW(MAX_PATH + 1, temporary);
        if (!temporaryLength || temporaryLength > MAX_PATH) throw Failure{"GetTempPath", HRESULT_FROM_WIN32(ERROR_BAD_PATHNAME)};
        wchar_t volume[MAX_PATH + 1]{};
        if (!GetVolumePathNameW(temporary, volume, MAX_PATH + 1)) throw Failure{"GetVolumePathName", HRESULT_FROM_WIN32(GetLastError())};
        report.text("volume", utf8(volume));
        wchar_t volumeGuid[MAX_PATH + 1]{};
        if (!GetVolumeNameForVolumeMountPointW(volume, volumeGuid, MAX_PATH + 1))
            throw Failure{"GetVolumeNameForVolumeMountPoint", HRESULT_FROM_WIN32(GetLastError())};
        report.text("volumeGuid", utf8(volumeGuid));
        wchar_t filesystem[MAX_PATH + 1]{};
        if (!GetVolumeInformationW(volume, nullptr, 0, nullptr, nullptr, nullptr, filesystem, MAX_PATH + 1))
            throw Failure{"GetVolumeInformation", HRESULT_FROM_WIN32(GetLastError())};
        report.text("filesystem", utf8(filesystem));

        report.check("CoInitializeEx(MTA)", CoInitializeEx(nullptr, COINIT_MULTITHREADED)); com = true;
        IGlobalOptions* options = nullptr;
        report.check("CoCreateInstance(IGlobalOptions)", CoCreateInstance(CLSID_GlobalOptions, nullptr,
            CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&options)));
        const HRESULT optionResult = options->Set(COMGLB_EXCEPTION_HANDLING, COMGLB_EXCEPTION_DONOT_HANDLE);
        options->Release(); report.check("disable COM exception handling", optionResult);
        report.check("CoInitializeSecurity", CoInitializeSecurity(nullptr, -1, nullptr, nullptr,
            RPC_C_AUTHN_LEVEL_PKT_PRIVACY, RPC_C_IMP_LEVEL_IDENTIFY, nullptr, EOAC_NONE, nullptr));
        report.check("CreateVssBackupComponents", CreateVssBackupComponents(&backup));
        report.check("InitializeForBackup", backup->InitializeForBackup()); initialized = true;
        report.check("SetContext(FILE_SHARE_BACKUP)", backup->SetContext(VSS_CTX_FILE_SHARE_BACKUP));
        BOOL supported = FALSE;
        report.check("IsVolumeSupported", backup->IsVolumeSupported(GUID_NULL, volumeGuid, &supported));
        report.boolean("volumeSupported", supported != FALSE);
        if (!supported) throw Failure{"volume not supported", HRESULT_FROM_WIN32(ERROR_NOT_SUPPORTED)};
        if (lifecycle) {
            GUID fixtureId{}; report.check("CoCreateGuid", CoCreateGuid(&fixtureId));
            fixtureDirectory = std::wstring(temporary) + L"delta-vss-stage0-za\u017C\u00F3\u0142\u0107-" + guidText(fixtureId);
            if (!CreateDirectoryW(fixtureDirectory.c_str(), nullptr)) throw Failure{"CreateDirectory(fixture)", HRESULT_FROM_WIN32(GetLastError())};
            fixtureCreated = true;
            marker = fixtureDirectory + L"\\marker.txt";
            const std::string before = "Delta Backupper VSS stage 0 before " + utf8(guidText(fixtureId));
            const std::string after = "Delta Backupper VSS stage 0 changed " + utf8(guidText(fixtureId));
            writeMarker(marker, before, CREATE_NEW);
            checkCancelled();
            report.check("StartSnapshotSet", backup->StartSnapshotSet(&set)); snapshotSetStarted = true;
            report.text("ownedSnapshotSetId", utf8(guidText(set)));
            report.check("AddToSnapshotSet", backup->AddToSnapshotSet(volumeGuid, GUID_NULL, &snapshot));
            report.text("ownedSnapshotId", utf8(guidText(snapshot)));
            checkCancelled();
            report.check("DoSnapshotSet", backup->DoSnapshotSet(&async));
            awaitSnapshot(async, report); async->Release(); async = nullptr;
            snapshotCreated = true; report.boolean("createdSnapshot", true);
            report.text("snapshotLifecycle", "snapshot-created; cleanup pending");
            checkCancelled();
            VSS_SNAPSHOT_PROP properties{};
            report.check("GetSnapshotProperties", backup->GetSnapshotProperties(snapshot, &properties));
            const std::wstring device = properties.m_pwszSnapshotDeviceObject ? properties.m_pwszSnapshotDeviceObject : L"";
            const bool matchingProperties = properties.m_SnapshotId == snapshot && properties.m_SnapshotSetId == set &&
                properties.m_pwszOriginalVolumeName && _wcsicmp(properties.m_pwszOriginalVolumeName, volumeGuid) == 0;
            const bool correctContext = (properties.m_lSnapshotAttributes & VSS_VOLSNAP_ATTR_NO_WRITERS) != 0 &&
                (properties.m_lSnapshotAttributes & (VSS_VOLSNAP_ATTR_PERSISTENT | VSS_VOLSNAP_ATTR_NO_AUTO_RELEASE)) == 0;
            report.fields["snapshotAttributes"] = std::to_string(properties.m_lSnapshotAttributes);
            report.boolean("snapshotPropertiesMatchOwnedIdsAndVolume", matchingProperties);
            report.boolean("snapshotNonpersistentNoWriters", correctContext);
            VssFreeSnapshotProperties(&properties);
            if (!matchingProperties || !correctContext || device.empty()) throw Failure{"Snapshot properties did not match the owned session/context", E_FAIL};
            writeMarker(marker, after, TRUNCATE_EXISTING);
            lockedMarker = CreateFileW(marker.c_str(), GENERIC_READ, 0, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
            if (lockedMarker == INVALID_HANDLE_VALUE) throw Failure{"lock live marker", HRESULT_FROM_WIN32(GetLastError())};
            HANDLE liveAttempt = CreateFileW(marker.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
            const DWORD liveError = GetLastError();
            if (liveAttempt != INVALID_HANDLE_VALUE) CloseHandle(liveAttempt);
            const bool liveReadBlocked = liveAttempt == INVALID_HANDLE_VALUE && liveError == ERROR_SHARING_VIOLATION;
            report.boolean("liveLockedMarkerReadBlocked", liveReadBlocked);
            if (!liveReadBlocked) throw Failure{"exclusive live marker lock was not demonstrated", E_FAIL};
            checkCancelled();
            const std::string snapshotted = readMarker(snapshotPath(device, volume, marker));
            report.boolean("snapshotLockedMarkerReadSucceeded", true);
            CloseHandle(lockedMarker); lockedMarker = INVALID_HANDLE_VALUE;
            report.boolean("snapshotPreservedOriginalMarker", snapshotted == before);
            report.boolean("liveMarkerChanged", readMarker(marker) == after);
            if (snapshotted != before || readMarker(marker) != after) throw Failure{"snapshot isolation mismatch", E_FAIL};
            snapshotReadVerified = true; report.boolean("snapshotReadVerified", true);
            report.text("snapshotLifecycle", "read-verified; cleanup pending");
            checkCancelled();
            // Both injected terminations keep a completed, read-verified snapshot alive
            // until the same finally path used by real failures/cancellation runs.
            if (args.scenario == Scenario::failAfterSnapshot) throw Failure{"injected failure after snapshot", E_FAIL};
            if (args.scenario == Scenario::cancelAfterSnapshot) throw Failure{"injected cancellation after snapshot", HRESULT_FROM_WIN32(ERROR_CANCELLED)};
        }
        report.text("status", "passed");
        report.text("reason", lifecycle ? "Snapshot created and original fixture read verified" : "VSS initialization and volume support checked; no snapshot created");
    } catch (const Failure& error) {
        failed = true;
        cancelledResult = error.hr == HRESULT_FROM_WIN32(ERROR_CANCELLED);
        report.text("status", error.hr == E_ACCESSDENIED ? "blocked" : (cancelledResult ? "cancelled" : "failed"));
        report.text("reason", error.step); report.text("hresult", hex(error.hr));
        const bool expected = snapshotCreated &&
            ((args.scenario == Scenario::failAfterSnapshot && error.step == "injected failure after snapshot" && error.hr == E_FAIL) ||
             (args.scenario == Scenario::cancelAfterSnapshot && error.step == "injected cancellation after snapshot" && cancelledResult));
        report.boolean("expectedTerminationObserved", expected);
    } catch (const std::exception& error) {
        failed = true; report.text("status", "failed"); report.text("reason", error.what());
    }
    // Finally: only IDs returned to this process are candidates for deletion.
    if (lockedMarker != INVALID_HANDLE_VALUE) CloseHandle(lockedMarker);
    if (async) {
        asyncSettled = settleCancelledSnapshot(async, report);
        report.boolean("asyncCancellationSettled", asyncSettled);
        async->Release(); async = nullptr;
    }
    if (backup && initialized && failed && snapshotSetStarted) report.step("AbortBackup(finally)", backup->AbortBackup());
    if (backup && snapshot != GUID_NULL && asyncSettled) {
        LONG deleted = 0; VSS_ID notDeleted = GUID_NULL;
        const HRESULT removal = backup->DeleteSnapshots(snapshot, VSS_OBJECT_SNAPSHOT, FALSE, &deleted, &notDeleted);
        report.step("DeleteSnapshots(owned ID only)", removal);
        report.fields["deletedSnapshots"] = std::to_string(deleted);
        VSS_SNAPSHOT_PROP remaining{};
        const HRESULT lookup = backup->GetSnapshotProperties(snapshot, &remaining);
        report.step("GetSnapshotProperties(after delete)", lookup);
        if (SUCCEEDED(lookup)) VssFreeSnapshotProperties(&remaining);
        snapshotGone = lookup == VSS_E_OBJECT_NOT_FOUND;
        report.boolean("ownedSnapshotDeletionVerified", snapshotGone);
        if (!snapshotGone || (FAILED(removal) && removal != VSS_E_OBJECT_NOT_FOUND)) {
            failed = true; cleanupFailed = true; report.text("status", "failed"); report.text("cleanupError", "Owned snapshot deletion could not be verified; consult ownedSnapshotId");
        }
    } else if (!asyncSettled) {
        failed = true; cleanupFailed = true;
        report.text("status", "failed");
        report.boolean("ownedSnapshotDeletionVerified", false);
        report.text("cleanupError", "Snapshot operation did not settle; explicit deletion skipped to avoid racing creation; auto-release requested by releasing requester, cleanup remains unverified");
    }
    // Releasing this nonpersistent context is also VSS auto-release protection.
    if (backup) backup->Release();
    if (fixtureCreated) {
        const bool fileGone = DeleteFileW(marker.c_str()) || GetLastError() == ERROR_FILE_NOT_FOUND;
        const bool directoryGone = RemoveDirectoryW(fixtureDirectory.c_str()) != FALSE;
        fixtureGone = fileGone && directoryGone;
        report.boolean("fixtureCleanup", fixtureGone);
        if (!fixtureGone) { failed = true; cleanupFailed = true; report.text("status", "failed"); report.text("fixtureCleanupError", "Could not remove exact owned marker/directory; no recursive delete attempted"); }
    }
    if (com) CoUninitialize();
    const bool cleanupVerified = asyncSettled && !cleanupFailed && fixtureGone && (snapshot == GUID_NULL || snapshotGone);
    report.boolean("cleanupVerified", cleanupVerified);
    if (snapshotCreated && cleanupVerified) {
        if (!failed) report.text("snapshotLifecycle", "passed");
        else report.text("snapshotLifecycle", snapshotReadVerified ?
            "read-verified; cleanup passed; operation did not complete normally" :
            "snapshot-created; cleanup passed; read was not verified");
    }
    report.print();
    if (report.fields["status"] == quoted("blocked")) return 3;
    if (cancelledResult && !cleanupFailed) return 130;
    return failed ? 1 : 0;
}
