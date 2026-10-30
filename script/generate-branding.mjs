import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'resources/branding');
const palette = { forest: '#245743', deep: '#173B2F', mint: '#91D2B2', ivory: '#F5F8F4', amber: '#D5A84D' };
export function mark(foreground, accent = palette.amber) { return `<g fill="none" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"><path d="M48 14 12 80H84Z" stroke="${foreground}"/><path d="M56.2 29 65 45.2" stroke="${accent}"/></g>`; }
function svg(width, height, body) { return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`; }
const title = '<title>Delta Backupper</title>';
const logo = svg(96, 96, title + mark(palette.forest));
const logoLight = svg(96, 96, title + mark(palette.mint));
const wordmark = svg(460, 104, `<g transform="translate(0 2)">${mark(palette.forest)}</g><g fill="${palette.deep}" font-family="Segoe UI,Arial,sans-serif"><text x="116" y="54" font-size="44" font-weight="600" letter-spacing="-1.5">Delta</text><text x="119" y="82" font-size="17" letter-spacing="4">BACKUPPER</text></g>`);
const template = svg(96, 96, title + mark('#000', '#000'));
const appIcon = svg(1024, 1024, `${title}<defs><linearGradient id="tile" x2="0" y2="1"><stop stop-color="${palette.forest}"/><stop offset="1" stop-color="${palette.deep}"/></linearGradient></defs><rect width="1024" height="1024" rx="218" fill="url(#tile)"/><g transform="translate(32 0) scale(10)">${mark(palette.ivory)}</g>`);
const tray = svg(96, 96, `${title}<rect width="96" height="96" rx="21" fill="${palette.deep}"/><g transform="translate(8 -2) scale(.84)">${mark(palette.ivory)}</g>`);
const header = svg(150, 57, `<rect width="150" height="57" fill="#fff"/><g transform="translate(5 8) scale(.39)">${mark(palette.forest)}</g><g fill="${palette.deep}" font-family="Segoe UI,Arial,sans-serif"><text x="52" y="27" font-size="16" font-weight="600">Delta</text><text x="53" y="42" font-size="10" letter-spacing="1.3">BACKUPPER</text></g>`);
const sidebar = svg(164, 314, `<defs><linearGradient id="bg" x2="0" y2="1"><stop stop-color="${palette.forest}"/><stop offset="1" stop-color="${palette.deep}"/></linearGradient></defs><rect width="164" height="314" fill="url(#bg)"/><g fill="none" stroke="${palette.mint}" stroke-opacity=".10" stroke-width="1"><path d="m82 84-103 189h206Z"/><path d="m82 108-77 141h154Z"/></g><g transform="translate(34 94)">${mark(palette.ivory)}</g><g fill="${palette.ivory}" font-family="Segoe UI,Arial,sans-serif"><text x="22" y="37" font-size="25" font-weight="600" letter-spacing="-.7">Delta</text><text x="23" y="56" font-size="11" letter-spacing="1.65">BACKUPPER</text><text x="22" y="264" font-size="14" font-weight="600">Your files.</text><text x="22" y="285" font-size="14" font-weight="600">Peace of mind.</text></g><path d="M23 230h24" stroke="${palette.amber}" stroke-width="3" stroke-linecap="round"/>`);
const dmg = svg(660, 420, `<rect width="660" height="420" fill="${palette.ivory}"/><path d="M0 0h660v100H0Z" fill="${palette.deep}"/><g transform="translate(22 18) scale(.62)">${mark(palette.ivory)}</g><g font-family="-apple-system,Segoe UI,Arial,sans-serif"><text x="98" y="49" font-size="24" font-weight="600" fill="${palette.ivory}">Delta Backupper</text><text x="100" y="73" font-size="12" fill="${palette.mint}">Transparent ZIP backups.</text><text x="330" y="351" text-anchor="middle" font-size="14" fill="${palette.forest}">Drag Delta Backupper to Applications.</text></g><path d="M302 218h56m-13-12 13 12-13 12" fill="none" stroke="${palette.amber}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`);

export async function generateBranding() {
  await mkdir(output, { recursive: true });
  const sources = { 'logo.svg': logo, 'logo-light.svg': logoLight, 'wordmark.svg': wordmark, 'app-icon.svg': appIcon, 'tray.svg': tray, 'tray-template.svg': template, 'installer-header.svg': header, 'installer-sidebar.svg': sidebar, 'dmg-background.svg': dmg };
  for (const [name, value] of Object.entries(sources)) await writeFile(path.join(output, name), `${value}\n`);
  const work = await mkdtemp(path.join(root, '.dev/branding-'));
  const sizes = [16, 20, 24, 32, 48, 64, 128, 256, 512, 1024];
  const jobs = sizes.map(size => ({ name: `app-${size}.png`, svg: appIcon, width: size, height: size }));
  jobs.push({ name: 'app-icon.png', svg: appIcon, width: 512, height: 512 });
  for (const size of [16, 20, 24, 32, 36, 40, 48, 64]) {
    jobs.push({ name: `tray-${size}.png`, svg: tray, width: size, height: size });
    jobs.push({ name: `tray-template-${size}.png`, svg: template, width: size, height: size });
  }
  jobs.push({ name: 'logo.png', svg: logo, width: 512, height: 512 }, { name: 'logo-light.png', svg: logoLight, width: 512, height: 512 });
  jobs.push({ name: 'installer-header.bmp', svg: header, width: 150, height: 57, bitmap: true }, { name: 'installer-sidebar.bmp', svg: sidebar, width: 164, height: 314, bitmap: true }, { name: 'installer-header.png', svg: header, width: 150, height: 57 }, { name: 'installer-sidebar.png', svg: sidebar, width: 164, height: 314 }, { name: 'wordmark.png', svg: wordmark, width: 920, height: 208 }, { name: 'dmg-background.png', svg: dmg, width: 660, height: 420 });
  const jobFile = path.join(work, 'jobs.json'); await writeFile(jobFile, JSON.stringify({ output, jobs }));
  const executable = process.platform === 'win32' ? path.join(root, 'node_modules/electron/dist/electron.exe') : process.platform === 'darwin' ? path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron') : path.join(root, 'node_modules/electron/dist/electron');
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE; delete environment.NODE_OPTIONS;
  await new Promise((resolve, reject) => {
    const child = spawn(executable, [path.join(root, 'script/render-branding.cjs'), jobFile, path.join(work, 'profile')], { cwd: root, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = ''; child.stdout.resume(); child.stderr.on('data', chunk => { errors = `${errors}${chunk}`.slice(-16000); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Brand renderer timed out')); }, 60000);
    child.once('error', reject); child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Brand renderer failed: ${errors}`)); });
  });
  const pngs = await Promise.all(sizes.filter(size => size <= 256).map(async size => ({ size, bytes: await readFile(path.join(output, `app-${size}.png`)) })));
  const iconHeader = Buffer.alloc(6 + pngs.length * 16); iconHeader.writeUInt16LE(1, 2); iconHeader.writeUInt16LE(pngs.length, 4); let offset = iconHeader.length;
  for (const [index, { size, bytes }] of pngs.entries()) { const at = 6 + index * 16; iconHeader[at] = iconHeader[at + 1] = size === 256 ? 0 : size; iconHeader.writeUInt16LE(1, at + 4); iconHeader.writeUInt16LE(32, at + 6); iconHeader.writeUInt32LE(bytes.length, at + 8); iconHeader.writeUInt32LE(offset, at + 12); offset += bytes.length; }
  await writeFile(path.join(output, 'app.ico'), Buffer.concat([iconHeader, ...pngs.map(item => item.bytes)]));
  const icnsParts = [];
  for (const [type, size] of [['icp4', 16], ['ic11', 32], ['icp5', 32], ['ic12', 64], ['icp6', 64], ['ic07', 128], ['ic13', 256], ['ic08', 256], ['ic14', 512], ['ic09', 512], ['ic10', 1024]]) { const png = await readFile(path.join(output, `app-${size}.png`)); const head = Buffer.alloc(8); head.write(type); head.writeUInt32BE(png.length + 8, 4); icnsParts.push(head, png); }
  const icnsHead = Buffer.alloc(8); icnsHead.write('icns'); icnsHead.writeUInt32BE(icnsParts.reduce((total, bytes) => total + bytes.length, 8), 4); await writeFile(path.join(output, 'app.icns'), Buffer.concat([icnsHead, ...icnsParts]));
  const manifestNames = [...Object.keys(sources), ...jobs.map(job => job.name), 'app.ico', 'app.icns'].sort();
  const manifest = { schemaVersion: 1, product: 'Delta Backupper', generator: 'node script/generate-branding.mjs', renderer: 'Electron 45.1.0 / Chromium canvas', palette, fonts: 'System Segoe UI/Arial in installer and wordmark graphics; logo and application icons contain no text or fonts.', assets: await Promise.all(manifestNames.map(async name => ({ name, sha256: createHash('sha256').update(await readFile(path.join(output, name))).digest('hex') }))) };
  await writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ status: 'generated', directory: output, assets: manifest.assets.length })}\n`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await generateBranding();
