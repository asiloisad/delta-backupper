import path from "node:path";

type OpenPath = (filename: string) => Promise<string>;

/** Open the original file through its OS association without copying or changing it. */
export async function openExternalTextFile(filename: string, openPath: OpenPath): Promise<void> {
  if (!path.isAbsolute(filename) || filename.includes("\0")) throw new Error("The task file path must be absolute");
  const error = await openPath(filename);
  if (error) throw new Error(`The task file could not be opened: ${error}`);
}
