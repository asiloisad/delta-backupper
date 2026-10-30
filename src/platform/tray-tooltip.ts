import type { Operation } from "../service/api.js";

const title = "Delta Backupper";
const count = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
function shorten(value: string, length: number): string {
  if (value.length <= length) return value;
  return `${value.slice(0, Math.max(0, length - 1)).replace(/[\uD800-\uDBFF]$/, "")}…`;
}
function bytes(value: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"]; let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return `${value.toLocaleString("en-GB", { maximumFractionDigits: index ? 1 : 0 })} ${units[index]}`;
}
function progressText(operation: Operation): string[] {
  if (operation.status === "queued") return [operation.paused ? "Paused (queued)" : "Queued"];
  const progress = operation.progress && typeof operation.progress === "object" && !Array.isArray(operation.progress) ? operation.progress as Record<string, unknown> : {}, files = count(progress.completedFiles) ?? count(progress.files), size = count(progress.completedBytes) ?? count(progress.bytes), totalFiles = count(progress.totalFiles), totalBytes = count(progress.totalBytes);
  const ratio = size !== undefined && totalBytes !== undefined && totalBytes > 0 && size <= totalBytes ? size / totalBytes : files !== undefined && totalFiles !== undefined && totalFiles > 0 && files <= totalFiles ? files / totalFiles : undefined;
  const phase = ({ scan: "Scanning", scanning: "Scanning", backup: "Backing up", restore: "Restoring", verify: "Verifying", finalizing: "Finalizing", snapshot: "Preparing snapshot", retention: "Cleaning backups", warning: "Working" } as Record<string, string>)[String(progress.phase)] ?? ({ run: "Backing up", resume: "Backing up", retry: "Retrying", restore: "Restoring", verify: "Verifying", retention: "Cleaning backups" } as Record<string, string>)[operation.action] ?? "Working";
  const state = operation.paused ? `Paused${ratio === undefined ? "" : ` · ${Math.floor(ratio * 100)}%`}` : ratio === undefined ? phase : `${Math.floor(ratio * 100)}%`;
  const fileCount = files === undefined ? "" : `${files.toLocaleString("en-GB")} files`, sizeCount = size === undefined ? "" : bytes(size);
  return [...new Set([[state, fileCount, sizeCount], [state, sizeCount], [state, fileCount], [state]].map(parts => parts.filter(Boolean).join(" · ")))];
}

/** Windows szTip[128] includes its terminating NUL; never split a UTF-16 pair. */
export function createTrayTooltip(tasks: ReadonlyArray<{ id: string; name: string }>, operations: Iterable<Operation>, platform: string = process.platform): string {
  const rank = (operation: Operation) => operation.status === "queued" ? 2 : operation.paused ? 1 : 0;
  const active = [...operations].filter(operation => operation.status === "running" || operation.status === "queued").sort((left, right) => rank(left) - rank(right));
  if (!active.length) return title;
  const limit = platform === "win32" ? 127 : 512, shown = Math.min(active.length, platform === "win32" ? 3 : 8), hidden = active.length - shown;
  const header = active.length === 1 ? title : `${title} — ${active.length} active`, footer = hidden ? `+${hidden} more` : "";
  const budget = Math.floor((limit - header.length - shown - (footer ? footer.length + 1 : 0)) / shown), names = new Map(tasks.map(task => [task.id, task.name]));
  const lines = active.slice(0, shown).map(operation => {
    const name = (names.get(operation.taskId) ?? "Task").toWellFormed().replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim() || "Task";
    const choices = progressText(operation), details = choices.find(value => value.length <= budget - 10) ?? choices.at(-1)!;
    return `${shorten(name, Math.max(1, budget - details.length - 2))}: ${details}`;
  });
  return [header, ...lines, ...(footer ? [footer] : [])].join("\n");
}
