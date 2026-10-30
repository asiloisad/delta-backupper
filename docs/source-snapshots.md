# Source snapshots

Source snapshots provide a stable filesystem view while Delta reads files. The resulting backup is still an ordinary ZIP. Availability depends on your filesystem, installed system tools, permissions and mount layout. A filesystem snapshot does not automatically make a running database or application consistent.

## Available backends

| Platform | Mechanism | Limitations |
| --- | --- | --- |
| Windows | VSS, with optional VSS writers. | Supported local volumes. Writers coordinate participating applications; this is not a system image or component-aware application restore. |
| Linux: Btrfs | Read-only subvolume snapshots. | Nested subvolumes need separate snapshots; several snapshots are not one atomic set. |
| Linux: ZFS | Dataset snapshots protected by holds. | An eligible set in one pool can be atomic; separate pools cannot form one atomic set. |
| Linux: classic LVM with ext4 or XFS | COW logical-volume snapshots mounted read-only. | Thin pools are unsupported. Available COW space must cover origin-volume changes during the backup. |
| macOS: writable local APFS | Native APFS snapshots with separate read-only mounts. | The snapshot API may require an Apple-authorized entitlement. Independent volume snapshots are not one atomic set. |
| Other filesystems or unsupported network/mount layouts | No automatic snapshot backend. | Preparation fails unless an explicitly selected live fallback can be used safely. |

Linux and macOS do not provide Delta's VSS writers mode. Select filesystem snapshots on those systems. Application data may still require an application-specific export, shutdown or other coordination. A set of independently created snapshots can capture different moments even when each individual filesystem view is stable.

Linux and macOS snapshot support has not yet been verified on those native systems in this preproduction application. Windows support also depends on successful authorization, ordinary-user access to the snapshot and the writers installed on the particular computer. Treat snapshot availability as a property of your own machine and source layout, not a guarantee from selecting the option.

## Settings

Source snapshots are configured separately for each task and are also available in Task defaults:

```json
{
  "snapshot": {
    "mode": "snapshot-only",
    "fallback": "fail",
    "lvmCowSizeBytes": 8589934592
  }
}
```

- `mode`: `off`, `snapshot-only` or `writers`. The default is `off`.
- `fallback`: `fail` or `live`. The default, `fail`, requires a successful snapshot. `live` permits ordinary file-by-file reads after a snapshot preparation failure only if cleanup has been confirmed.
- `lvmCowSizeBytes`: COW reserve for classic LVM snapshots, from 256 MiB to 1 TiB; the default is 8 GiB. This is neither the ZIP size nor a limit on backed-up files. Btrfs, ZFS and APFS do not use this reserve.

Cancellation and unconfirmed cleanup never trigger live fallback. Switching to live reads changes the consistency of the operation; files can change between reads. The nine-field `.snapshot.json` does not store a separate certificate of the snapshot backend or atomicity used. See [Backup format](backup-format.md) for the metadata retained in each ZIP.

## Permissions

Run Delta as your normal user. A separately authorized helper creates and removes source snapshots; the ordinary worker still reads files under your existing permissions. Snapshot mode does not grant access to files your account cannot read.

On Windows, the first VSS operation requests administrator authorization through UAC. A running desktop session can reuse its authorized helper for later operations, but cancellation or failure may require authorization again. Writers mode requires participating writers to explicitly support the copy operation; it does not silently substitute a full application backup.

On Linux, the GUI needs `pkexec` and a working polkit authentication agent. An interactive CLI can use `sudo`. Install the appropriate Btrfs, ZFS, LVM and mount utilities using your distribution's package manager. An unattended session without an available authorization method fails; Delta does not modify sudoers or install a root service automatically.

On macOS, the helper requests system administrator authorization. Some macOS versions also require an Apple-authorized snapshot entitlement; administrator rights and Full Disk Access do not grant that entitlement. An unsupported or unauthorized helper reports the limitation instead of bypassing it. Your ordinary account must also have filesystem permissions and any macOS privacy access, including Full Disk Access where required.

## Links, mounted volumes and cleanup

Followed symbolic links stay within filesystems covered by the prepared snapshots. A link into a different, uncovered filesystem cannot silently read its live files as snapshot data. Select a source on that filesystem when it also needs coverage. Unsupported or unselected nested mounts can cause an explicit error rather than being treated as empty, successfully copied folders.

Delta checks snapshot health while reading and before accepting the backup. An exhausted or lost LVM snapshot cannot be treated as a healthy source view. Completion, cancellation and disconnection release the snapshots and mounts created for the operation.

If a helper stops unexpectedly, a later attempt checks its recorded objects before preparing a new snapshot. Cleanup is limited to exact objects belonging to Delta's interrupted operation. Busy mounts, missing disks, changed objects or uncertain ownership can require administrator attention. Delta does not force an unmount or remove unrelated snapshots, including Time Machine snapshots. An unconfirmed cleanup is an error even when live fallback was selected.

For files that need application-level recovery guarantees, follow that application's backup procedure in addition to filesystem snapshots. Delta does not preserve a complete system image, application restore components or every platform-specific filesystem feature.
