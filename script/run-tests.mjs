import { spawn } from "node:child_process";
import { glob } from "node:fs/promises";
import { buildApp, root } from "./build.mjs";

await buildApp();
const files = [];
for await (const file of glob("spec/**/*.test.mjs", { cwd: root })) files.push(file);
const child = spawn(process.execPath, ["--test", ...files.sort()], { cwd: root, stdio: "inherit" });
child.once("exit", (code) => { process.exitCode = code ?? 1; });
child.once("error", (error) => { console.error(error); process.exitCode = 1; });
