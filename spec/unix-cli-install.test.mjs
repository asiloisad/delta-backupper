import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const execute = promisify(execFile);
const unix = process.platform === "linux" || process.platform === "darwin";
test("Unix CLI installation round trip preserves foreign commands and profile data", { skip: !unix }, async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "delta-cli-install-"));
  try {
    const directory = path.join(fixture, "application żółć $ shell", process.platform === "darwin" ? "Contents" : "");
    const cli = path.join(directory, process.platform === "darwin" ? "MacOS/delta" : "bin/delta");
    const home = path.join(fixture, "profile");
    const bin = path.join(home, ".local/bin");
    const command = path.join(bin, "delta");
    const helper = path.join(directory, "install-cli.sh");
    await mkdir(path.dirname(cli), { recursive: true }); await mkdir(home);
    await writeFile(cli, "#!/bin/sh\nprintf 'fixture-cli\\n'\n", { mode: 0o755 });
    await copyFile(new URL("../resources/unix/install-cli.sh", import.meta.url), helper);
    const profile = path.join(home, ".profile"); await writeFile(profile, "private profile\n");
    const run = (mode, ...args) => execute("/bin/sh", [helper, mode, ...args], { env: { ...process.env, HOME: home, APPIMAGE: "" } });
    await run("install", "--dry-run");
    await assert.rejects(readlink(command), { code: "ENOENT" });
    await run("install"); assert.equal(await readlink(command), cli);
    assert.equal((await execute(command)).stdout, "fixture-cli\n");
    await run("install"); assert.equal(await readlink(command), cli);
    await run("uninstall"); await run("uninstall");
    assert.equal(await readFile(profile, "utf8"), "private profile\n");
    await writeFile(command, "foreign command");
    await assert.rejects(run("install"), /Another command owns/);
    await assert.rejects(run("uninstall"), /Another command owns/);
    assert.equal(await readFile(command, "utf8"), "foreign command");
    await rm(command); await symlink(path.join(fixture, "missing-foreign-cli"), command);
    await assert.rejects(run("install"), /Another command owns/);
    assert.equal(await readlink(command), path.join(fixture, "missing-foreign-cli"));
    await rm(command); await run("install"); await rm(cli);
    await run("uninstall"); await assert.rejects(readlink(command), { code: "ENOENT" });
    await assert.rejects(run("install", "--bin-dir", "relative"), /must be absolute/);
    await assert.rejects(run("install", "--bin-dir", "/"), /filesystem root/);
    await assert.rejects(run("install", "--bin-dir", "////"), /filesystem root/);
    await assert.rejects(run("install", "--bin-dir", "/tmp/.."), /dot path segments/);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});
