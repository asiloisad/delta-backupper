import { access, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { root } from "./build.mjs";
import path from "node:path";

// Electron 45 deliberately ships an explicit installer instead of postinstall.
const marker = path.join(root, "node_modules/electron/path.txt");
try {
  await access(marker);
  const relative = (await readFile(marker, "utf8")).trim();
  if (!relative || path.isAbsolute(relative)) throw new Error("Invalid Electron path marker");
  await access(path.join(root, "node_modules/electron/dist", relative));
  console.log("Electron runtime is already installed.");
} catch {
  const child = spawn(process.execPath, [path.join(root, "node_modules/electron/install.js")], { cwd: root, stdio: "inherit" });
  child.once("error", (error) => { console.error(error); process.exitCode = 1; });
  child.once("exit", (code) => { process.exitCode = code ?? 1; });
}
