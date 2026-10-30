# User guide

Delta Backupper creates file backups in ordinary ZIP/ZIP64 archives and restores a selected snapshot through the desktop interface or the `delta` CLI. The application is in preproduction; only the current configuration and archive format is supported.

## Create and find tasks

Home summarizes recent results and current operations. Use **New task** in the sidebar to open a draft, enter a name and an existing destination directory, then add at least one source file or folder. **Create task** saves the task and opens Overview; **Cancel draft** returns to Home without creating it. A missing destination is reported instead of silently creating a local replacement for an unavailable USB drive or NAS.

A task is its entire directory: `.delta.json` and the timestamped snapshot ZIPs beside it. Each task has one destination and independent settings and history. To back up the same sources to two destinations, create two tasks. **Manage → Duplicate** opens a prefilled draft; choose another destination and press Create task to save an independent task with empty history.

**Discover existing** remembers a task directory. **Manage → Relink destination** finds a task after its drive letter or mount point changes. **Forget task** removes only the remembered entry; it keeps the directory and every backup. The registry stores task directory paths rather than copies of task settings.

## Configure a task

New drafts, Settings and Task defaults use the same controls for shared options. Sources and their filters belong to individual tasks. **Task defaults** supplies values when a task is created, while **Application settings** controls the application itself. Save actions stay in the page header.

**File paths** contains Working directory and Paths in ZIP archives. Relative sources resolve from the working directory; an empty value uses the destination directory. Archive paths can be relative to each source, include the configured source path, or include the absolute source path with the drive and leading separators removed. Choose distinct file paths for different sources: duplicate file names at the same archive path are reported as a collision.

Use **Add source** to open a source row, the picker button to select a path, and **×** to remove it. Under a source, **Add filter** opens one pattern editor; **+** means Include and **−** means Exclude. Patterns are relative to that source and use `/` separators. Exclude wins over Include; an empty Include list adds no restriction beyond the source's other selection rules. Blank rows appear only when requested. Escape cancels a blank row.

The default sequence is `F`; `F`, `I` and `D` mean full, incremental and differential. The first letter must be `F`, and more than one `F` is allowed, for example `FFI` or `FIIFII`. The retained history determines the next position, so removing snapshots can affect the next backup type. Full and incremental backups update the comparison checkpoint; differential backups leave it unchanged.

**Fast** detection compares size and modification time. **Thorough** reads and hashes content, including files that appear unchanged. Compression uses one level: **0** stores without compression and **1–9** uses DEFLATE; the default is **6**. Each snapshot remains one ZIP, without encryption or splitting.

Existing-task fields that can affect future backups use **Unsafe change** colors on focus and keep that border and background when an edit needs attention. Their tooltips explain the effect; Save remains available. Old snapshots retain their own paths and fingerprints. See [configuration](configuration.md#changing-existing-tasks) for the effects of each setting.

## Run, pause and schedule backups

Select **Overview → Run backup** to start. **Open backup folder**, also in Overview, opens the task directory. Home, Overview and Activity show current phases, counters and progress; elapsed and estimated times appear when enough progress is available.

**Pause** beside Cancel changes to **Resume** and controls the same running backup. The engine pauses at a safe boundary, so some current work may finish first. Cancel also works while paused. Restarting an interrupted backup is different: Resume/Retry scans sources again and creates a new ZIP rather than appending to an unfinished archive.

A task can have multiple interval, daily or weekly schedules with their own time zone, missed-run policy and optional destination-reconnect trigger. With the built-in defaults, a new task has no schedules. A rule's **Paused** option affects that rule; the task's **Pause schedules** affects all its rules; the application's **Pause scheduled backups** affects every task. These pauses do not cancel active operations or prevent manual backups. Concurrent due rules for one task are combined into one request.

Keep Delta running for its scheduler to execute backups. By default, closing the window leaves it in the tray when a tray is available. The tray menu opens the window, controls operations and scheduling, and provides **Quit**. Hovering the tray icon shows current progress; the menu itself remains a plain action list. Application settings also controls launch at login, concurrent tasks and notifications. System notification delivery depends on operating-system permissions and Do Not Disturb; use **Test notification** to check it.

## History, verification and cleanup

History lists committed snapshots and their results. Run details reports files, bytes and missing versions. A recoverable file error can produce an **incomplete** snapshot; missing file versions remain reported and are eligible for a later retry. Native source snapshots are optional and have platform-specific requirements described in [source snapshots](source-snapshots.md).

Use **Verify** to check archived data. **Pin** protects a selected snapshot when protection is enabled. **Remove** permanently deletes that snapshot and its ZIP after confirmation; unpin it first. Delta refuses to remove an archive needed by another retained snapshot. Manual removal is unavailable while that task has an active operation.

Retention runs before or after backup, or through **Manage → Run retention now…**. Limits can retain recent full-snapshot cycles, cycles within an age window, and pinned points. Zero disables a count or age limit. When both limits are set, protection by either limit is sufficient; required dependencies and incomplete cycles are also retained. Saving a retention policy does not itself delete files. Before-backup cleanup can delete eligible archives even if the new backup later fails.

## Restore

Open **Restore**, select a snapshot, browse its archived paths, and choose all files or a subset. Choose an output directory and review the preview before starting. The preview checks metadata, required archives and output collisions; it does not verify file contents or create the output directory. Actual restore repeats the checks and verifies the data it reads.

The default collision policy is **error**. **Skip** keeps existing files, and **Replace** explicitly allows replacement. Delta rejects unsafe paths and does not follow an output symlink or junction outside the chosen directory. Unresolved versions are reported rather than replaced with unrelated contents.

Restore begins with the selected snapshot's file map and searches earlier archives for matching stored versions. Keep the task directory and all required history together. A normal ZIP reader can extract individual stored files manually, but an incremental ZIP alone may not contain the whole selected state. The [backup format](backup-format.md) describes this layout.

## Command line

Packaged builds provide `delta` with its own runtime. Run `delta --help` for the full command list. A task reference is its directory or an unambiguous remembered name.

The example source and destination directories must already exist:

```sh
delta task create --name Documents --destination "./Documents backup" --source "./Documents"
delta task run "./Documents backup"
delta history "./Documents backup"
delta verify "./Documents backup"
delta restore "./Documents backup" --to "./Restored documents" --dry-run
delta restore "./Documents backup" --to "./Restored documents"
```

Use `--run RUN_ID` to select a history entry; verify and restore otherwise choose the latest committed entry. Repeated `--path ARCHIVE/PATH` arguments select archived paths, without a source-ID prefix. `--overwrite error|skip|replace` selects the collision policy, and `--json` produces machine-readable results.

```sh
delta scheduler status
delta scheduler pause
delta scheduler resume
delta task pause "./Documents backup"
delta task resume-operation "./Documents backup"
delta task cancel "./Documents backup"
delta task resume "./Documents backup" --run RUN_ID
delta task retry "./Documents backup" --run RUN_ID
delta pin "./Documents backup" --run RUN_ID
delta pin "./Documents backup" --run RUN_ID --unpin
delta retention "./Documents backup"
delta delete "./Documents backup" --run RUN_ID
```

Pause, resume-operation and cancel address an operation in the running desktop coordinator. Ctrl+C cancels a CLI operation. `--config-dir DIRECTORY` selects a separate configuration profile. `task edit TASK --file PATCH.json` changes task settings; `settings app|defaults` reads settings and `--file JSON` writes them. The CLI's `task duplicate TASK --to DIRECTORY` creates the independent task directly; the desktop Duplicate action opens a draft.

| Exit code | Meaning |
| --- | --- |
| 0 | Complete operation or ready restore preview. |
| 1 | Execution failed. |
| 2 | Invalid arguments or configuration. |
| 3 | Destination or coordinator unavailable, or task locked. |
| 4 | Incomplete result or blocked restore preview. |
| 130 | Cancelled. |

An orphaned task lock is not silently taken over. `task status TASK` reports its owner; `unlock TASK --token OWNER_TOKEN` can remove a confirmed stale lock for a dead process on the same host.

## Appearance and updates

**Application settings → Appearance** offers One and Aura, each with System, Light and Dark color modes. One follows Lumine's classic palette; Aura changes surfaces and corners. System follows operating-system appearance. Saving applies the selection without a restart. User rules in `~/.delta/styles.css` load after the theme and reload when the file changes.

Click the title-bar logo to open **About**, then **Check for updates**. Application settings accepts a public GitHub `owner/repository`, optional startup checks and optional prereleases. An empty repository makes no GitHub request. A repository without releases is an expected preproduction state; network errors and rate limits are reported separately. **View release** opens the release page in a browser. Delta does not download or install updates automatically.
