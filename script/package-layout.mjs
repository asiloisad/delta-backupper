import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

/** One set of original artwork supplies every native application icon. */
export function brandingAssets(root = projectRoot) {
  const directory = path.join(root, "resources", "branding");
  return { directory, windows: path.join(directory, "app.ico"), mac: path.join(directory, "app.icns"), linux: path.join(directory, "app-icon.png"), dmgBackground: path.join(directory, "dmg-background.png") };
}

/** A native build never silently substitutes x64 for an unsupported CPU. */
export function packageLayout(root, platform = process.platform, arch = process.arch) {
  if (!["win32", "linux", "darwin"].includes(platform)) throw new Error(`Unsupported package platform: ${platform}`);
  if (!["x64", "arm64"].includes(arch)) throw new Error(`Unsupported package architecture: ${arch}`);
  const output = path.join(root, "dist");
  const directory = path.join(output, platform === "win32" ? arch === "x64" ? "win-unpacked" : "win-arm64-unpacked" : platform === "linux" ? arch === "x64" ? "linux-unpacked" : "linux-arm64-unpacked" : arch === "x64" ? "mac" : "mac-arm64");
  const prepackaged = platform === "darwin" ? path.join(directory, "Delta Backupper.app") : directory;
  const bundleDirectory = platform === "darwin" ? path.join(prepackaged, "Contents") : directory;
  return {
    output, prepackaged, bundleDirectory,
    desktop: path.join(bundleDirectory, platform === "darwin" ? "MacOS/Delta Backupper" : platform === "win32" ? "Delta Backupper.exe" : "Delta Backupper"),
    cli: path.join(bundleDirectory, platform === "darwin" ? "MacOS/delta" : platform === "win32" ? "bin/delta.exe" : "bin/delta"),
    targets: platform === "win32" ? ["zip"] : platform === "darwin" ? ["zip", "dmg"] : ["AppImage", "tar.gz"],
  };
}

export function localPlatformOptions(platform = process.platform, root = projectRoot) {
  const icons = brandingAssets(root);
  // signAndEditExecutable:false suppresses the icon and product metadata too.
  // The pinned builder can edit resources while explicitly skipping signing.
  if (platform === "win32") return { win: { icon: icons.windows, signExecutable: false } };
  if (platform === "darwin") return {
    mac: { icon: icons.mac, identity: null, notarize: false, category: "public.app-category.utilities" },
    dmg: {
      background: icons.dmgBackground, icon: icons.mac, iconSize: 96,
      window: { width: 660, height: 420 },
      contents: [{ x: 180, y: 218, type: "file" }, { x: 480, y: 218, type: "link", path: "/Applications" }],
    },
  };
  if (platform === "linux") return { linux: { icon: icons.linux, category: "Utility", desktop: { entry: { Name: "Delta Backupper", Comment: "Create and restore file backups with transparent ZIP archives.", Terminal: "false" } } } };
  throw new Error(`Unsupported package platform: ${platform}`);
}
