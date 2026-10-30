import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, lstat, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

function paths(configDirectory, options = {}) {
  const platform = options.platform ?? process.platform, fsPath = platform === 'win32' ? path.win32 : path.posix;
  const environment = options.environment ?? process.env, home = options.homeDirectory ?? homedir();
  const absolute = (value, name) => { if (typeof value !== 'string' || !value || value.includes('\0') || !fsPath.isAbsolute(value)) throw new Error(`${name} must be an absolute path`); return fsPath.normalize(value); };
  let identity = absolute(fsPath.resolve(configDirectory), 'Configuration directory');
  if (platform === process.platform) {
    const suffix = []; let ancestor = identity;
    for (;;) { try { identity = fsPath.join(realpathSync.native(ancestor), ...suffix); break; } catch (error) { if (error.code !== 'ENOENT') throw error; const parent = fsPath.dirname(ancestor); if (parent === ancestor) throw error; suffix.unshift(fsPath.basename(ancestor)); ancestor = parent; } }
  }
  let base, application;
  if (platform === 'win32') { base = environment.LOCALAPPDATA ? absolute(environment.LOCALAPPDATA, 'LOCALAPPDATA') : fsPath.join(absolute(home, 'Home directory'), 'AppData', 'Local'); application = 'Delta Backupper'; }
  else if (platform === 'darwin') { base = fsPath.join(absolute(home, 'Home directory'), 'Library', 'Application Support'); application = 'DeltaBackupper'; }
  else { base = environment.XDG_STATE_HOME ? absolute(environment.XDG_STATE_HOME, 'XDG_STATE_HOME') : fsPath.join(absolute(home, 'Home directory'), '.local', 'state'); application = 'delta-backupper'; }
  const app = fsPath.join(base, application), profiles = fsPath.join(app, 'profiles');
  return { directory: fsPath.join(profiles, createHash('sha256').update(identity).digest('hex')), owned: [app, profiles] };
}

/** Resolves OS-local application state without creating files or requiring Electron. */
export function runtimeDirectory(configDirectory, options = {}) { return paths(configDirectory, options).directory; }

export async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 }); const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || process.platform !== 'win32' && process.getuid && info.uid !== process.getuid()) throw new Error('Application runtime directory is not a private owned ordinary directory');
  if (process.platform !== 'win32') await chmod(directory, 0o700);
  return directory;
}

export async function ensureRuntimeDirectory(configDirectory) {
  const resolved = paths(configDirectory);
  for (const directory of [...resolved.owned, resolved.directory]) await ensurePrivateDirectory(directory);
  return resolved.directory;
}
