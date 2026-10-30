# Configuration

Delta has application preferences, global task defaults and local task settings. The desktop interface writes the same JSON files that can be edited by hand. The current preproduction format has no migration or alias layer for older formats.

## Files and locations

```text
~/.delta/
  config.json
  tasks.json
  styles.css

Documents backup/
  .delta.json
  YYYYMMDDHHmmSSffffff.zip
```

`~` means the user's home directory on every operating system. Global `config.json` has `application` and `task` sections. `tasks.json` contains only remembered task directories, not paths to their `.delta.json` files or copies of their settings. For example:

```json
[
  "/backups/Documents",
  "/backups/Photos"
]
```

A task is the whole directory containing `.delta.json` and its snapshot ZIPs. Each ZIP contains `.snapshot.json`; the [backup format](backup-format.md) describes its fields and restoration dependencies. Forgetting a task removes its registry entry without deleting its directory.

Application runtime files and the Electron profile are separate from `~/.delta`. They use `%LOCALAPPDATA%/Delta Backupper` on Windows, `~/Library/Application Support/DeltaBackupper` on macOS, or `$XDG_STATE_HOME/delta-backupper` on Linux, falling back to `~/.local/state/delta-backupper`. Separate configuration directories have separate runtime profiles.

## Defaults and saving

Missing settings inherit in this order: built-in values, global `task` defaults, then explicit local task values. Nested objects inherit missing fields; arrays replace the inherited array as a whole. Explicit `false`, `0` and empty arrays remain explicit values. Invalid values are errors rather than requests for a default.

Creating a task writes a complete set of task settings. Changing Task defaults does not replace explicit values in existing tasks. A missing field can inherit a newer default when next read; saving writes the resulting settings. Sources and source filters are local to each task and cannot be placed in Task defaults.

Saving task settings preserves its history, file checkpoint and pinned snapshots. A running operation keeps the settings it started with. Concurrent edits can produce a save conflict; refresh and review the current values before saving again.

Use `/` in configuration paths and filter patterns on every platform; the Windows interface can display `\`. Unicode is stored directly in UTF-8 JSON rather than escaped to ASCII. Regular-expression escapes such as `\d` retain their meaning. On POSIX, a literal backslash in an actual filename remains part of that filename.

## Global config.json

This partial example uses the built-in defaults for omitted fields:

```json
{
  "schemaVersion": 1,
  "application": {
    "themeFamily": "one",
    "theme": "system",
    "language": "en",
    "schedulerPaused": false,
    "updates": {
      "repository": "",
      "checkOnStartup": false,
      "includePrereleases": false
    }
  },
  "task": {
    "workingDirectory": "",
    "pathMode": 0,
    "schedulesPaused": false,
    "schedules": [],
    "sequence": "F",
    "archive": {
      "level": 6
    },
    "detection": "fast"
  }
}
```

| Application key | Values and default |
| --- | --- |
| `themeFamily` | `one` or `aura`; default `one`. |
| `theme` | `system`, `light` or `dark`; default `system`. |
| `language` | `en`; the interface is currently English only. |
| `closeToTray` | Keep running when the window closes and a tray is available; default `true`. |
| `launchAtLogin` | Start on user login; default `false`. |
| `notifications` | Submit system notifications for results; default `true`. System permissions still apply. |
| `schedulerPaused` | Pause scheduled backups globally without cancelling active work; default `false`. |
| `maxConcurrentTasks` | Concurrent task limit, 1–64; default 1. |
| `updates.repository` | Public GitHub `owner/repository`; empty by default, which makes no update requests. |
| `updates.checkOnStartup` | Check when the application starts; default `false`. |
| `updates.includePrereleases` | Include published prereleases; default `false`. |

The interface applies theme changes when saved. User CSS in `~/.delta/styles.css` loads after the theme and reloads when changed. Update checks only offer a release-page link; they do not download or install updates. An empty release list is normal before the first published release.

## Local task settings

The main `.delta.json` stores `name`, `workingDirectory`, `backupDirectory`, `sources`, `pathMode`, `history`, `files` and task policies. The directory containing the opened `.delta.json` is the actual backup destination; changing `backupDirectory` by hand does not move the task or its archives. Move the directory as a unit and use Relink destination to remember its new location.

| Task key | Meaning and built-in default |
| --- | --- |
| `workingDirectory` | Base for relative sources. An empty default resolves to the destination when the task is created. |
| `pathMode` | `0`: relative to each source; `1`: include configured source path; `2`: include resolved absolute source path. Drive letters and leading separators are removed from ZIP names. Default 0. |
| `sources` | Task-specific source files or folders; at least one is needed to run a backup. |
| `sourceFilters` | Optional per-source Include/Exclude rules, keyed by source path. |
| `schedulesPaused` | Pause this task's schedules while keeping manual actions available; default `false`. |
| `schedules` | Independent automatic trigger rules; default `[]`, meaning manual operation. |
| `sequence` | A string starting with `F` and containing `F`, `I` or `D`; default `"F"`. Additional `F` letters are allowed. |
| `retention` | `when`: `before` or `after` (default `after`); `keepCycles` and `maxAgeDays`: nonnegative limits, default 0 for unlimited; `protectPinned`: default `true`. |
| `archive.level` | 0–9; 0 selects STORE, 1–9 selects DEFLATE, default 6. No separate compression-method or archive-splitting setting. |
| `detection` | `fast` compares modification time and size; `hash` reads content and calculates SHA-256. Default `fast`. |
| `symlinks` | `follow` copies target contents with loop detection; `skip` omits links. Default `follow`; link objects are not preserved. |
| `snapshot` | `mode`: `off`, `snapshot-only` or `writers`; `fallback`: `fail` or `live`; `lvmCowSizeBytes`: classic LVM snapshot space. Defaults: `off`, `fail`, 8 GiB. See [source snapshots](source-snapshots.md). |
| `behavior` | `continueOnFileError`: default `true`; `retryCount`: 0–100, default 0; `resume`: allow restarting interrupted backups, default `true`. |

The sequence position uses the current retained history count modulo the sequence length; there is no separate sequence cursor. Full and incremental backups update `files`; differential backups keep the comparison checkpoint unchanged. Altering history or running retention can therefore change the next requested type.

## Sources and filters

A source can be a path string or a tuple `[path, glob, excludeRegex]`. For example, `["../Documents", ["../Photos", "**/*.jpg", "private/.*"]]` selects a document source and JPEGs from another source. The tuple glob defaults to `**`; its Python-style selection excludes dot-prefixed components unless explicitly matched. The optional expression excludes a relative path when it matches the whole path; expressions use JavaScript regular-expression syntax, so Python-only constructs are not supported automatically.

The UI edits source paths and their additional Include/Exclude rules as individual rows. Choose Add source or Add filter to open a row; **×** removes it. A filter row's **+ / −** control selects Include or Exclude. Patterns are relative to that source. An empty Include list adds no further restriction, while Exclude takes precedence and can prune matching directories. Supported GUI pattern operators are `*`, `**` and `?`; use `/` as the separator. For example:

```json
{
  "sources": ["../Documents"],
  "sourceFilters": {
    "../Documents": {
      "include": ["**/*.pdf"],
      "exclude": ["temporary/**"]
    }
  }
}
```

This is an excerpt of a task file, not a complete task definition. Empty sourceFilters is omitted when saved. Source paths have no extra name or persistent ID. With pathMode 0, different sources can produce the same archived file path; such collisions are reported rather than silently merged. Shared directory entries are allowed.

## Schedules

Each rule has `name`, `paused`, `kind`, `intervalMinutes`, `time`, `weekdays`, `timeZone`, `missed` and `onDestinationAvailable`. Kind is `manual`, `interval`, `daily` or `weekly`; the rule stores all fields even when some do not apply. Weekdays use 1 for Monday through 7 for Sunday; times use `HH:mm` and an IANA time zone. Missed deadlines can `run-once` or `skip`. The optional reconnect trigger runs a current backup when the destination becomes available again.

A rule's `paused` flag, the task's `schedulesPaused` and the application's `schedulerPaused` have separate scopes. They suppress future automatic starts and leave active or manual operations available. Daily and weekly schedules skip nonexistent daylight-saving times and run a repeated wall-clock occurrence only once. Keep the application running for schedules to execute.

## Changing existing tasks

All valid task settings can be changed. Unsafe change colors and tooltips explain consequences rather than blocking Save. Potentially unsafe editors use a warning border and background immediately on focus; a meaningful unsafe edit stays marked after focus leaves. Unchanged fields return to normal after blur. New drafts and Task defaults do not warn about changing an existing task.

| Setting | Effect to consider |
| --- | --- |
| Name | Display only; no effect on archives or the checkpoint. |
| Working directory | May redirect relative sources to different physical files under the same archived names. Check the resolved paths and make a full backup when retargeting existing names. |
| Paths in ZIP archives | Changes future archive names. A full backup is recommended to establish the new layout; old snapshots keep their original paths. |
| Add, remove or edit sources | Changes future coverage. Removed content remains in retained old snapshots. Retargeting a path under an existing archived name warrants a full backup; adding a distinct source normally does not. |
| Source order | Distinct archived paths stay unchanged. Duplicate file paths are errors, rather than a last-source-wins rule; shared directory entries are allowed. |
| Tuple glob, exclude expression and GUI filters | Changes future selection without rewriting older snapshots. Newly included paths are normally copied automatically; excluding paths does not erase old archives. |
| Follow or skip links | Changes whether future backups contain target contents. Existing snapshots remain readable. |
| Change detection | Different fingerprint representations normally cause all selected files to be read and stored again in the next backup. Fast detection can miss changes preserving size and modification time. |
| Sequence | Can immediately change the next requested type; saving does not reset history or sequence position. |
| Schedules, rule names and schedule pauses | Changes automatic triggering, not stored file versions. Editing or reordering rules can recompute upcoming deadlines. |
| Cleanup before backup | Eligible older archives can be removed before the new backup succeeds. Saving the setting itself performs no cleanup. |
| Keep cycles, maximum age and pinned protection | Stricter limits or disabling pin protection can permanently delete eligible archives at the next cleanup. Dependencies remain protected. |
| Compression level | Changes future CPU work and archive size; it does not require a full backup or change old archives. |
| Source snapshot mode and fallback | Disabling snapshots or permitting live fallback can reduce read consistency. VSS writers are Windows-only. |
| LVM snapshot space | A smaller copy-on-write reserve can fill during backup and invalidate a classic LVM snapshot; it does not change the ZIP size limit. |
| Continue after file errors | Can allow an incomplete snapshot to be saved. Review missing versions; failed file versions are not accepted into the comparison checkpoint. |
| Retry count and restart permission | Changes retry behavior and runtime. Restart creates a new ZIP after scanning; it does not continue an unfinished archive in place. |
| Backup directory | Editing its JSON field does not relocate anything; the opened task directory remains the destination. |

Existing snapshot paths and fingerprints are interpreted from those snapshots, not from today's working directory, sources or path mode. Changing settings therefore does not itself make earlier snapshots unreadable. Retention and Remove differ because they can physically delete archives.

Validation failures use the notification together with a red field border and background. The error marking disappears when its notification expires, is replaced or is dismissed, and takes priority over Unsafe change colors.
