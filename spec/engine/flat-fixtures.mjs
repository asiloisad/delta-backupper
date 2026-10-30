import { mkdtemp, mkdir, writeFile, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createBoundedArchive } from '../../src/archive/bounded-writer.mjs';

const reader = data => ({ size: data.length, readable: new ReadableStream({ start(controller) { if (data.length) controller.enqueue(data); controller.close(); } }) });

/** Independently assembled ZIPs exercise the public maps and actual extraction safeguards. */
export async function flatPoint(t, specification = [{ path: 'a.txt', content: 'alpha' }]) {
  const root = await mkdtemp(join(tmpdir(), 'delta-point-')); t.after(() => rm(root, { recursive: true, force: true }));
  const destination = join(root, 'backup'), runId = '20261029000000000000', output = join(root, 'restore'); await mkdir(destination);
  const task = { wdir: root, proj: destination, srcs: ['source'], mode: 0 }, entries = specification.map(item => ({ path: item.path, kind: item.kind ?? 'file', content: item.content ?? '', size: Buffer.byteLength(item.content ?? ''), mtimeNs: '1700000000000000000' }));
  const run = { id: runId, parts: [], type: 'full' };
  async function commit(options = {}) {
    const name = `${runId}.zip`, temporary = join(destination, `.${randomUUID()}.fixture.zip`), archive = await createBoundedArchive(temporary, { zip64: true, level: 0 });
    const files = {}, archivedFiles = {}, errors = {};
    try {
      for (const entry of entries) {
        if (entry.kind === 'missing') { errors[entry.path] = join(root, 'source', entry.path).replaceAll('\\', '/'); continue; }
        if (!['file', 'directory'].includes(entry.kind)) throw new Error('Unsupported test entry kind');
        const value = entry.kind === 'directory' ? null : `${entry.mtimeNs}:${entry.size}`; files[entry.path] = value; archivedFiles[entry.path] = value;
        await archive.writer.add(`${entry.path}${entry.kind === 'directory' ? '/' : ''}`, entry.kind === 'directory' ? undefined : reader(Buffer.from(entry.content)), { directory: entry.kind === 'directory', level: 0 });
      }
      const snapshot = { startedAt: '2026-10-29 00:00:00.000000', finishedAt: '2026-10-29 00:00:01.000000', compressionLevel: 0, full: true, totalBytes: entries.reduce((sum, entry) => sum + (entry.kind === 'file' ? entry.size : 0), 0), storedBytes: entries.reduce((sum, entry) => sum + (entry.kind === 'file' ? entry.size : 0), 0), files, archivedFiles, errors, ...options.snapshot };
      await archive.writer.add('.snapshot.json', reader(Buffer.from(JSON.stringify(snapshot))), { level: 0 }); await archive.writer.close(); await rename(temporary, join(destination, name));
      run.parts = [{ name, bytes: (await stat(join(destination, name))).size }];
      await writeFile(join(destination, '.delta.json'), JSON.stringify({ workingDirectory: root, backupDirectory: destination, sources: ['source'], pathMode: 0, history: [name], files }));
    } catch (error) { await archive.abort?.(error).catch(() => {}); await rm(temporary, { force: true }); throw error; }
  }
  async function tamperSnapshot() {
    const filename = join(destination, `${runId}.zip`), bytes = await readFile(filename), marker = bytes.indexOf(Buffer.from('"startedAt"'));
    if (marker < 0) throw new Error('Snapshot fixture marker is absent'); bytes[marker] ^= 1; await writeFile(filename, bytes);
  }
  await commit(); return { root, destination, runDir: destination, runId, output, task, entries, run, commit, tamperSnapshot };
}
