import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { packageLayout, localPlatformOptions, brandingAssets } from "../script/package-layout.mjs";

test("All six native package layouts keep the desktop and independent CLI in the same artifact", () => {
  for (const platform of ["win32", "linux", "darwin"]) for (const arch of ["x64", "arm64"]) {
    const layout = packageLayout("fixture", platform, arch);
    assert.ok(path.relative(layout.prepackaged, layout.cli));
    assert.equal(path.relative(layout.prepackaged, layout.desktop).startsWith(".."), false);
    assert.equal(path.relative(layout.prepackaged, layout.cli).startsWith(".."), false);
    if (platform === "darwin") {
      assert.equal(path.basename(layout.prepackaged), "Delta Backupper.app", "Builder receives the .app bundle, never its Contents directory");
      assert.equal(path.relative(layout.prepackaged, layout.cli), path.join("Contents", "MacOS", "delta"));
      assert.deepEqual(layout.targets, ["zip", "dmg"]);
    } else {
      assert.equal(path.dirname(layout.desktop), layout.prepackaged);
      assert.equal(path.relative(layout.prepackaged, layout.cli), path.join("bin", platform === "win32" ? "delta.exe" : "delta"));
      assert.deepEqual(layout.targets, platform === "win32" ? ["zip"] : ["AppImage", "tar.gz"]);
    }
    if (arch === "arm64") assert.match(layout.prepackaged, /arm64/);
  }
});

test("Package planning rejects unsupported platforms and CPUs instead of silently producing x64 artifacts", () => {
  assert.throws(() => packageLayout("fixture", "freebsd", "x64"), /platform/);
  for (const arch of ["ia32", "arm", "universal", ""]) assert.throws(() => packageLayout("fixture", "darwin", arch), /architecture/);
  assert.throws(() => localPlatformOptions("freebsd"), /platform/);
});

test("Local distribution explicitly disables release signing and notarization and sets desktop categories", () => {
  assert.equal(localPlatformOptions("win32").win.signExecutable, false);
  assert.equal(localPlatformOptions("win32").win.signAndEditExecutable, undefined, "Resource editing must remain enabled so the executable gets the application icon and metadata");
  assert.equal(localPlatformOptions("darwin").mac.identity, null);
  assert.equal(localPlatformOptions("darwin").mac.notarize, false);
  assert.equal(localPlatformOptions("darwin").mac.category, "public.app-category.utilities");
  assert.equal(localPlatformOptions("linux").linux.category, "Utility");
  assert.equal(localPlatformOptions("linux").linux.desktop.entry.Name, "Delta Backupper");
});

test("All native formats reference the original Delta branding assets", () => {
  const assets = brandingAssets(path.resolve("fixture"));
  assert.equal(localPlatformOptions("win32", path.resolve("fixture")).win.icon, assets.windows);
  assert.equal(localPlatformOptions("darwin", path.resolve("fixture")).mac.icon, assets.mac);
  assert.equal(localPlatformOptions("darwin", path.resolve("fixture")).dmg.background, assets.dmgBackground);
  assert.deepEqual(localPlatformOptions("darwin").dmg.window, { width: 660, height: 420 });
  assert.equal(localPlatformOptions("darwin").dmg.contents[1].path, "/Applications");
  assert.equal(localPlatformOptions("linux", path.resolve("fixture")).linux.icon, assets.linux);
  for (const file of [assets.windows, assets.mac, assets.linux]) assert.equal(path.relative(assets.directory, file).startsWith(".."), false);
  assert.equal(path.extname(assets.windows), ".ico");
  assert.equal(path.extname(assets.mac), ".icns");
  assert.equal(path.extname(assets.linux), ".png");
});
