import { build } from "esbuild";
import { copyFile, glob, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const root = fileURLToPath(new URL("../", import.meta.url));
export async function buildInputs() {
  const files = ["package.json", "package-lock.json", "script/build.mjs", "script/build-sea.mjs", "script/generate-branding.mjs", "script/render-branding.cjs"];
  for await (const file of glob("{src,static,resources}/**/*.{ts,mjs,js,json,html,css,ps1,sh,nsi,svg,png,ico,icns,bmp}", { cwd: root })) files.push(file.replaceAll("\\", "/"));
  for await (const file of glob("native/macos/**/*.{mm,mjs,h,json}", { cwd: root })) files.push(file.replaceAll("\\", "/"));
  return await Promise.all(files.sort().map(async file => ({ path: file, sha256: createHash("sha256").update(await readFile(path.join(root, file))).digest("hex") })));
}
export async function buildApp() {
  const inputs = await buildInputs();
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const common = { bundle: true, platform: "node", target: "node24", format: "cjs", sourcemap: false, logLevel: "warning" };
  await mkdir(path.join(root, ".dev/build"), { recursive: true });
  await Promise.all([
    build({ ...common, entryPoints: [path.join(root, "src/cli/main.ts")], outfile: path.join(root, ".dev/build/cli.cjs") }),
    build({ ...common, entryPoints: [path.join(root, "src/main.ts")], outfile: path.join(root, ".dev/build/main.cjs"), external: ["electron"] }),
    build({ ...common, entryPoints: [path.join(root, "src/worker.ts")], outfile: path.join(root, ".dev/build/worker.cjs") }),
    build({ ...common, entryPoints: [path.join(root, "src/engine-worker.ts")], outfile: path.join(root, ".dev/build/engine-worker.cjs"), external: ["electron"] }),
    build({ ...common, entryPoints: [path.join(root, "src/preload.ts")], outfile: path.join(root, ".dev/build/preload.cjs"), external: ["electron"] }),
    build({ ...common, entryPoints: [path.join(root, "src/tray-preload.ts")], outfile: path.join(root, ".dev/build/tray-preload.cjs"), external: ["electron"] }),
    build({ bundle: true, platform: "browser", target: "es2024", format: "iife", entryPoints: [path.join(root, "static/index.ts")], outfile: path.join(root, ".dev/build/static/index.js") }),
    build({ bundle: true, platform: "browser", target: "es2024", format: "iife", entryPoints: [path.join(root, "static/tray.ts")], outfile: path.join(root, ".dev/build/static/tray.js") }),
  ]);
  await Promise.all(["index.html", "styles.css", "themes.css", "tray.html", "tray.css"].map(file => copyFile(path.join(root, "static", file), path.join(root, ".dev/build/static", file))));
  await mkdir(path.join(root, ".dev/build/static/assets/branding"), { recursive: true });
  const brandFiles = ["logo.svg", "logo-light.svg"];
  await Promise.all(brandFiles.map(file => copyFile(path.join(root, "resources/branding", file), path.join(root, ".dev/build/static/assets/branding", file))));
  await writeFile(path.join(root, ".dev/build/package.json"), JSON.stringify({ name: manifest.name, description: manifest.description, productName: "Delta Backupper", version: manifest.version, main: "main.cjs", license: manifest.license, author: "Delta Backupper contributors" }, null, 2));
  if (JSON.stringify(inputs) !== JSON.stringify(await buildInputs())) throw new Error("Application inputs changed during bundling; rebuild before qualification.");
  const outputs = await Promise.all([".dev/build/cli.cjs", ".dev/build/main.cjs", ".dev/build/worker.cjs", ".dev/build/engine-worker.cjs", ".dev/build/preload.cjs", ".dev/build/tray-preload.cjs", ".dev/build/static/index.js", ".dev/build/static/index.html", ".dev/build/static/styles.css", ".dev/build/static/themes.css", ".dev/build/static/tray.js", ".dev/build/static/tray.html", ".dev/build/static/tray.css", ...brandFiles.map(file => `.dev/build/static/assets/branding/${file}`)].map(async file => ({ path: file, sha256: createHash("sha256").update(await readFile(path.join(root, file))).digest("hex") })));
  await writeFile(path.join(root, ".dev/build/build-inputs.json"), `${JSON.stringify({ schemaVersion: 1, inputs, outputs }, null, 2)}\n`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await buildApp();
