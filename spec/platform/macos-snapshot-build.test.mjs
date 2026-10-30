import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, access, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildSnapshot } from "../../native/macos/Build-Snapshot.mjs";

test("APFS helper build rejects a foreign host before creating output or invoking privileged tools", { skip: process.platform === "darwin" }, async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "delta-apfs-build-"));
  const outputDirectory = path.join(fixture, "native-output");
  try {
    await assert.rejects(buildSnapshot({ outputDirectory }), /Build the APFS helper on macOS/);
    await assert.rejects(access(outputDirectory), { code: "ENOENT" });
  } finally { await rm(fixture, { recursive: true, force: true }); }
});
