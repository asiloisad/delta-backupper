# macOS APFS helper

The native helper creates, mounts and releases APFS snapshots owned by its current operation. Delta and its backup worker remain ordinary-user processes; file contents never cross the privileged protocol.

## Build

On macOS with Xcode command-line tools installed, run from the repository root:

```sh
node native/macos/Build-Snapshot.mjs
```

The build writes `delta-snapshot`, a log and a manifest to `.dev/native/macos`, then runs deterministic parser, recovery-journal and source-link metadata self-tests without creating snapshots or displaying administrator authorization. The helper uses Objective-C++, Foundation and public process metadata APIs. Building these sources on another operating system is not supported.

The helper is signed ad hoc by default, without adding snapshot entitlements. An authorized build can supply `DELTA_MACOS_SIGNING_IDENTITY` and `DELTA_MACOS_SNAPSHOT_ENTITLEMENTS`. Supplying those variables does not grant Apple's authorization. Where macOS requires an authorized snapshot entitlement, root, administrator consent and Full Disk Access alone are insufficient; the helper can report `SNAPSHOT_PERMISSION_OR_ENTITLEMENT`. There is no entitlement bypass or use of Time Machine-owned snapshots.

## Behavior and scope

The helper accepts a private local socket, a nonce and the caller's user/group identity, verifies the peer and accepts bounded snapshot operations. It exposes no arbitrary shell command, root file-read or privileged restore operation. Cancellation waits for an in-progress kernel operation to settle where necessary.

Sources must be on writable local APFS volumes. The helper maps selected volumes and supported APFS Data-volume firmlinks; unselected nested mounts and followed links requiring another unleased filesystem fail explicitly. Snapshot reads retain normal filesystem ownership and permissions. Delta does not enable ignore-ownership or change source ACLs; workers still require the user's filesystem and privacy access.

Each volume snapshot provides a stable filesystem view, but independently created volume snapshots are not one atomic set. APFS does not provide VSS writer coordination, and `writers` mode is unsupported.

Cleanup verifies the original volume and mount identity, unmounts only exact owned mounts without force, deletes exact owned snapshot names and confirms their absence. Root-owned recovery journals in `/private/var/db/delta-backupper/snapshots` allow a later helper to inspect interrupted operations. Missing disks, foreign or busy mounts and ambiguous recovery block further preparation rather than deleting unrelated objects.

This backend has not been compiled or qualified natively in the Windows development environment. Parser tests do not establish snapshot entitlement access, administrator authorization, ordinary-user reads, durable journal behavior or cleanup after process failure and reboot on macOS. User-facing requirements and limitations are described in [Source snapshots](../../docs/source-snapshots.md).
