import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const nativeRoot = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(nativeRoot, "../..");

async function command(executable, arguments_, options = {}) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(DYLD_|LD_|NODE_|ELECTRON_|SDKROOT$|CPATH$|CPLUS_INCLUDE_PATH$|LIBRARY_PATH$)/.test(key)));
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, { cwd: projectRoot, env: environment, stdio: ["ignore", "pipe", "pipe"], ...options });
    let output = "";
    child.stdout.on("data", value => { if (output.length < 1024 * 1024) output += value.toString(); });
    child.stderr.on("data", value => { if (output.length < 1024 * 1024) output += value.toString(); });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve(output) : reject(Object.assign(new Error(`${path.basename(executable)} failed (${code ?? signal}): ${output}`), { output })));
  });
}
async function digest(file) { return createHash("sha256").update(await readFile(file)).digest("hex"); }

export async function buildSnapshot({ outputDirectory = path.join(projectRoot, ".dev/native/macos"), signingIdentity = process.env.DELTA_MACOS_SIGNING_IDENTITY, entitlements = process.env.DELTA_MACOS_SNAPSHOT_ENTITLEMENTS } = {}) {
  // Reject before creating files or trying to invoke tools on another OS.
  if (process.platform !== "darwin") throw new Error("Build the APFS helper on macOS with Xcode command-line tools; cross-platform mocks do not qualify APFS snapshot support.");
  const outputRoot = path.resolve(outputDirectory);
  const source = path.join(nativeRoot, "delta-snapshot.mm"), binary = path.join(outputRoot, "delta-snapshot");
  const files = [source, fileURLToPath(import.meta.url), path.join(projectRoot, "package.json"), ...(entitlements ? [path.resolve(entitlements)] : [])];
  const inputs = await Promise.all(files.map(async file => ({ path: file, sha256: await digest(file) })));
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const sdk = (await command("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"])).trim();
  const arguments_ = ["--sdk", "macosx", "clang++", "-std=c++20", "-fobjc-arc", "-O2", "-Wall", "-Wextra", "-Werror", "-mmacosx-version-min=12.0", "-isysroot", sdk, "-framework", "Foundation", "-framework", "CoreFoundation", "-lproc", source, "-o", binary];
  try { await writeFile(path.join(outputRoot, "build.log"), await command("/usr/bin/xcrun", arguments_)); }
  catch (error) { await writeFile(path.join(outputRoot, "build.log"), error.output ?? String(error)); throw error; }
  // Developer entitlements must be supplied by an actually authorized signer.
  // Ad-hoc signing never inserts a snapshot entitlement or grants permission.
  if (entitlements && !signingIdentity) throw new Error("A genuine signing identity is required when supplying snapshot entitlements; ad-hoc signing does not authorize the APFS snapshot API.");
  await command("/usr/bin/codesign", ["--force", "--sign", signingIdentity || "-", ...(signingIdentity ? ["--timestamp", "--options", "runtime"] : []), ...(entitlements ? ["--entitlements", path.resolve(entitlements)] : []), binary]);
  await command("/usr/bin/codesign", ["--verify", "--strict", binary]);
  const selfTest = JSON.parse((await command(binary, ["--self-test"])).trim());
  if (selfTest.status !== "passed" || selfTest.selfTestsPassed !== 14 || selfTest.createdSnapshot !== false) throw new Error("APFS helper did not confirm its deterministic parser, journal and source-link self-tests.");
  for (const input of inputs) if (await digest(input.path) !== input.sha256) throw new Error("APFS helper inputs changed during compilation; rebuild.");
  const manifest = { schemaVersion: 1, timestampUtc: new Date().toISOString(), binaryPath: binary, binarySha256: await digest(binary), platform: process.platform, architecture: process.arch, sdk, inputs, selfTest, adHocSigned: !signingIdentity, snapshotEntitlementsSupplied: Boolean(entitlements), elevatedLeaseQualification: "unverified", ordinarySnapshotAccessQualification: "unverified", published: false };
  await writeFile(path.join(outputRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arguments_ = process.argv.slice(2);
  if (arguments_.some(argument => !argument.startsWith("--output="))) throw new Error("Usage: node native/macos/Build-Snapshot.mjs [--output=/absolute/output/directory]");
  const outputDirectory = arguments_.find(argument => argument.startsWith("--output="))?.slice("--output=".length);
  console.log(JSON.stringify(await buildSnapshot({ outputDirectory }), null, 2));
}
