import { mkdir, readFile, unlink, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Freedesktop autostart is per-user; no shell command or system service. */
export async function setLinuxAutostart(enabled: boolean, executable: string, configDirectory: string, options: { directory?: string } = {}) {
  if (![executable, configDirectory].every(value => path.isAbsolute(value) && !/[\0\r\n]/.test(value))) throw new Error("Invalid autostart path");
  const directory = options.directory ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"), "autostart");
  const filename = path.join(directory, "delta-backupper.desktop");
  try { const current = await readFile(filename, "utf8"); if (!current.includes("X-Delta-Backupper=true")) throw new Error("Autostart filename is owned by another application"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!enabled) { await unlink(filename).catch(error => { if (error.code !== "ENOENT") throw error; }); return; }
  const quote = (value: string) => `"${value.replace(/%/g, "%%").replace(/[\\"`$]/g, "\\$&")}"`;
  const contents = `[Desktop Entry]\nType=Application\nName=Delta Backupper\nExec=${quote(executable)} ${quote(`--delta-config-dir=${configDirectory}`)}\nTerminal=false\nX-Delta-Backupper=true\n`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
  try { await rename(temporary, filename); } finally { await unlink(temporary).catch(() => {}); }
}
