import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import nsisTools from 'app-builder-lib/out/toolsets/windows.js';
import { root } from './build.mjs';

const execute = promisify(execFile);
const escape = value => value.replaceAll('$', () => '$$').replaceAll('"', () => '$\\"');
const templateKeys = ['OUTPUT', 'LICENSE', 'BRANDING_DIR', 'VERSION', 'FILE_VERSION', 'INSTALL_FILES', 'UNINSTALL_FILES', 'REMOVE_DIRECTORIES'];
export function renderWindowsInstallerSource(template, values) {
  const seen = new Set();
  const rendered = template.replace(/@@DELTA_([A-Z_]+)@@/g, (token, key) => {
    if (!templateKeys.includes(key) || seen.has(key) || typeof values[key] !== 'string') throw new Error('Invalid Windows installer template token: ' + token);
    seen.add(key); return values[key];
  });
  if (seen.size !== templateKeys.length) throw new Error('Windows installer template is missing required tokens.');
  return rendered;
}
/** Per-user NSIS using built-in Modern UI 2 + nsExec, with no community DLLs. */
export async function buildWindowsInstaller(applicationDirectory, outputDirectory) {
  if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch)) throw new Error('The Windows installer must be built on a supported native Windows host.');
  const tool = await nsisTools.getMakeNsisPath('1.2.1');
  const bundle = path.dirname(tool.path);
  const nsisDirectory = path.join(bundle, 'windows');
  const compiler = path.join(nsisDirectory, 'makensis.exe');
  const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const versionMatch = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!versionMatch || versionMatch.slice(1).some(part => Number(part) > 65535)) throw new Error('The Windows installer requires a valid numeric product version.');
  const output = path.join(outputDirectory, `Delta-Backupper-${version}-win-${process.arch}-setup.exe`);
  const files = [], directories = [];
  async function walk(directory, prefix = '') {
    for (const item of await readdir(directory, {withFileTypes:true})) {
      const relative = path.join(prefix,item.name);
      if (item.isSymbolicLink()) throw new Error('Installer input must not contain symlinks');
      if (item.isDirectory()) { directories.push(relative); await walk(path.join(directory,item.name),relative); }
      else if (item.isFile()) files.push(relative);
    }
  }
  await walk(applicationDirectory);
  const install = files.map(file => `SetOutPath "$INSTDIR${path.dirname(file)==='.'?'':`\\${escape(path.dirname(file))}`}"\nFile "${escape(path.join(applicationDirectory,file))}"`).join('\n');
  const uninstall = files.map(file => `Delete "$INSTDIR\\${escape(file)}"`).join('\n');
  const removeDirectories = directories.sort((a,b)=>b.length-a.length).map(directory => `RMDir "$INSTDIR\\${escape(directory)}"`).join('\n');
  await mkdir(outputDirectory,{recursive:true});
  const source = path.join(outputDirectory,'delta-installer.nsi');
  const template = await readFile(path.join(root, 'resources/win/installer.nsi'), 'utf8');
  await writeFile(source, renderWindowsInstallerSource(template, {
    OUTPUT: escape(output), LICENSE: escape(path.join(root, 'LICENSE')),
    BRANDING_DIR: escape(path.join(root, 'resources/branding')), VERSION: escape(version), FILE_VERSION: `${versionMatch[1]}.${versionMatch[2]}.${versionMatch[3]}.0`,
    INSTALL_FILES: install, UNINSTALL_FILES: uninstall, REMOVE_DIRECTORIES: removeDirectories,
  }), 'utf8');
  const result = await execute(compiler,['/V3',source],{cwd:root,env:{...process.env,NSISDIR:nsisDirectory},maxBuffer:8*1024**2});
  await writeFile(path.join(outputDirectory,'installer-build.log'), result.stdout+result.stderr);
  return output;
}
