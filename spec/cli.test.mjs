import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../.dev/build/cli.cjs", import.meta.url));
test("CLI preserves Unicode stdin, distinct stderr and requested exit code", () => {
  const input = "Zażółć gęślą jaźń\nΔelta\n";
  const result = spawnSync(process.execPath, [entry, "probe", "io", "--exit-code", "7", "--stderr", "kontrolowany-błąd"], { input, encoding: "utf8" });
  assert.equal(result.status, 7);
  assert.equal(result.stderr.trim(), "kontrolowany-błąd");
  assert.deepEqual(JSON.parse(result.stdout), { bytes: Buffer.byteLength(input), sha256: createHash("sha256").update(input).digest("hex") });
});
test("unknown operation fails without claiming to back up data", () => {
  const result = spawnSync(process.execPath, [entry, "backup"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Unknown command/);
});
test("SQLite is available to the standalone-core candidate", () => {
  const result = spawnSync(process.execPath, [entry, "probe", "sqlite"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).passed, true);
});
