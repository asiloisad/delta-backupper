# Delta Backupper

Create and restore file backups with transparent ZIP archives.

Delta Backupper is a desktop application and command-line tool for local file backups. Its Electron interface and standalone `delta` CLI share the same backup engine. It does not require Python or Lumine.

## Features

- Multiple file or folder sources, with separate Include/Exclude filters, in one backup destination per task.
- Full, incremental and differential backups, configurable sequences, compression levels, retention and pinned snapshots.
- One ordinary ZIP/ZIP64 archive per snapshot, with readable UTF-8 JSON metadata and Unicode filenames.
- Backup history, verification, restore previews and restoration of complete snapshots or selected files through the interface or CLI.
- Multiple schedules per task, schedule pauses, operation Pause/Resume, cancellation, progress estimates, tray controls and system notifications.
- Optional source snapshots through Windows VSS, Linux Btrfs/ZFS/classic LVM and macOS APFS, subject to filesystem support, permissions and platform qualification.

## Run from source

Use Node.js **24.22.1** and npm. The supported Node range is `>=24.22.1 <25`; dependency versions are pinned in the lockfile.

```sh
npm ci
npm run setup:runtime
npm start
```

`setup:runtime` installs the Electron runtime for the current platform. `npm start` builds the application before opening it in development mode. Closing the window leaves the application running in the tray; choose **Quit** there to stop it.

## Tasks and configuration

A task is a directory containing its configuration and snapshot archives:

```text
Documents backup/
  .delta.json
  20261030183000123456.zip
  20261031183000123456.zip
```

Each archive contains its own `.snapshot.json`. The task's `.delta.json` stores settings, ordered history and the file checkpoint used to detect changes. Full snapshots contain all selected files; incremental and differential snapshots may require earlier archives to restore the selected state. The restore interface resolves those dependencies. Archives are neither encrypted nor split into parts.

Global preferences live in `~/.delta/config.json`, under `application` and `task`. `~/.delta/tasks.json` is a list of remembered task directories, and `~/.delta/styles.css` customizes the interface. Task settings remain in the task directory; application runtime data uses the operating system's application-data location. Saved paths and filter separators use `/` on every platform.

See [configuration](docs/configuration.md) and the [backup format](docs/backup-format.md) for details.

## Command line

The CLI supports task creation and execution, status, history, verification, restore, retention and schedule control without opening the window. Run the built source CLI with Node:

```sh
npm run build
node .dev/build/cli.cjs --help
node .dev/build/cli.cjs history "./Documents backup"
node .dev/build/cli.cjs verify "./Documents backup"
node .dev/build/cli.cjs restore "./Documents backup" --to "./Restored documents" --dry-run
```

Replace the example task directory with an existing task. Remove `--dry-run` to restore files; the default collision policy refuses to overwrite existing files. Packaged builds provide the standalone `delta` command with its own runtime. The [user guide](docs/user-guide.md) documents the available commands and recovery workflow.

## Documentation

- [User guide](docs/user-guide.md) — interface, CLI and recovery.
- [Configuration](docs/configuration.md) and [backup format](docs/backup-format.md) — settings and files on disk.
- [Source snapshots](docs/source-snapshots.md) — supported filesystems, permissions and limitations.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
