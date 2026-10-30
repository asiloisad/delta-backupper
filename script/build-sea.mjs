import { copyFile, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";
import postject from "postject";
import windowsResources from "app-builder-lib/out/util/resEdit.js";
import { NtExecutable, NtExecutableResource } from "resedit";
import { buildInputs } from "./build.mjs";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const expectedNode = "24.22.1";

/** Brand only the generated CLI, preserving the injected executable payload. */
export async function brandWindowsCli(executable, { iconPath = path.join(root, "resources/branding/app.ico"), version = "0.0.0-stage0" } = {}) {
  const numericVersion = version.match(/^(\d+)\.(\d+)\.(\d+)(?:[+-].*)?$/);
  if (!numericVersion) throw new Error("Invalid CLI application version.");
  const original = NtExecutable.from(await readFile(executable), { ignoreCert: true });
  const blob = NtExecutableResource.from(original).entries.find(entry => entry.type === 10 && entry.id === "NODE_SEA_BLOB");
  if (!blob) throw new Error("Cannot brand a CLI without its NODE_SEA_BLOB resource.");
  const blobHash = createHash("sha256").update(Buffer.from(blob.bin)).digest("hex");
  // The original Node certificate cannot authenticate a modified SEA binary.
  // Regeneration removes its stale certificate table, on our output copy only.
  await writeFile(executable, Buffer.from(original.generate()));
  await windowsResources.editWindowsResources({
    file: executable, iconPath,
    fileVersion: numericVersion.slice(1).join("."), productVersion: `${numericVersion[1]}.${numericVersion[2]}.${numericVersion[3]}.0`,
    versionStrings: {
      FileDescription: "Delta Backupper command line", ProductName: "Delta Backupper",
      CompanyName: "Delta Backupper contributors", LegalCopyright: "Copyright (c) 2026 Delta Backupper contributors",
      InternalName: "delta", OriginalFilename: "delta.exe",
    },
  });
  const branded = NtExecutable.from(await readFile(executable));
  const savedBlob = NtExecutableResource.from(branded).entries.find(entry => entry.type === 10 && entry.id === "NODE_SEA_BLOB");
  if (!savedBlob || createHash("sha256").update(Buffer.from(savedBlob.bin)).digest("hex") !== blobHash) throw new Error("CLI branding changed its NODE_SEA_BLOB resource.");
}

export async function buildSea() {
  if (process.versions.node !== expectedNode || process.versions.electron) {
    throw new Error(`Build SEA with Node.js ${expectedNode}; found ${process.versions.node}`);
  }
  const provenance = JSON.parse(await readFile(path.join(root, ".dev/build/build-inputs.json"), "utf8"));
  const bundleHash = createHash("sha256").update(await readFile(path.join(root, ".dev/build/cli.cjs"))).digest("hex");
  if (provenance.schemaVersion !== 1 || JSON.stringify(provenance.inputs) !== JSON.stringify(await buildInputs()) || provenance.outputs.find(value => value.path === ".dev/build/cli.cjs")?.sha256 !== bundleHash) {
    throw new Error("CLI bundle provenance is stale; run the application build before building SEA.");
  }
  const directory = path.join(root, ".dev/sea");
  await mkdir(directory, { recursive: true });
  const blob = path.join(directory, "delta.blob");
  const configPath = path.join(directory, "sea-config.json");
  const executable = path.join(directory, process.platform === "win32" ? "delta.exe" : "delta");
  const config = {
    main: path.join(root, ".dev/build/cli.cjs"),
    output: blob,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    execArgvExtension: "none",
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  // Only the copy under artifacts is modified by postject, never the host runtime.
  await execute(process.execPath, ["--experimental-sea-config", configPath], { cwd: root });
  await copyFile(process.execPath, executable);
  if (process.platform !== "win32") await chmod(executable, 0o755);
  if (process.platform === "darwin") await execute("codesign", ["--remove-signature", executable]);
  await postject.inject(executable, "NODE_SEA_BLOB", await readFile(blob), {
    sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    ...(process.platform === "darwin" ? { machoSegmentName: "NODE_SEA" } : {}),
  });
  if (process.platform === "win32") {
    const application = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    await brandWindowsCli(executable, { version: application.version });
  }
  if (process.platform === "darwin") await execute("codesign", ["--sign", "-", executable]);
  if (JSON.stringify(provenance.inputs) !== JSON.stringify(await buildInputs()) || createHash("sha256").update(await readFile(path.join(root, ".dev/build/cli.cjs"))).digest("hex") !== bundleHash) throw new Error("CLI inputs changed during SEA construction; rebuild before qualification.");
  const stat = await import("node:fs/promises").then(({ stat }) => stat(executable));
  const metadata = {
    builtAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    bytes: stat.size,
    sha256: createHash("sha256").update(await readFile(executable)).digest("hex"),
    signedForDistribution: false,
    provenance: { schemaVersion: 1, inputs: provenance.inputs, bundleSha256: bundleHash },
  };
  await writeFile(path.join(directory, "build.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  return executable;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${await buildSea()}\n`);
}
