import { watch, type FSWatcher } from "node:fs";
import { mkdir, lstat, open } from "node:fs/promises";
import path from "node:path";

const MAX_BYTES = 1024 * 1024;
const TEMPLATE = "/* Delta Backupper — user interface styles.\n * This file is loaded after the application stylesheet and reloaded when saved.\n * Example: :root { --accent: #34745a; }\n */\n";
export interface UserStylesOptions {
  directory: string;
  onStyles(css: string): void | Promise<void>;
  onError(error: Error): void;
}

/** Loads user CSS as data only; no JavaScript, startup hooks or keymap files are created. */
export async function startUserStyles(options: UserStylesOptions): Promise<{ close(): void; reload(): Promise<void> }> {
  const directory = path.resolve(options.directory), filename = path.join(directory, "styles.css");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let closed = false, watcher: FSWatcher | undefined, debounce: ReturnType<typeof setTimeout> | undefined;
  let lastApplied: string | undefined, lastSignature: string | undefined, loading: Promise<void> | undefined, rerun = false, lastError: string | undefined;
  const report = (error: unknown) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (!closed && normalized.message !== lastError) { lastError = normalized.message; try { options.onError(normalized); } catch { /* A reporting callback must not crash a watcher. */ } }
  };
  try {
    const handle = await open(filename, "wx", 0o600);
    try { await handle.writeFile(TEMPLATE, "utf8"); await handle.sync(); } finally { await handle.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") report(error); }
  async function signature(): Promise<string> {
    try { const value = await lstat(filename, { bigint: true }); return `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.mode}`; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; }
  }
  async function readStyles(): Promise<string> {
    const before = await lstat(filename, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) throw new Error("User styles.css must be an ordinary file; symbolic links are not loaded.");
    if (before.size > BigInt(MAX_BYTES)) throw new Error("User styles.css exceeds the 1 MiB limit.");
    const handle = await open(filename, "r");
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev) throw new Error("User styles.css changed while being opened; previous styles were retained.");
      const bytes = Buffer.allocUnsafe(MAX_BYTES + 1); let count = 0;
      while (count < bytes.length) { const result = await handle.read(bytes, count, bytes.length - count, null); if (!result.bytesRead) break; count += result.bytesRead; }
      if (count > MAX_BYTES) throw new Error("User styles.css exceeds the 1 MiB limit.");
      const after = await handle.stat({ bigint: true });
      if (after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || BigInt(count) !== after.size) throw new Error("User styles.css changed while being read; previous styles were retained.");
      try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count)); }
      catch { throw new Error("User styles.css is not valid UTF-8; previous styles were retained."); }
    } finally { await handle.close(); }
  }
  async function loadOnce(): Promise<void> {
    let css: string;
    try { css = await readStyles(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") css = "";
      else { lastSignature = undefined; report(error); return; }
    }
    if (closed) return;
    if (css === lastApplied) { lastError = undefined; return; }
    try { await options.onStyles(css); if (!closed) { lastApplied = css; lastError = undefined; } }
    catch (error) { lastSignature = undefined; report(error); }
  }
  function reload(): Promise<void> {
    if (closed) return Promise.resolve();
    rerun = true;
    return loading ??= (async () => { while (rerun && !closed) { rerun = false; await loadOnce(); } })().finally(() => { loading = undefined; });
  }
  function schedule(): void {
    if (closed) return; clearTimeout(debounce);
    debounce = setTimeout(() => { debounce = undefined; void reload(); }, 65); debounce.unref();
  }
  function attach(): void {
    if (closed || watcher) return;
    try {
      const active = watch(directory, { persistent: false }, (_event, name) => { if (name === null || String(name) === "styles.css") schedule(); });
      watcher = active;
      active.on("error", error => { if (watcher === active) watcher = undefined; active.close(); report(error); });
      active.on("close", () => { if (watcher === active) watcher = undefined; });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") report(error); }
  }
  let polling = false;
  const poll = setInterval(() => {
    if (closed || polling) return; polling = true; attach();
    void signature().then(value => { if (value !== lastSignature) { lastSignature = value; schedule(); } }, report).finally(() => { polling = false; });
  }, 700); poll.unref();
  attach();
  await reload();
  return {
    reload,
    close() { if (closed) return; closed = true; clearTimeout(debounce); clearInterval(poll); watcher?.close(); watcher = undefined; },
  };
}
