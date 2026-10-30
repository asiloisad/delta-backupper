import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NtExecutable, NtExecutableResource, Resource } from "resedit";
import { brandWindowsCli } from "../script/build-sea.mjs";
import { iconFilePayloads, inspectWindowsBranding, inspectIcns } from "./helpers/branding.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

test("CLI resource branding preserves its SEA payload and overlay while removing a stale upstream certificate", async () => {
  const executable = NtExecutable.createEmpty(false, false), resources = NtExecutableResource.from(executable);
  const payload = randomBytes(4096), manifest = Buffer.from('<assembly><requestedExecutionLevel level="asInvoker"/></assembly>');
  resources.entries.push({ type: 10, id: "NODE_SEA_BLOB", lang: 0, codepage: 0, bin: Uint8Array.from(payload).buffer });
  resources.entries.push({ type: 24, id: 1, lang: 1033, codepage: 0, bin: Uint8Array.from(manifest).buffer });
  const originalVersion = Resource.VersionInfo.createEmpty();
  originalVersion.lang = 1033;
  originalVersion.setStringValues({ lang: 1033, codepage: 1200 }, { ProductName: "Unbranded runtime", FileDescription: "Runtime", CompanyName: "Runtime publisher" });
  originalVersion.outputToResourceEntries(resources.entries);
  resources.outputResource(executable);
  const overlay = Buffer.from("Preserve unrelated opaque overlay bytes.");
  executable.setExtraData(overlay);
  const unsigned = Buffer.from(executable.generate()), certificate = Buffer.alloc(16, 0xab);
  const fixture = Buffer.concat([unsigned, certificate]);
  const optionalHeader = fixture.readUInt32LE(0x3c) + 24;
  const directory = optionalHeader + (fixture.readUInt16LE(optionalHeader) === 0x20b ? 112 : 96);
  fixture.writeUInt32LE(unsigned.length, directory + 4 * 8);
  fixture.writeUInt32LE(certificate.length, directory + 4 * 8 + 4);
  await mkdir(path.join(root, ".dev/test-fixtures"), { recursive: true });
  const directoryPath = await mkdtemp(path.join(root, ".dev/test-fixtures/native-branding-"));
  const filename = path.join(directoryPath, "delta.exe");
  await writeFile(filename, fixture);
  await brandWindowsCli(filename, { version: "2.3.4-preview" });
  const bytes = await readFile(filename), branded = NtExecutable.from(bytes), saved = NtExecutableResource.from(branded);
  assert.deepEqual(Buffer.from(saved.entries.find(entry => entry.id === "NODE_SEA_BLOB").bin), payload);
  assert.deepEqual(Buffer.from(saved.entries.find(entry => entry.type === 24).bin), manifest);
  assert.deepEqual(Buffer.from(branded.getExtraData()), overlay);
  assert.equal(branded.newHeader.optionalHeaderDataDirectory.get(4).size, 0);
  const inspected = inspectWindowsBranding(bytes);
  assert.equal(inspected.metadata[0].ProductName, "Delta Backupper");
  assert.equal(inspected.metadata[0].FileDescription, "Delta Backupper command line");
  assert.equal(inspected.metadata[0].CompanyName, "Delta Backupper contributors");
  assert.equal(inspected.metadata[0].OriginalFilename, "delta.exe");
  assert.equal(inspected.metadata[0].FileVersion, "2.3.4");
  assert.equal(inspected.metadata[0].ProductVersion, "2.3.4.0");
  const expected = iconFilePayloads(await readFile(path.join(root, "resources/branding/app.ico")));
  assert.ok(inspected.icons.some(group => JSON.stringify(group.images) === JSON.stringify(expected)));
});

test("CLI branding rejects a non-SEA input or invalid version without modifying its bytes", async () => {
  await mkdir(path.join(root, ".dev/test-fixtures"), { recursive: true });
  const directory = await mkdtemp(path.join(root, ".dev/test-fixtures/native-branding-invalid-"));
  const filename = path.join(directory, "unrelated.exe"), original = Buffer.from(NtExecutable.createEmpty(false, false).generate());
  await writeFile(filename, original);
  await assert.rejects(brandWindowsCli(filename), /NODE_SEA_BLOB/);
  assert.deepEqual(await readFile(filename), original);
  await assert.rejects(brandWindowsCli(filename, { version: "unversioned" }), /version/);
  assert.deepEqual(await readFile(filename), original);
});

test("Native icon inspection rejects truncated or out-of-bounds containers", () => {
  assert.throws(() => iconFilePayloads(Buffer.alloc(6)), /ICO/);
  const ico = Buffer.alloc(22); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); ico.writeUInt32LE(20, 14); ico.writeUInt32LE(1000, 18);
  assert.throws(() => iconFilePayloads(ico), /bounds/);
  assert.throws(() => inspectIcns(Buffer.from("icns")), /ICNS/);
  const icns = Buffer.alloc(16); icns.write("icns"); icns.writeUInt32BE(16, 4); icns.write("ic10", 8); icns.writeUInt32BE(200, 12);
  assert.throws(() => inspectIcns(icns), /bounds/);
});
