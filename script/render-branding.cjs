const { app, BrowserWindow } = require('electron');
const { readFile, writeFile, mkdir } = require('node:fs/promises');
const path = require('node:path');
const [jobFile, profile] = process.argv.slice(2);
if (!path.isAbsolute(jobFile ?? '') || !path.isAbsolute(profile ?? '')) throw new Error('The brand renderer requires isolated absolute paths');
app.setPath('userData', profile);
app.whenReady().then(async () => {
  let window;
  try {
    const { jobs, output } = JSON.parse(await readFile(jobFile, 'utf8')); await mkdir(output, { recursive: true });
    window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await window.loadURL('data:text/html,<meta charset="UTF-8"><title>Delta brand renderer</title>');
    for (const job of jobs) {
      const render = async ({ svg, width, height }) => {
        const image = new Image(); image.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
        const context = canvas.getContext('2d'); context.drawImage(image, 0, 0, width, height);
        const bytes = context.getImageData(0, 0, width, height).data;
        let raw = ''; for (let at = 0; at < bytes.length; at += 8192) raw += String.fromCharCode(...bytes.subarray(at, at + 8192));
        return { png: canvas.toDataURL('image/png').split(',')[1], rgba: btoa(raw) };
      };
      const result = await window.webContents.executeJavaScript(`(${render.toString()})(${JSON.stringify(job)})`);
      let bytes = Buffer.from(result.png, 'base64');
      if (job.bitmap) {
        const stride = Math.ceil(job.width * 3 / 4) * 4, pixels = Buffer.alloc(stride * job.height), rgba = Buffer.from(result.rgba, 'base64');
        for (let y = 0; y < job.height; y++) for (let x = 0; x < job.width; x++) { const from = (y * job.width + x) * 4, to = (job.height - y - 1) * stride + x * 3; pixels[to] = rgba[from + 2]; pixels[to + 1] = rgba[from + 1]; pixels[to + 2] = rgba[from]; }
        const head = Buffer.alloc(54); head.write('BM'); head.writeUInt32LE(head.length + pixels.length, 2); head.writeUInt32LE(54, 10); head.writeUInt32LE(40, 14); head.writeInt32LE(job.width, 18); head.writeInt32LE(job.height, 22); head.writeUInt16LE(1, 26); head.writeUInt16LE(24, 28); head.writeUInt32LE(pixels.length, 34); bytes = Buffer.concat([head, pixels]);
      }
      await writeFile(path.join(output, job.name), bytes);
    }
    window.destroy(); app.exit(0);
  } catch (error) { console.error(error); window?.destroy(); app.exit(1); }
});
