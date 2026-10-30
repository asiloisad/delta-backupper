# Windows VSS helper

The native helper creates and releases temporary VSS snapshots while Delta's ordinary-user worker reads their files. It does not provide an administrator file-read API, change source ACLs or grant the worker additional permissions.

## Build

Install MSVC C++ build tools and Windows SDK, then run this command from the repository root:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./native/windows/Build-Vss.ps1
```

The build writes `delta-vss.exe` and a manifest to `.dev/native/windows`, uses a static C++ runtime, and runs deterministic self-tests without creating snapshots or requesting UAC authorization. The packaged application places the helper in `native/delta-vss.exe`. `DELTA_VSS_HELPER_PATH` can explicitly select a helper for a source build.

## Behavior and scope

The ordinary client requests administrator authorization through UAC and authenticates the returned helper. Communication is local and bounded; requests identify validated volumes and permitted lease operations. File contents do not cross the privileged protocol. A persistent desktop session can reuse its authorized helper for later leases; shutdown, cancellation or lost heartbeats end the session.

Snapshot-only uses `VSS_CTX_FILE_SHARE_BACKUP`. Writers mode uses non-component `VSS_CTX_BACKUP` with `VSS_BT_COPY`, requires explicit copy support from writers, and checks status before and after the operation. Successful completion calls `BackupComplete`; failure or cancellation aborts the operation. This does not implement application component selection, database-specific restore or system-state backup.

The helper deletes only its own exact snapshot objects and verifies cleanup. The ordinary scanner follows links only within volumes already covered by the lease. An uncovered volume is not added automatically, and an inaccessible source cannot be made readable through the helper.

Native build and self-tests do not establish that UAC, ordinary-user snapshot-device access, all installed writers and persistent packaged sessions work on a particular Windows system. Validate the intended source layout and account before relying on VSS for important data. User-facing settings and limitations are described in [Source snapshots](../../docs/source-snapshots.md).
