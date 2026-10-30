import path from "node:path";
import { fileURLToPath } from "node:url";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { build, Platform, Arch } from "electron-builder";
import { flipFuses, FuseVersion, FuseV1Options } from "@electron/fuses";
import { buildApp } from "./build.mjs";
import { buildSea } from "./build-sea.mjs";
import { buildWindowsInstaller } from "./windows-installer.mjs";
import { APP_ID } from "../src/platform/application-identity.mjs";
import { packageLayout, localPlatformOptions, brandingAssets } from "./package-layout.mjs";
import { buildSnapshot as buildMacSnapshot } from "../native/macos/Build-Snapshot.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const execute = promisify(execFile);
async function nativeHelper() {
  const manifestFile = path.join(root, ".dev/native/windows/manifest.json");
  async function validate() {
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    if (manifest.schemaVersion !== 1 || manifest.selfTest?.status !== "passed" || manifest.selfTest?.selfTestsPassed !== 7) throw new Error("Invalid native helper manifest");
    for (const input of manifest.inputs) if (createHash("sha256").update(await readFile(input.path)).digest("hex") !== input.sha256) throw new Error("Native helper sources changed");
    if (createHash("sha256").update(await readFile(manifest.binaryPath)).digest("hex") !== manifest.binarySha256) throw new Error("Native helper binary changed");
    return manifest.binaryPath;
  }
  try { return await validate(); }
  catch {
    const environment = { ...process.env }; delete environment.PSModulePath;
    await execute(path.join(process.env.SystemRoot ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "native/windows/Build-Vss.ps1")], { cwd: root, env: environment, maxBuffer: 4 * 1024 ** 2 });
    return validate();
  }
}

async function buildUnpacked() {
  const layout = packageLayout(root);
  await buildApp();
  const cli = await buildSea();
  const vss = process.platform === "win32" ? await nativeHelper() : null;
  const apfs = process.platform === "darwin" ? await buildMacSnapshot() : null;
  // Local packages include the same required licenses as distribution containers.
  await Promise.all(["LICENSE", "THIRD_PARTY_NOTICES"].map((name) => access(path.join(root, name))));
  const output = layout.output;
  await mkdir(output, { recursive: true });
  const platform = process.platform === "win32" ? Platform.WINDOWS : process.platform === "darwin" ? Platform.MAC : Platform.LINUX;
  const arch = process.arch === "arm64" ? Arch.arm64 : process.arch === "x64" ? Arch.x64 : null;
  if (arch === null) throw new Error(`Unsupported package architecture: ${process.arch}`);
  const targets = platform.createTarget(["dir"], arch);
  const finishFuses = async ({ appOutDir }) => {
    const executable = process.platform === "win32"
      ? path.join(appOutDir, "Delta Backupper.exe")
      : process.platform === "darwin"
        ? path.join(appOutDir, "Delta Backupper.app/Contents/MacOS/Delta Backupper")
        : path.join(appOutDir, "Delta Backupper");
    await flipFuses(executable, {
      version: FuseVersion.V1,
      // This is ad-hoc signing for local qualification, never a release identity.
      resetAdHocDarwinSignature: process.platform === "darwin",
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
    });
  };
  await build({
    targets,
    publish: "never",
    config: {
      appId: APP_ID,
      productName: "Delta Backupper",
      executableName: "Delta Backupper",
      copyright: "Copyright (c) 2026 Delta Backupper contributors",
      directories: { app: path.join(root, ".dev/build"), output },
      electronVersion: "45.1.0",
      electronDist: path.join(root, "node_modules/electron/dist"),
      npmRebuild: false,
      asar: true,
      files: ["main.cjs", "worker.cjs", "engine-worker.cjs", "preload.cjs", "tray-preload.cjs", "static/**", "package.json"],
      extraResources: [{ from: brandingAssets(root).directory, to: "branding" }],
      extraFiles: [
        { from: cli, to: process.platform === "darwin" ? "MacOS/delta" : `bin/${path.basename(cli)}` },
        { from: path.join(root, "LICENSE"), to: "LICENSE" },
        { from: path.join(root, "THIRD_PARTY_NOTICES"), to: "THIRD_PARTY_NOTICES" },
        { from: path.join(root, "README.md"), to: "README.md" },
        ...(process.platform === "win32" ? [
          { from: path.join(root, "resources/win/install-path.ps1"), to: "install-path.ps1" },
          { from: path.join(root, "resources/win/notification-registration.ps1"), to: "notification-registration.ps1" },
        ] : [{ from: path.join(root, "resources/unix/install-cli.sh"), to: "install-cli.sh" }]),
        { from: path.join(root, "docs"), to: "docs", filter: ["**/*.md"] },
        { from: path.join(root, "native/windows/README.md"), to: "native/windows/README.md" },
        ...(vss ? [{ from: vss, to: "native/delta-vss.exe" }] : []),
        ...(apfs ? [{ from: apfs.binaryPath, to: "MacOS/delta-snapshot" }, { from: path.join(root, "native/macos/README.md"), to: "native/macos/README.md" }] : []),
      ],
      ...localPlatformOptions(),
      // On Windows the builder edits PE resources after afterPack. Apply fuses
      // after that final resource rewrite; signExecutable:false still emits
      // afterSign when the pinned builder finishes resource editing.
      afterPack: process.platform === "win32" ? undefined : finishFuses,
      afterSign: process.platform === "win32" ? finishFuses : undefined,
    },
  });
  const desktop = layout.desktop;
  const packagedCli = layout.cli;
  await Promise.all([access(desktop), access(packagedCli)]);
  const report = { platform: process.platform, arch: process.arch, desktop, cli: packagedCli, signedForDistribution: false };
  await writeFile(path.join(output, "paths.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

export async function packageApplication({ unpacked = false } = {}) {
  const packaged = await buildUnpacked();
  if (unpacked) return packaged;
  const layout = packageLayout(root);
  const platform = process.platform === "win32" ? Platform.WINDOWS : process.platform === "darwin" ? Platform.MAC : Platform.LINUX;
  const arch = process.arch === "arm64" ? Arch.arm64 : Arch.x64;
  const prepackaged = layout.prepackaged;
  const output = path.join(root, "binaries");
  await mkdir(output, { recursive: true });
  const artifacts = await build({
    targets: platform.createTarget(layout.targets, arch),
    prepackaged, publish: "never",
    config: {
      appId: APP_ID, productName: "Delta Backupper", executableName: "Delta Backupper",
      copyright: "Copyright (c) 2026 Delta Backupper contributors",
      toolsets: { nsis: "1.2.1" },
      directories: { app: path.join(root, ".dev/build"), output },
      artifactName: "Delta-Backupper-${version}-${os}-${arch}.${ext}",
      ...localPlatformOptions(),
    },
  });
  if (process.platform === "win32") artifacts.push(await buildWindowsInstaller(path.dirname(packaged.desktop), output));
  await writeFile(path.join(output, "manifest.json"), `${JSON.stringify({ builtAt: new Date().toISOString(), platform: process.platform, arch: process.arch, artifacts, published: false, signedForDistribution: false, installerExecuted: false }, null, 2)}\n`);
  return { artifacts, published: false, signedForDistribution: false, installerExecuted: false };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(argument => argument !== "--unpacked")) throw new Error("Usage: node script/package.mjs [--unpacked]; publication is disabled.");
  console.log(JSON.stringify(await packageApplication({ unpacked: args.includes("--unpacked") }), null, 2));
}
