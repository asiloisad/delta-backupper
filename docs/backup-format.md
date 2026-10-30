# Backup format

Delta Backupper uses the simple catalogue, checkpoint and restore model of the earlier delta.py, with full key names and additional task settings. A task is its entire backup directory. Its files remain readable without Delta: JSON stores the catalogue, and ordinary ZIP tools can extract archived content.

## Files in a task

```text
backup/
  .delta.json
  20260115183000123000.zip
  20260116183000123000.zip
```

Each snapshot is exactly one unencrypted ZIP/ZIP64 beside `.delta.json`, with no size-based splitting. New archive names use local time in the form `YYYYMMDDHHmmSSffffff`: 20 digits, including six fractional-second digits. The current clock supplies millisecond precision, with the remaining digits zero-filled. A filename collision never overwrites an existing archive.

Configuration paths, filter separators and ZIP entry paths use `/`. The Windows interface can display backslashes. JSON is UTF-8 and preserves Unicode characters directly, apart from escaping required by JSON syntax. ZIP entry names use UTF-8; ZIP64 extends archive size, entry-count and offset limits.

Only the current `.delta.json` and `.snapshot.json` format is supported. Old filenames, abbreviated keys and previous preproduction formats are not accepted as aliases or migrated automatically.

## Main catalogue: .delta.json

| Key | Meaning |
| --- | --- |
| `workingDirectory` | Base directory for relative source paths. |
| `backupDirectory` | Recorded backup location. Editing this value does not move the task or its archives; backups are written beside the opened `.delta.json`. |
| `sources` | Source paths, or tuples `[path, glob, excludeRegex]`. Optional tuple elements may be omitted. |
| `pathMode` | Layout of paths inside ZIP archives: `0`, `1` or `2`. |
| `history` | ZIP basenames ordered from oldest to newest. |
| `files` | Current checkpoint: archive paths mapped to file fingerprints, or `null` for directories. |

These correspond to delta.py's `wdir`, `proj`, `srcs`, `mode`, `hist` and `data`. There are no task, destination or source IDs and no schema version in the backup control files.

Task settings such as the name, schedules, sequence, retention and compression are stored alongside these fields. `sequence` is a string such as `FII`, with `F` first and any further `F`, `I` or `D` entries; the default is `F`. `archive.level` is the sole compression setting: `0` stores without compression, and `1`–`9` uses DEFLATE. Optional `sourceFilters` stores GUI include/exclude filters by configured source path; optional `pinned` lists protected ZIP basenames. See [Configuration](configuration.md) for task settings.

Fast detection uses a fingerprint of `mtimeNs:size`. Hash detection uses a SHA-256 content fingerprint. Fast comparison can miss a change that preserves both size and modification time. Switching detection changes fingerprint meaning; a full backup establishes a clear new baseline.

## Source selection and archive paths

Relative sources resolve against `workingDirectory`. A source tuple can select files with a glob and exclude relative paths matching the whole regular expression. An absent or empty glob means `**`. Regular expressions use JavaScript syntax; Python-specific expressions are not automatically supported. GUI include/exclude filters belong to each source.

For a configured source `Projects/Example`, working directory `C:/Data` and file `notes.txt`, the layouts are:

| `pathMode` | Archive entry |
| --- | --- |
| `0` | `notes.txt`, relative to the source. |
| `1` | `Projects/Example/notes.txt`, using the configured source path. |
| `2` | `Data/Projects/Example/notes.txt`, using the resolved absolute source path. |

Modes 1 and 2 differ when the configured source is relative. Drive letters and leading separators are removed; paths that still escape the archive root are rejected. Sources have no artificial ID prefixes. If multiple sources produce the same file path, the backup fails explicitly; choose another layout or separate tasks. `.snapshot.json` is reserved for metadata. Symbolic links can be followed or skipped; the format does not preserve them as separate link objects.

## Snapshot metadata: .snapshot.json

Each ZIP contains its archived files and exactly one `.snapshot.json` with nine fields:

| Key | Meaning |
| --- | --- |
| `startedAt` | Local start timestamp, `YYYY-MM-DD HH:mm:ss.ffffff`, without a timezone offset. |
| `finishedAt` | Local finish timestamp in the same form, or `null`. |
| `compressionLevel` | Compression level used. |
| `full` | Whether a full backup was requested or this ZIP stores all observed versions. Check `errors` too: this flag alone does not prove a complete backup. |
| `totalBytes` | Total uncompressed size of the observed file set. |
| `storedBytes` | Uncompressed size of files written to this ZIP. |
| `files` | Desired snapshot state: archive paths to fingerprints, with `null` for directories. |
| `archivedFiles` | Paths and fingerprints successfully written to this ZIP. |
| `errors` | Failed archive paths mapped to their original source paths. |

These correspond to delta.py's `time`, `ends`, `comp`, `full`, `size`, `sizx`, `data`, `lock` and `errs`. A snapshot does not contain task settings, IDs or a copy of the main catalogue. It belongs to the surrounding task directory and its history.

## Full, incremental and differential copies

- Full (`F`) writes all selected entries and replaces the checkpoint in `.delta.json`.
- Incremental (`I`) compares against that checkpoint, writes changed entries and replaces the checkpoint.
- Differential (`D`) compares against the checkpoint and writes changes without replacing it. After an incremental, a differential therefore compares against that incremental's checkpoint, following delta.py.

The first backup is full. Later runs follow the sequence using the current history length modulo its length; a recorded incomplete snapshot also counts. Removal and retention can therefore change the next position. Backup types and cycles shown in history are derived from the `full` flag, history order and current sequence, rather than a separate stored type field.

When the task continues after a file error, `errors` records the failed source path. A failed observed version is excluded from the main checkpoint, so a later incremental retries it even if its fingerprint is unchanged. A failure before the file can be inspected may leave no fingerprint for that path. Check errors as well as the file map when assessing coverage.

## Restore and manual extraction

Restore starts with the selected snapshot's `files` map and walks history backwards through that point. A file is taken from a ZIP whose `archivedFiles` contains the same path and fingerprint. Directories marked `null` need no archived content. Paths absent from the selected snapshot are not brought back from older snapshots. A missing version is reported explicitly instead of being replaced with a different version.

Verification and restore check ZIP CRCs and sizes, and SHA-256 fingerprints when present. The restore destination must not overlap the backup directory. Existing-file policies are explicit: `error`, `skip` or `replace`. A preview checks metadata, required archives and destination conditions; actual content verification happens during restore.

An ordinary ZIP tool can extract individual entries. A full snapshot can usually be extracted on its own; an incremental or differential restore may need several earlier ZIPs. Copying every archive over the same folder in order can leave files deleted from a later snapshot. Use its `files` map, or Delta's restore action, to reconstruct the selected state accurately.

## Retention and incomplete operations

Retention runs before or after a backup according to the task settings. Cycle and age limits select older copies for removal; a cycle begins at a snapshot marked full. Incomplete runs, applicable pins and file versions required by retained snapshots protect archives from automatic deletion. Manual Remove also checks pins and dependencies. Removal updates history and the checkpoint without renaming surviving ZIPs.

Keep `.delta.json` and all archives needed by retained restore points together when moving or copying a task. Settings changes preserve history, file maps and pins. Avoid manually deleting an archive merely because it is old: a newer snapshot may still need it.

Pause and Resume control the same running operation. After cancellation or a process failure, resuming scans current sources and creates a new ZIP; it does not continue a partial ZIP at its former byte offset. Partial files and locks are not restore points. Source-snapshot consistency is not an extra persisted attestation in this metadata format; see [Source snapshots](source-snapshots.md) for its scope and limitations.
