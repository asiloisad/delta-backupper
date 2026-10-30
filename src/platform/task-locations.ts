import path from "node:path";
import { lstat } from "node:fs/promises";
import { ConfigurationStore } from "../config/index.js";
import { directoryIdentity, requireDirectoryIdentity } from "../config/files.js";

export interface TaskLocationLaunchers { textFile(filename: string): Promise<void>; folder(directory: string): Promise<string> }

/** Resolve a remembered task directory to its file. Broken task files can still be opened for repair. */
export async function openTaskLocation(store: ConfigurationStore, reference: unknown, kind: "file" | "folder", launchers: TaskLocationLaunchers): Promise<{ opened: true }> {
  if (typeof reference !== "string" || !reference || reference.includes("\0")) throw new Error("Select a remembered task before opening its files");
  const entry = await store.findRememberedTask(reference);
  if (!entry) throw new Error("The task is no longer remembered. Refresh the task list.");
  const directory = path.dirname(entry), identity = await directoryIdentity(directory);
  const filename = path.join(identity.realPath, ".delta.json");
  if (kind === "file") {
    let info;
    try { info = await lstat(filename); } catch (error) { throw new Error(`The task file is unavailable: ${error instanceof Error ? error.message : String(error)}`); }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("The task file must be an ordinary file, not a symbolic link or directory");
  }
  await requireDirectoryIdentity(directory, identity);
  if (kind === "file") await launchers.textFile(filename);
  else { const error = await launchers.folder(identity.realPath); if (error) throw new Error(`The backup folder could not be opened: ${error}`); }
  return { opened: true };
}
