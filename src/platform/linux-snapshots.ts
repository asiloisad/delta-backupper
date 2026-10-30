import * as filesystem from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { posix as path } from "node:path";
import type { ResolvedSource } from "../domain/models.js";
export type SnapshotSourceRoot = Pick<ResolvedSource, "id" | "path">;
import type { PosixSnapshotMapping } from "./posix-snapshot-paths.mjs";

export interface LinuxSnapshotIO {
  readFile(filename: string, encoding: "utf8"): Promise<string>;
  lstat(filename: string, options: { bigint: true }): Promise<BigIntStats>;
  realpath(filename: string): Promise<string>;
  mkdir(filename: string, options: { mode: number }): Promise<unknown>;
  rmdir(filename: string): Promise<void>;
  readdir(filename: string): Promise<string[]>;
  unlink(filename: string): Promise<void>;
  open(filename: string, flags: string, mode?: number): Promise<{ writeFile(data: string): Promise<void>; sync(): Promise<void>; close(): Promise<void> }>;
}
export interface LinuxSnapshotContext {
  sessionId: string;
  workspace: string;
  run(executable: string, args: string[], options?: { signal?: AbortSignal; timeoutMs?: number; maxOutput?: number }): Promise<{ stdout: string; stderr: string }>;
  signal?: AbortSignal;
  lvmCowSizeBytes?: number;
  fs?: LinuxSnapshotIO;
  journal?(state: Record<string, unknown>): Promise<void>;
}
export interface LinuxSnapshotLease {
  backend: "btrfs" | "zfs" | "lvm" | "mixed";
  mappings: PosixSnapshotMapping[];
  atomicSet: boolean;
  verify(): Promise<void>;
  release(): Promise<void>;
}
export interface LinuxMount {
  id: number; parentId: number; device: string; root: string; point: string;
  options: string[]; type: string; source: string; superOptions: string[];
}
type Resource = { label: string; verify(cleanup?: boolean): Promise<void>; release(): Promise<void> };
interface RecoveryAction { kind: "directory" | "mount" | "btrfs" | "zfs" | "lvm" | "session-marker"; [key: string]: unknown }
interface RecoveryState { schemaVersion: 1; platform: "linux"; sessionId: string; workspace: string; actions: RecoveryAction[] }
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const inside = (parent: string, child: string) => parent === "/" || child === parent || child.startsWith(`${parent}/`);
const normalized = (value: string) => value === "/" ? value : value.replace(/\/$/, "");
function failure(message: string, code = "SNAPSHOT_UNSUPPORTED"): Error & { code: string; cleanupVerified?: boolean } { return Object.assign(new Error(message), { code }); }
function checkedPath(value: string): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.length > 32768 || /[\0-\x1f\x7f]/.test(value) || !value.isWellFormed() || path.normalize(value) !== value) throw failure("Snapshot path must be a normalized absolute POSIX path");
  return normalized(value);
}
function decoded(value: string): string {
  if (/\\(?!040|011|012|134)/.test(value)) throw failure("Unsupported escape in Linux mount information");
  return value.replace(/\\(040|011|012|134)/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}
export function parseLinuxMountInfo(text: string): LinuxMount[] {
  if (typeof text !== "string" || Buffer.byteLength(text) > 8 * 1024 * 1024) throw failure("Linux mount information exceeds its bound");
  const rows: LinuxMount[] = []; const ids = new Set<number>();
  for (const line of text.trim().split("\n")) {
    if (!line) continue; const fields = line.split(" "); const separator = fields.indexOf("-");
    if (separator < 6 || fields.length !== separator + 4 || !/^\d+$/.test(fields[0]) || !/^\d+$/.test(fields[1]) || !/^\d+:\d+$/.test(fields[2])) throw failure("Malformed Linux mount information");
    const id = Number(fields[0]); const parentId = Number(fields[1]);
    if (!Number.isSafeInteger(id) || !Number.isSafeInteger(parentId) || ids.has(id) || rows.length >= 65536) throw failure("Ambiguous Linux mount identity");
    ids.add(id);
    rows.push({ id, parentId, device: fields[2], root: checkedPath(decoded(fields[3])), point: checkedPath(decoded(fields[4])), options: fields[5].split(","), type: fields[separator + 1], source: decoded(fields[separator + 2]), superOptions: fields[separator + 3].split(",") });
  }
  return rows;
}
export function visibleLinuxMounts(rows: LinuxMount[]): LinuxMount[] {
  const byId = new Map(rows.map(row => [row.id, row])); const top = new Map<string, LinuxMount>(); const groups = new Map<string, LinuxMount[]>();
  for (const row of rows) { const group = groups.get(row.point) ?? []; group.push(row); groups.set(row.point, group); }
  for (const [point, same] of groups) {
    const parents = new Set(same.filter(other => other.parentId !== other.id).map(other => other.parentId));
    const candidates = same.filter(other => !parents.has(other.id));
    if (candidates.length !== 1) throw failure("Ambiguous stacked Linux mounts");
    top.set(point, candidates[0]);
  }
  return rows.filter(row => {
    if (top.get(row.point)?.id !== row.id) return false;
    const ancestors = new Set<number>([row.id]); let current = row;
    while (byId.has(current.parentId) && current.parentId !== current.id) {
      if (ancestors.has(current.parentId)) throw failure("Cyclic Linux mount topology");
      ancestors.add(current.parentId); current = byId.get(current.parentId)!;
    }
    let parentPath = path.dirname(row.point);
    for (;;) { const parent = top.get(parentPath); if (parent && parent.point !== row.point && !ancestors.has(parent.id)) return false; if (parentPath === "/") break; parentPath = path.dirname(parentPath); }
    return true;
  }).sort((a, b) => b.point.length - a.point.length);
}
function mountIdentity(value: LinuxMount): string { return JSON.stringify([value.id, value.parentId, value.device, value.root, value.point, value.type, value.source, value.options, value.superOptions]); }
function btrfsShow(text: string): { uuid: string; id: string; parentUuid: string; readOnly: boolean } {
  const field = (label: string) => new RegExp(`^\\s*${label}:\\s*(.*?)\\s*$`, "m").exec(text)?.[1];
  const uuid = field("UUID"); const id = field("Subvolume ID"); const parentUuid = field("Parent UUID");
  if (!uuid || !uuidPattern.test(uuid) || !id || !/^\d+$/.test(id) || !parentUuid || !(parentUuid === "-" || uuidPattern.test(parentUuid))) throw failure("Cannot attest Btrfs subvolume identity");
  return { uuid: uuid.toLowerCase(), id, parentUuid: parentUuid.toLowerCase(), readOnly: (field("Flags") ?? "").split(/\s+/).includes("readonly") };
}
export function parseBtrfsSubvolumes(text: string): { id: string; uuid: string; fsPath: string }[] {
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw failure("Btrfs subvolume listing exceeds its bound");
  const rows: { id: string; uuid: string; fsPath: string }[] = []; const ids = new Set<string>();
  for (const line of text.trim().split("\n")) {
    if (!line) continue; const match = /^ID (\d+)\s+.*?\buuid ([0-9a-f-]{36})\s+path (.+)$/i.exec(line);
    if (!match || !uuidPattern.test(match[2]) || ids.has(match[1])) throw failure("Unsupported Btrfs subvolume listing; names with control characters are unsupported");
    const relative = match[3].replace(/^<FS_TREE>\/?/, "");
    if (!relative || relative.startsWith("/") || relative.split("/").some(part => !part || part === "." || part === "..")) throw failure("Unsafe Btrfs subvolume path");
    ids.add(match[1]); rows.push({ id: match[1], uuid: match[2].toLowerCase(), fsPath: checkedPath(`/${relative}`) });
  }
  return rows;
}
function datasetName(value: string): string {
  if (typeof value !== "string" || value.length > 255 || !/^[A-Za-z][A-Za-z0-9_.:-]*(?:\/[A-Za-z0-9_.:-]+)*$/.test(value) || value.split("/").some(part => part === "." || part === "..")) throw failure("Unsupported ZFS dataset name");
  return value;
}
interface LvmRow { [key: string]: string }
function lvmRows(text: string): LvmRow[] {
  const parsed = JSON.parse(text) as { report?: { lv?: Record<string, unknown>[] }[] };
  if (!Array.isArray(parsed.report) || parsed.report.length !== 1 || !Array.isArray(parsed.report[0].lv)) throw failure("Invalid LVM JSON report");
  return parsed.report[0].lv.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === "string" ? value.trim() : String(value)])));
}
function lvmUuid(value: string): boolean { return /^[A-Za-z0-9]{6}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{6}$/.test(value); }
function linuxDeviceNumber(major: string, minor: string): bigint {
  if (!/^\d+$/.test(major) || !/^\d+$/.test(minor)) throw failure("Invalid Linux device number");
  const a = BigInt(major), b = BigInt(minor); if (a > 0xffffffffn || b > 0xffffffffn) throw failure("Linux device number is out of range");
  return ((a & 0xfffn) << 8n) | ((a & 0xfffff000n) << 32n) | (b & 0xffn) | ((b & 0xffffff00n) << 12n);
}
const lvmFields = "vg_name,lv_name,lv_uuid,lv_path,origin,origin_uuid,pool_lv,lv_attr,data_percent,metadata_percent,snap_percent,lv_health_status,lv_kernel_major,lv_kernel_minor,lv_tags";

// The caller first proves that the journal belongs to a dead helper (PID start
// time + boot ID), and recreates its root-owned workspace if necessary. This
// function never assumes that a name alone proves snapshot ownership.
export async function recoverLinuxSnapshots(value: Record<string, unknown>, context: LinuxSnapshotContext): Promise<void> {
  const io = context.fs ?? filesystem;
  const state = value as unknown as RecoveryState;
  const malformed = () => failure("Invalid Linux snapshot recovery journal", "SNAPSHOT_CLEANUP_UNVERIFIED");
  if (!state || state.schemaVersion !== 1 || state.platform !== "linux" || state.sessionId !== context.sessionId || state.workspace !== context.workspace || !uuidPattern.test(state.sessionId) || !/^\/run\/delta-backupper\/\d+\/[0-9a-f-]{36}$/i.test(state.workspace) || path.basename(state.workspace) !== state.sessionId || !Array.isArray(state.actions) || state.actions.length > 16384 || Object.keys(state).some(key => !["schemaVersion", "platform", "sessionId", "workspace", "actions"].includes(key))) throw malformed();
  const workspace = checkedPath(state.workspace); const privateDirectory = path.join(workspace, "private"); const short = state.sessionId.replaceAll("-", "");
  const allowed: Record<RecoveryAction["kind"], string[]> = {
    directory: ["kind", "path", "retained", "device", "inode", "namespaceUuid", "namespaceReady", "done"], mount: ["kind", "point", "type", "source", "root", "readOnly", "mountIdentity", "done"],
    btrfs: ["kind", "object", "originUuid", "filesystemUuid", "device", "deviceRdev", "topPath", "snapshotUuid", "snapshotId", "done"],
    zfs: ["kind", "name", "originGuid", "hold", "snapshotGuid", "held", "done"], lvm: ["kind", "vg", "name", "originUuid", "tag", "snapshotUuid", "snapshotDevice", "snapshotRdev", "kernelDevice", "done"],
    "session-marker": ["kind", "path", "filesystemUuid", "device", "inode", "done"],
  };
  const text = (action: RecoveryAction, key: string) => { if (typeof action[key] !== "string" || !(action[key] as string).length || (action[key] as string).length > 32768 || /[\0-\x1f\x7f]/.test(action[key] as string)) throw malformed(); return action[key] as string; };
  const child = (filename: string, expression = /^(?:btrfs-top|snapshot)-\d+$/) => path.dirname(filename) === (path.basename(filename).startsWith("btrfs-top-") ? privateDirectory : workspace) && expression.test(path.basename(filename));
  for (const action of state.actions) {
    if (!action || typeof action !== "object" || !allowed[action.kind] || Object.keys(action).some(key => !allowed[action.kind].includes(key)) || (action.done !== undefined && typeof action.done !== "boolean")) throw malformed();
    if (action.kind === "directory") {
      const filename = checkedPath(text(action, "path"));
      const namespace = path.basename(filename) === ".delta-backupper-snapshots" ? filename : path.dirname(filename);
      if (filename !== privateDirectory && !child(filename) && !(path.basename(namespace) === ".delta-backupper-snapshots" && child(path.dirname(namespace), /^btrfs-top-\d+$/) && (filename === namespace || path.basename(filename) === state.sessionId))) throw malformed();
      if (action.retained !== undefined && typeof action.retained !== "boolean") throw malformed();
      if (action.namespaceUuid !== undefined && (!uuidPattern.test(text(action, "namespaceUuid")) || path.basename(filename) !== ".delta-backupper-snapshots" || action.retained !== true)) throw malformed();
      if (action.namespaceReady !== undefined && typeof action.namespaceReady !== "boolean") throw malformed();
      for (const key of ["device", "inode"]) if (action[key] !== undefined && !/^\d+$/.test(text(action, key))) throw malformed();
    } else if (action.kind === "mount") {
      if (!child(checkedPath(text(action, "point"))) || !["btrfs", "zfs", "ext4", "xfs"].includes(text(action, "type")) || typeof action.readOnly !== "boolean") throw malformed();
      checkedPath(text(action, "root")); const source = text(action, "source");
      if (action.type === "zfs") { if (!source.endsWith(`@delta-backupper-${state.sessionId}`)) throw malformed(); datasetName(source.split("@")[0]); }
      else if (!source.startsWith("/dev/") || checkedPath(source) !== source) throw malformed();
      if (action.mountIdentity !== undefined && typeof action.mountIdentity !== "string") throw malformed();
    } else if (action.kind === "btrfs") {
      const top = checkedPath(text(action, "topPath")); const object = checkedPath(text(action, "object"));
      if (!child(top, /^btrfs-top-\d+$/) || path.dirname(object) !== path.join(top, ".delta-backupper-snapshots", state.sessionId) || !/^snapshot-\d+$/.test(path.basename(object)) || !uuidPattern.test(text(action, "filesystemUuid")) || !(action.originUuid === "-" || uuidPattern.test(text(action, "originUuid"))) || !text(action, "device").startsWith("/dev/") || !/^\d+$/.test(text(action, "deviceRdev"))) throw malformed();
      if (action.snapshotUuid !== undefined && !uuidPattern.test(text(action, "snapshotUuid"))) throw malformed(); if (action.snapshotId !== undefined && !/^\d+$/.test(text(action, "snapshotId"))) throw malformed();
    } else if (action.kind === "zfs") {
      const name = text(action, "name"); const [dataset, snapshot] = name.split("@"); datasetName(dataset);
      if (snapshot !== `delta-backupper-${state.sessionId}` || name !== `${dataset}@${snapshot}` || !/^\d+$/.test(text(action, "originGuid")) || action.hold !== `delta-backupper-${state.sessionId}` || (action.snapshotGuid !== undefined && !/^\d+$/.test(text(action, "snapshotGuid")))) throw malformed();
    } else if (action.kind === "session-marker") {
      const filename = checkedPath(text(action, "path")); const namespace = path.dirname(path.dirname(filename));
      if (path.basename(filename) !== ".delta-session.json" || path.basename(path.dirname(filename)) !== state.sessionId || path.basename(namespace) !== ".delta-backupper-snapshots" || !child(path.dirname(namespace), /^btrfs-top-\d+$/) || !uuidPattern.test(text(action, "filesystemUuid"))) throw malformed();
      for (const key of ["device", "inode"]) if (action[key] !== undefined && !/^\d+$/.test(text(action, key))) throw malformed();
    } else {
      if (!/^[A-Za-z0-9_+.-]+$/.test(text(action, "vg")) || !new RegExp(`^delta_${short}_\\d+$`).test(text(action, "name")) || !lvmUuid(text(action, "originUuid")) || action.tag !== `delta_backupper_${short}` || (action.snapshotUuid !== undefined && !lvmUuid(text(action, "snapshotUuid")))) throw malformed();
      if (action.snapshotDevice !== undefined && (!text(action, "snapshotDevice").startsWith("/dev/") || checkedPath(text(action, "snapshotDevice")) !== action.snapshotDevice)) throw malformed();
      if (action.snapshotRdev !== undefined && !/^\d+$/.test(text(action, "snapshotRdev"))) throw malformed();
      if (action.kernelDevice !== undefined && !/^\d+:\d+$/.test(text(action, "kernelDevice"))) throw malformed();
    }
  }
  const command = async (exe: string, args: string[]) => { const result = await context.run(exe, args, { timeoutMs: 120000, maxOutput: 4 * 1024 * 1024 }); if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > 4 * 1024 * 1024) throw failure("Recovery command output exceeded its bound"); return result.stdout; };
  const stat = (filename: string) => io.lstat(filename, { bigint: true });
  const exists = async (filename: string) => { try { return await stat(filename); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } };
  const mounts = async () => visibleLinuxMounts(parseLinuxMountInfo(await io.readFile("/proc/self/mountinfo", "utf8")));
  const exact = async (point: string) => (await mounts()).find(mount => mount.point === point);
  const protectedPath = async (filename: string) => { const info = await stat(filename); if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0n || (info.mode & 0o022n) !== 0n || await io.realpath(filename) !== filename) throw failure("Recovery path is not root-owned and protected"); return info; };
  let prefix = "/"; for (const part of workspace.split("/").filter(Boolean)) { prefix = path.join(prefix, part); await protectedPath(prefix); }
  const btrfsActions = state.actions.filter(action => action.kind === "btrfs" && !action.done);
  const checkedTop = new Set<string>();
  async function recoveryDirectory(filename: string, mode: number): Promise<void> {
    const action = state.actions.find(value => value.kind === "directory" && value.path === filename && !value.retained);
    if (!action) throw failure("Recovery directory has no recorded ownership intent");
    if (!await exists(filename)) {
      action.done = false; delete action.device; delete action.inode; await context.journal?.(structuredClone(state) as unknown as Record<string, unknown>);
      await io.mkdir(filename, { mode }); const directory = await protectedPath(filename); action.device = String(directory.dev); action.inode = String(directory.ino); await context.journal?.(structuredClone(state) as unknown as Record<string, unknown>);
    }
    const info = await protectedPath(filename);
    if ((action.device !== undefined && action.device !== String(info.dev)) || (action.inode !== undefined && action.inode !== String(info.ino)) || (mode === 0o700 && (info.mode & 0o077n) !== 0n)) throw failure("Recovery directory identity or permissions changed");
  }
  async function attestTop(action: RecoveryAction): Promise<void> {
    const top = text(action, "topPath"); if (checkedTop.has(top)) return;
    const device = await stat(text(action, "device"));
    if (!device.isBlockDevice() || String(device.rdev) !== action.deviceRdev) throw failure("Recovery Btrfs block device identity changed");
    await recoveryDirectory(privateDirectory, 0o700);
    let mounted = await exact(top);
    if (!mounted) {
      const directoryAction = state.actions.find(value => value.kind === "directory" && value.path === top && !value.retained);
      const mountAction = state.actions.find(value => value.kind === "mount" && value.point === top && value.type === "btrfs" && value.source === action.device && value.root === "/");
      if (!directoryAction || !mountAction) throw failure("Btrfs recovery top-level mount has no recorded ownership intent");
      await recoveryDirectory(top, 0o755);
      await protectedPath(top); mountAction.done = false; delete mountAction.mountIdentity; await context.journal?.(structuredClone(state) as unknown as Record<string, unknown>);
      await command("mount", ["-t", "btrfs", "-o", "rw,nosuid,nodev,noexec,subvolid=5", "--", text(action, "device"), top]); mounted = await exact(top);
      if (mounted) { mountAction.mountIdentity = mountIdentity(mounted); await context.journal?.(structuredClone(state) as unknown as Record<string, unknown>); }
    }
    if (!mounted || mounted.type !== "btrfs" || mounted.root !== "/" || !mounted.options.includes("rw")) throw failure("Recovery Btrfs top-level mount identity changed");
    const shown = await command("btrfs", ["filesystem", "show", "--raw", top]); const uuid = /\buuid:\s*([0-9a-f-]{36})/i.exec(shown)?.[1]?.toLowerCase();
    if (uuid !== action.filesystemUuid || (await command("btrfs", ["inspect-internal", "rootid", top])).trim() !== "5") throw failure("Recovery Btrfs filesystem identity changed");
    await protectedPath(top); await protectedPath(path.join(top, ".delta-backupper-snapshots")); await namespaceMarker(io, path.join(top, ".delta-backupper-snapshots"), text(action, "filesystemUuid")); await protectedPath(path.join(top, ".delta-backupper-snapshots", state.sessionId)); checkedTop.add(top);
  }
  const errors: Error[] = [];
  for (const action of [...state.actions].reverse()) {
    if (action.done) continue;
    try {
      if (action.kind === "mount") {
        const point = text(action, "point"); const mounted = await exact(point); if (!mounted) continue;
        if (action.mountIdentity !== undefined) {
          if (mountIdentity(mounted) !== action.mountIdentity) throw failure("Refusing to unmount a changed recovery mount");
        } else {
          if (mounted.type !== action.type || mounted.source !== action.source || mounted.root !== action.root || (action.readOnly && !mounted.options.includes("ro"))) throw failure("Refusing to unmount an unattested recovery mount");
          const owner = action.type === "btrfs" ? btrfsActions.find(value => value.device === action.source && (action.root === "/" || action.root === `/.delta-backupper-snapshots/${state.sessionId}/${path.basename(text(value, "object"))}`)) : action.type === "zfs" ? state.actions.find(value => value.kind === "zfs" && value.name === action.source) : state.actions.find(value => value.kind === "lvm" && action.source === value.snapshotDevice && mounted.device === value.kernelDevice);
          if (!owner) throw failure("Recovery mount has no attested snapshot owner");
          if (owner.kind === "btrfs") await attestTop(owner);
        }
        await command("umount", ["--", point]); if (await exact(point)) throw failure("Recovery unmount was not confirmed");
      } else if (action.kind === "directory") {
        const filename = text(action, "path");
        if (action.retained) { if (action.namespaceUuid && !action.namespaceReady) throw failure("Btrfs namespace initialization was interrupted; ownership needs inspection"); if (action.namespaceUuid && await exists(filename)) await namespaceMarker(io, filename, text(action, "namespaceUuid")); continue; }
        const info = await exists(filename); if (!info) continue;
        if (await exact(filename)) throw failure("Refusing to remove a mounted recovery directory");
        await protectedPath(filename);
        if ((action.device !== undefined && String(info.dev) !== action.device) || (action.inode !== undefined && String(info.ino) !== action.inode)) throw failure("Recovery directory identity changed");
        await io.rmdir(filename);
      } else if (action.kind === "btrfs") {
        await attestTop(action); const object = text(action, "object"); const info = await exists(object);
        if (!info) {
          if (action.snapshotUuid && parseBtrfsSubvolumes(await command("btrfs", ["subvolume", "list", "-a", "-u", text(action, "topPath")])).some(row => row.uuid === action.snapshotUuid)) throw failure("Owned Btrfs snapshot moved away from its recorded path");
          continue;
        }
        const current = btrfsShow(await command("btrfs", ["subvolume", "show", object]));
        if (!current.readOnly || current.parentUuid !== action.originUuid || (action.snapshotUuid !== undefined && current.uuid !== action.snapshotUuid) || (action.snapshotId !== undefined && current.id !== action.snapshotId)) throw failure("Refusing to delete a foreign Btrfs recovery object");
        await command("btrfs", ["subvolume", "delete", "--commit-after", "--", object]); if (await exists(object)) throw failure("Btrfs recovery deletion was not confirmed");
      } else if (action.kind === "zfs") {
        const name = text(action, "name"); const pool = name.split("/")[0].split("@")[0];
        const inventory = (await command("zfs", ["list", "-H", "-p", "-t", "snapshot", "-o", "name,guid,org.delta-backupper:session", "-r", pool])).trim().split("\n").filter(Boolean).map(line => line.split("\t"));
        const existing = inventory.find(row => row[0] === name);
        const recordedNames = new Set(state.actions.filter(value => value.kind === "zfs").map(value => value.name));
        if (!existing) { if (inventory.some(row => row[1] === action.snapshotGuid || (row[2] === state.sessionId && !recordedNames.has(row[0])))) throw failure("Owned ZFS snapshot moved away from its recorded name"); continue; }
        if (existing[2] !== state.sessionId || !/^\d+$/.test(existing[1]) || (action.snapshotGuid !== undefined && existing[1] !== action.snapshotGuid)) throw failure("Refusing to destroy a foreign ZFS recovery snapshot");
        const dataset = name.split("@")[0]; if ((await command("zfs", ["get", "-H", "-p", "-o", "value", "guid", dataset])).trim() !== action.originGuid) throw failure("ZFS recovery origin GUID changed");
        const holds = await command("zfs", ["holds", "-H", name]); if (holds.split("\n").some(line => line.split("\t")[1] === action.hold)) await command("zfs", ["release", text(action, "hold"), name]);
        const current = (await command("zfs", ["get", "-H", "-p", "-o", "property,value", "guid,org.delta-backupper:session", name])).trim().split("\n").map(line => line.split("\t")); const values = new Map(current.map(row => [row[0], row[1]]));
        if (values.get("guid") !== existing[1] || values.get("org.delta-backupper:session") !== state.sessionId) throw failure("ZFS recovery snapshot identity changed");
        await command("zfs", ["destroy", name]);
        const after = await command("zfs", ["list", "-H", "-p", "-t", "snapshot", "-o", "name,guid", "-d", "1", dataset]); if (after.split("\n").some(line => line.split("\t")[0] === name)) throw failure("ZFS recovery deletion was not confirmed");
      } else if (action.kind === "session-marker") {
        const filename = text(action, "path"); const info = await exists(filename); if (!info) continue;
        if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0n || (info.mode & 0o077n) !== 0n || (action.device !== undefined && action.device !== String(info.dev)) || (action.inode !== undefined && action.inode !== String(info.ino))) throw failure("Refusing to remove a foreign session marker");
        await sessionMarker(io, path.dirname(filename), text(action, "filesystemUuid"), state.sessionId); await io.unlink(filename);
      } else {
        const inventory = async () => lvmRows(await command("lvs", ["--reportformat", "json", "--units", "b", "--nosuffix", "-o", lvmFields]));
        const rows = await inventory(); const current = rows.find(row => row.vg_name === action.vg && row.lv_name === action.name);
        const recordedNames = new Set(state.actions.filter(value => value.kind === "lvm").map(value => `${value.vg}/${value.name}`));
        if (!current) { if (rows.some(row => row.lv_uuid === action.snapshotUuid || (row.lv_tags.split(",").includes(text(action, "tag")) && !recordedNames.has(`${row.vg_name}/${row.lv_name}`)))) throw failure("Owned LVM snapshot moved away from its recorded name"); continue; }
        if (!lvmUuid(current.lv_uuid) || current.origin_uuid !== action.originUuid || !current.lv_tags.split(",").includes(text(action, "tag")) || (action.snapshotUuid !== undefined && current.lv_uuid !== action.snapshotUuid) || current.lv_attr[0] !== "s") throw failure("Refusing to remove a foreign LVM recovery snapshot");
        await command("lvremove", ["--yes", "--select", `lv_uuid=${current.lv_uuid}`, "--", `${action.vg}/${action.name}`]);
        if ((await inventory()).some(row => row.lv_uuid === current.lv_uuid)) throw failure("LVM recovery removal was not confirmed");
      }
      action.done = true; await context.journal?.(structuredClone(state) as unknown as Record<string, unknown>);
    } catch (error) { errors.push(new Error(`${action.kind}: ${(error as Error).message}`, { cause: error })); }
  }
  if (errors.length) throw Object.assign(new AggregateError(errors, "Linux orphan snapshot recovery could not be verified"), { code: "SNAPSHOT_CLEANUP_UNVERIFIED", cleanupVerified: false });
}

async function namespaceMarker(io: LinuxSnapshotIO, namespace: string, filesystemUuid: string): Promise<void> {
  const filename = path.join(namespace, ".delta-namespace.json"); const info = await io.lstat(filename, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0n || (info.mode & 0o077n) !== 0n || info.size > 4096n) throw failure("Btrfs snapshot namespace marker is not protected");
  const data = await io.readFile(filename, "utf8"); const marker = JSON.parse(data) as Record<string, unknown>;
  if (Buffer.byteLength(data) > 4096 || !marker || marker.schemaVersion !== 1 || marker.kind !== "delta-backupper-btrfs-snapshots" || marker.filesystemUuid !== filesystemUuid || Object.keys(marker).sort().join(",") !== "filesystemUuid,kind,schemaVersion") throw failure("Existing Btrfs snapshot namespace is unmarked or belongs to another filesystem");
}
async function sessionMarker(io: LinuxSnapshotIO, directory: string, filesystemUuid: string, sessionId: string): Promise<void> {
  const filename = path.join(directory, ".delta-session.json"); const info = await io.lstat(filename, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0n || (info.mode & 0o077n) !== 0n || info.size > 4096n) throw failure("Btrfs session marker is not protected");
  const value = await io.readFile(filename, "utf8"); const marker = JSON.parse(value) as Record<string, unknown>;
  if (Buffer.byteLength(value) > 4096 || !marker || marker.schemaVersion !== 1 || marker.kind !== "delta-backupper-btrfs-session" || marker.filesystemUuid !== filesystemUuid || marker.sessionId !== sessionId || Object.keys(marker).sort().join(",") !== "filesystemUuid,kind,schemaVersion,sessionId") throw failure("Btrfs session directory is unmarked or foreign");
}

export async function prepareLinuxSnapshots(sources: SnapshotSourceRoot[], context: LinuxSnapshotContext): Promise<LinuxSnapshotLease> {
  const io = context.fs ?? filesystem; const resources: Resource[] = []; const mappings: PosixSnapshotMapping[] = []; const backends = new Set<"btrfs" | "zfs" | "lvm">();
  const snapshotObjects = new Set<string>(); let released = false; let releasePromise: Promise<void> | undefined;
  const recovery: RecoveryState = { schemaVersion: 1, platform: "linux", sessionId: context.sessionId, workspace: context.workspace, actions: [] };
  const persist = async () => context.journal?.(structuredClone(recovery) as unknown as Record<string, unknown>);
  async function intent(action: RecoveryAction): Promise<RecoveryAction> { recovery.actions.push(action); await persist(); return action; }
  const command = async (exe: string, args: string[], cleanup = false, maxOutput = 4 * 1024 * 1024) => {
    if (!cleanup) context.signal?.throwIfAborted();
    const result = await context.run(exe, args, { ...(cleanup ? {} : { signal: context.signal }), timeoutMs: 120000, maxOutput });
    if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > maxOutput) throw failure("Snapshot command exceeded its output bound");
    return result.stdout;
  };
  const mounts = async () => visibleLinuxMounts(parseLinuxMountInfo(await io.readFile("/proc/self/mountinfo", "utf8")));
  const stat = (filename: string) => io.lstat(filename, { bigint: true });
  async function protectedDirectory(filename: string): Promise<BigIntStats> {
    const info = await stat(filename);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0n || (info.mode & 0o022n) !== 0n || await io.realpath(filename) !== filename) throw failure(`Snapshot directory must be root-owned and protected: ${filename}`);
    return info;
  }
  async function ownedDirectory(filename: string, mode = 0o755, allowExisting = false): Promise<{ created: boolean; action: RecoveryAction }> {
    let made = false; let action: RecoveryAction | undefined;
    if (!allowExisting) { try { await stat(filename); throw failure("Snapshot directory already exists"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
    action = await intent({ kind: "directory", path: filename, retained: allowExisting });
    try { await io.mkdir(filename, { mode }); made = true; } catch (error) { if (!allowExisting || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const identity = await protectedDirectory(filename);
    const check = async () => { const now = await protectedDirectory(filename); if (now.dev !== identity.dev || now.ino !== identity.ino || (mode === 0o700 && (now.mode & 0o077n) !== 0n)) throw failure("Owned snapshot directory was replaced or its private permissions changed", "SNAPSHOT_IDENTITY_CHANGED"); };
    resources.push({ label: filename, async verify() { if (!await exactMount(filename)) await check(); }, async release() { if (!made || allowExisting) return; try { await check(); await io.rmdir(filename); if (action) { action.done = true; await persist(); } } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } } });
    action.device = String(identity.dev); action.inode = String(identity.ino); await persist();
    return { created: made, action };
  }
  async function exactMount(point: string): Promise<LinuxMount | undefined> { return (await mounts()).find(value => value.point === point); }
  async function managedMount(point: string, args: string[], accept: (record: LinuxMount) => boolean, expectedRoot = "/"): Promise<void> {
    await ownedDirectory(point);
    if (await exactMount(point)) throw failure("Snapshot mountpoint is already in use");
    let identity: LinuxMount | undefined;
    const action = await intent({ kind: "mount", point, type: args[1], source: args.at(-2), root: expectedRoot, readOnly: args[3].split(",").includes("ro") });
    const check = async () => { const current = await exactMount(point); if (!identity || !current || mountIdentity(current) !== mountIdentity(identity)) throw failure("Snapshot mount identity changed", "SNAPSHOT_IDENTITY_CHANGED"); };
    resources.push({ label: point, verify: check, async release() {
      const current = await exactMount(point); if (!current) return;
      if (!identity || mountIdentity(current) !== mountIdentity(identity)) throw failure("Refusing to unmount a foreign snapshot mount", "SNAPSHOT_IDENTITY_CHANGED");
      await command("umount", ["--", point], true); if (await exactMount(point)) throw failure("Snapshot unmount was not confirmed"); action.done = true; await persist();
    } });
    try { await command("mount", args); }
    finally {
      const current = await exactMount(point);
      if (current && accept(current)) { identity = current; action.mountIdentity = mountIdentity(current); await persist(); }
    }
    await check();
  }
  async function release(): Promise<void> {
    if (releasePromise) return releasePromise;
    released = true;
    releasePromise = (async () => {
      const errors: Error[] = [];
      for (const resource of [...resources].reverse()) try { await resource.release(); } catch (error) { errors.push(new Error(`${resource.label}: ${(error as Error).message}`, { cause: error })); }
      if (recovery.actions.length) try { await recoverLinuxSnapshots(recovery as unknown as Record<string, unknown>, { ...context, signal: undefined }); } catch (error) { errors.push(error as Error); }
      if (errors.length) throw Object.assign(new AggregateError(errors, "Snapshot cleanup could not be verified"), { code: "SNAPSHOT_CLEANUP_UNVERIFIED", cleanupVerified: false });
    })();
    return releasePromise;
  }
  try {
    if (!uuidPattern.test(context.sessionId) || !/^\/run\/delta-backupper\/\d+\/[0-9a-f-]{36}$/i.test(context.workspace) || path.basename(context.workspace) !== context.sessionId || !sources.length) throw failure("Invalid Linux snapshot session context");
    const workspace = checkedPath(context.workspace);
    let prefix = "/"; for (const part of workspace.split("/").filter(Boolean)) { prefix = path.join(prefix, part); await protectedDirectory(prefix); }
    const baseline = await mounts();
    const findMount = (filename: string) => baseline.find(mount => inside(mount.point, filename));
    const sourcePaths: string[] = [];
    for (const source of sources) {
      const original = checkedPath(source.path); const info = await stat(original);
      const canonical = info.isSymbolicLink() ? path.join(await io.realpath(path.dirname(original)), path.basename(original)) : await io.realpath(original);
      if (canonical !== original) throw failure("Snapshot sources must be canonical absolute paths; resolve source directory aliases first");
      const mounted = findMount(canonical); if (!mounted || !["btrfs", "zfs", "ext4", "xfs"].includes(mounted.type)) throw failure(`No supported snapshot backend for source filesystem: ${mounted?.type ?? "unknown"}`);
      sourcePaths.push(canonical);
    }
    const selected = baseline.filter(mount => sourcePaths.some(source => findMount(source)?.id === mount.id || inside(source, mount.point)) && ["btrfs", "zfs", "ext4", "xfs"].includes(mount.type));
    const exclusions = (mounted: LinuxMount) => baseline.filter(other => other.id !== mounted.id && inside(mounted.point, other.point)).map(other => other.point);
    const topology = async () => {
      const current = await mounts();
      const relevant = (rows: LinuxMount[]) => rows.filter(mount => !inside("/run/delta-backupper", mount.point) && selected.some(origin => inside(origin.point, mount.point) || inside(mount.point, origin.point))).map(mountIdentity).sort();
      if (JSON.stringify(relevant(current)) !== JSON.stringify(relevant(baseline))) throw failure("Live filesystem mount topology changed during snapshot backup", "SNAPSHOT_TOPOLOGY_CHANGED");
    };
    const btrfsGroups = new Map<string, LinuxMount[]>();
    for (const mounted of selected.filter(value => value.type === "btrfs")) {
      if (!mounted.source.startsWith("/dev/")) throw failure("Btrfs snapshots require an attested local block device");
      const device = await io.realpath(mounted.source); const info = await stat(device);
      if (!info.isBlockDevice()) throw failure("Btrfs mount source is not a block device");
      const shown = await command("btrfs", ["filesystem", "show", "--raw", mounted.point]); const key = /\buuid:\s*([0-9a-f-]{36})/i.exec(shown)?.[1]?.toLowerCase();
      if (!key || !uuidPattern.test(key)) throw failure("Cannot attest Btrfs filesystem UUID");
      const group = btrfsGroups.get(key) ?? []; group.push(mounted); btrfsGroups.set(key, group);
    }
    const privateDirectory = path.join(workspace, "private");
    if (btrfsGroups.size) await ownedDirectory(privateDirectory, 0o700);
    let index = 0;
    for (const group of btrfsGroups.values()) {
      backends.add("btrfs"); const first = group[0]; const device = await io.realpath(first.source); const deviceInfo = await stat(device);
      const shown = await command("btrfs", ["filesystem", "show", "--raw", first.point]); const fsUuid = /\buuid:\s*([0-9a-f-]{36})/i.exec(shown)?.[1]?.toLowerCase();
      if (!fsUuid || !uuidPattern.test(fsUuid)) throw failure("Cannot attest Btrfs filesystem UUID");
      const top = path.join(privateDirectory, `btrfs-top-${index++}`);
      await managedMount(top, ["-t", "btrfs", "-o", "rw,nosuid,nodev,noexec,subvolid=5", "--", device, top], value => value.type === "btrfs" && value.root === "/");
      if ((await command("btrfs", ["inspect-internal", "rootid", top])).trim() !== "5") throw failure("Btrfs top-level mount identity was not confirmed");
      const topShown = await command("btrfs", ["filesystem", "show", "--raw", top]); if (!topShown.toLowerCase().includes(`uuid: ${fsUuid}`)) throw failure("Btrfs filesystem identity changed");
      await protectedDirectory(top);
      resources.push({ label: device, async verify() { const now = await stat(device); if (!now.isBlockDevice() || now.rdev !== deviceInfo.rdev) throw failure("Btrfs device identity changed"); }, async release() {} });
      const subvolumes = [{ id: "5", uuid: "-", fsPath: "/" }, ...parseBtrfsSubvolumes(await command("btrfs", ["subvolume", "list", "-a", "-u", top]))];
      const userSubvolumeIdentity = (values: typeof subvolumes) => JSON.stringify(values.filter(value => !inside("/.delta-backupper-snapshots", value.fsPath)).map(value => [value.id, value.uuid, value.fsPath]).sort((a, b) => a[0].localeCompare(b[0])));
      const originalSubvolumes = userSubvolumeIdentity(subvolumes);
      resources.push({ label: `Btrfs topology ${fsUuid}`, async verify(cleanup) { const current = [{ id: "5", uuid: "-", fsPath: "/" }, ...parseBtrfsSubvolumes(await command("btrfs", ["subvolume", "list", "-a", "-u", top], cleanup))]; if (userSubvolumeIdentity(current) !== originalSubvolumes) throw failure("Btrfs subvolume topology changed during snapshot backup", "SNAPSHOT_TOPOLOGY_CHANGED"); }, async release() {} });
      const namespace = path.join(top, ".delta-backupper-snapshots"); const namespaceDirectory = await ownedDirectory(namespace, 0o700, true);
      if (!namespaceDirectory.created) await namespaceMarker(io, namespace, fsUuid);
      namespaceDirectory.action.namespaceUuid = fsUuid; namespaceDirectory.action.namespaceReady = !namespaceDirectory.created; await persist();
      if (namespaceDirectory.created) {
        const marker = await io.open(path.join(namespace, ".delta-namespace.json"), "wx", 0o600);
        try { await marker.writeFile(`${JSON.stringify({ schemaVersion: 1, kind: "delta-backupper-btrfs-snapshots", filesystemUuid: fsUuid })}\n`); await marker.sync(); } finally { await marker.close(); }
        const directory = await io.open(namespace, "r"); try { await directory.sync(); } finally { await directory.close(); }
      }
      await namespaceMarker(io, namespace, fsUuid);
      namespaceDirectory.action.namespaceReady = true; await persist();
      async function validateNamespaceContents(): Promise<void> {
        await namespaceMarker(io, namespace, fsUuid!);
        for (const entry of await io.readdir(namespace)) {
          if (entry === ".delta-namespace.json") continue;
          if (!uuidPattern.test(entry)) throw failure("Btrfs snapshot namespace contains foreign entries");
          const directory = path.join(namespace, entry); await protectedDirectory(directory); await sessionMarker(io, directory, fsUuid!, entry);
          for (const child of await io.readdir(directory)) if (child !== ".delta-session.json" && !/^snapshot-\d+$/.test(child)) throw failure("Btrfs session namespace contains foreign entries");
        }
      }
      await validateNamespaceContents();
      const sessionNamespace = path.join(namespace, context.sessionId); await ownedDirectory(sessionNamespace, 0o700);
      const sessionMarkerPath = path.join(sessionNamespace, ".delta-session.json"); const markerAction = await intent({ kind: "session-marker", path: sessionMarkerPath, filesystemUuid: fsUuid });
      let markerIdentity: BigIntStats | undefined;
      const verifyMarker = async () => { await sessionMarker(io, sessionNamespace, fsUuid, context.sessionId); const now = await stat(sessionMarkerPath); if (markerIdentity && (markerIdentity.dev !== now.dev || markerIdentity.ino !== now.ino)) throw failure("Btrfs session marker identity changed"); };
      resources.push({ label: sessionMarkerPath, verify: verifyMarker, async release() {
        try { await stat(sessionMarkerPath); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
        await verifyMarker(); await io.unlink(sessionMarkerPath); markerAction.done = true; await persist();
      } });
      const sessionFile = await io.open(sessionMarkerPath, "wx", 0o600);
      try { await sessionFile.writeFile(`${JSON.stringify({ schemaVersion: 1, kind: "delta-backupper-btrfs-session", filesystemUuid: fsUuid, sessionId: context.sessionId })}\n`); await sessionFile.sync(); } finally { await sessionFile.close(); }
      markerIdentity = await stat(sessionMarkerPath); markerAction.device = String(markerIdentity.dev); markerAction.inode = String(markerIdentity.ino); await persist();
      const sessionDirectoryHandle = await io.open(sessionNamespace, "r"); try { await sessionDirectoryHandle.sync(); } finally { await sessionDirectoryHandle.close(); }
      resources.push({ label: namespace, verify: validateNamespaceContents, async release() { await validateNamespaceContents(); } });
      const created = new Map<string, { point: string; uuid: string; id: string }>();
      for (const mounted of group) {
        const mountSubvolume = [...subvolumes].sort((a, b) => b.fsPath.length - a.fsPath.length).find(subvolume => inside(subvolume.fsPath, mounted.root));
        if (!mountSubvolume) throw failure("Cannot locate the subvolume behind a Btrfs mount");
        const observedRoot = (await command("btrfs", ["inspect-internal", "rootid", mounted.point])).trim(); if (observedRoot !== mountSubvolume.id) throw failure("Btrfs source subvolume identity changed");
        const candidates = subvolumes.filter(subvolume => subvolume.id === mountSubvolume.id || inside(mounted.root, subvolume.fsPath)).filter(subvolume => !inside("/.delta-backupper-snapshots", subvolume.fsPath)).map(subvolume => ({ ...subvolume, logical: subvolume.id === mountSubvolume.id ? mounted.point : path.join(mounted.point, path.relative(mounted.root, subvolume.fsPath)), offset: subvolume.id === mountSubvolume.id ? path.relative(subvolume.fsPath, mounted.root) : "" })).filter(subvolume => sourcePaths.some(source => inside(subvolume.logical, source) || inside(source, subvolume.logical)));
        for (const origin of candidates) {
          // A nested live mount hides this subvolume. Its own mapping or an
          // explicit exclusion below owns that path instead.
          const owner = findMount(origin.logical); if (owner?.id !== mounted.id) continue;
          let snapshot = created.get(origin.id);
          if (!snapshot) {
            const sourceRoot = path.join(top, origin.fsPath); const object = path.join(sessionNamespace, `snapshot-${created.size}`); let attested: ReturnType<typeof btrfsShow> | undefined; let attempted = false;
            const action = await intent({ kind: "btrfs", object, originUuid: origin.uuid, filesystemUuid: fsUuid, device, deviceRdev: String(deviceInfo.rdev), topPath: top });
            const attest = async (cleanup = false) => {
              const current = btrfsShow(await command("btrfs", ["subvolume", "show", object], cleanup));
              if (!current.readOnly || current.parentUuid !== origin.uuid || (attested && (current.uuid !== attested.uuid || current.id !== attested.id))) throw failure("Btrfs snapshot identity changed", "SNAPSHOT_IDENTITY_CHANGED");
              return current;
            };
            resources.push({ label: object, async verify(cleanup) { if (!attested) throw failure("Btrfs snapshot ownership was not attested"); await attest(cleanup); }, async release() {
              if (!attempted) return;
              try { await stat(object); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
              if (!attested) throw failure("Refusing to delete an unattested Btrfs snapshot");
              await attest(true); await command("btrfs", ["subvolume", "delete", "--commit-after", "--", object], true);
              try { await stat(object); throw failure("Btrfs snapshot deletion was not confirmed"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
              action.done = true; await persist();
            } });
            attempted = true;
            try { await command("btrfs", ["subvolume", "snapshot", "-r", "--", sourceRoot, object]); }
            finally { try { attested = await attest(true); action.snapshotUuid = attested.uuid; action.snapshotId = attested.id; await persist(); } catch { /* An unidentified object must remain untouched during cleanup. */ } }
            if (!attested) throw failure("Btrfs snapshot creation could not be attested");
            const point = path.join(workspace, `snapshot-${index++}`);
            const snapshotRoot = `/.delta-backupper-snapshots/${context.sessionId}/${path.basename(object)}`;
            await managedMount(point, ["-t", "btrfs", "-o", `ro,nosuid,nodev,noexec,subvolid=${attested.id}`, "--", device, point], value => value.type === "btrfs" && value.options.includes("ro") && value.root === snapshotRoot, snapshotRoot);
            snapshot = { point, uuid: attested.uuid, id: attested.id }; created.set(origin.id, snapshot); snapshotObjects.add(`btrfs:${fsUuid}:${attested.uuid}`);
          }
          const scopeRoot = path.join(origin.fsPath, origin.offset);
          const nestedSubvolumes = subvolumes.filter(other => other.id !== origin.id && inside(scopeRoot, other.fsPath)).map(other => path.join(origin.logical, path.relative(scopeRoot, other.fsPath)));
          const snapshotPath = path.join(snapshot.point, origin.offset); const info = await stat(snapshotPath);
          const ignoredRoots = origin.fsPath === "/" && !origin.offset ? [path.join(origin.logical, ".delta-backupper-snapshots")] : [];
          mappings.push({ root: origin.logical, snapshotPath, identity: `btrfs:${fsUuid}:${snapshot.uuid}`, device: String(info.dev), excludedRoots: [...new Set([...exclusions(mounted), ...nestedSubvolumes])].filter(value => inside(origin.logical, value)), ignoredRoots });
        }
      }
    }

    const zfsSelected = selected.filter(value => value.type === "zfs"); const zfsPools = new Set<string>();
    if (zfsSelected.length) {
      backends.add("zfs");
      const datasets = (await command("zfs", ["list", "-H", "-p", "-t", "filesystem", "-o", "name,guid,mountpoint,mounted"])).trim().split("\n").filter(Boolean).map(line => {
        const fields = line.split("\t"); if (fields.length !== 4 || !/^\d+$/.test(fields[1])) throw failure("Cannot parse ZFS dataset identity");
        return { name: datasetName(fields[0]), guid: fields[1], mountpoint: fields[2], mounted: fields[3] };
      });
      const unique = [...new Set(zfsSelected.map(mounted => datasetName(mounted.source)))];
      const names = new Map<string, string>(); const owned = new Map<string, { guid: string; held: boolean }>(); const actions = new Map<string, RecoveryAction>(); const attempted = new Set<string>();
      const snapshotName = `delta-backupper-${context.sessionId}`; const property = "org.delta-backupper:session"; const hold = `delta-backupper-${context.sessionId}`;
      for (const dataset of unique) {
        if (!datasets.some(value => value.name === dataset)) throw failure("ZFS mount dataset is absent from its authoritative inventory");
        const name = `${dataset}@${snapshotName}`; names.set(dataset, name); zfsPools.add(dataset.split("/")[0]);
        const before = await command("zfs", ["list", "-H", "-p", "-t", "snapshot", "-o", "name,guid", "-d", "1", dataset]);
        if (before.split("\n").some(line => line.split("\t")[0] === name)) throw failure("The session ZFS snapshot name is already in use");
      }
      const attest = async (name: string, cleanup = false) => {
        const rows = (await command("zfs", ["get", "-H", "-p", "-o", "property,value", `guid,${property}`, name], cleanup)).trim().split("\n").map(line => line.split("\t"));
        const values = new Map(rows.map(row => [row[0], row[1]])); const guid = values.get("guid");
        if (!guid || !/^\d+$/.test(guid) || values.get(property) !== context.sessionId || (owned.has(name) && owned.get(name)!.guid !== guid)) throw failure("ZFS snapshot GUID/session identity changed", "SNAPSHOT_IDENTITY_CHANGED");
        return guid;
      };
      for (const name of names.values()) resources.push({ label: name, async verify(cleanup) {
        if (!owned.has(name)) throw failure("ZFS snapshot ownership was not attested"); await attest(name, cleanup);
        const holds = await command("zfs", ["holds", "-H", name], cleanup); if (!holds.split("\n").some(line => { const fields = line.split("\t"); return fields[0] === name && fields[1] === hold; })) throw failure("ZFS snapshot hold is missing");
      }, async release() {
        if (!attempted.has(name)) return;
        const identity = owned.get(name);
        if (!identity) { const present = await command("zfs", ["list", "-H", "-p", "-t", "snapshot", "-o", "name,guid", "-d", "1", name.split("@")[0]], true); if (!present.split("\n").some(line => line.split("\t")[0] === name)) return; throw failure("Refusing to destroy an unattested ZFS snapshot"); }
        await attest(name, true);
        const holds = await command("zfs", ["holds", "-H", name], true);
        if (holds.split("\n").some(line => { const fields = line.split("\t"); return fields[0] === name && fields[1] === hold; })) { await command("zfs", ["release", hold, name], true); identity.held = false; }
        await attest(name, true); await command("zfs", ["destroy", name], true);
        const dataset = name.split("@")[0]; const after = await command("zfs", ["list", "-H", "-p", "-t", "snapshot", "-o", "name,guid", "-d", "1", dataset], true);
        if (after.split("\n").some(line => line.split("\t")[0] === name)) throw failure("ZFS snapshot deletion was not confirmed");
        actions.get(name)!.done = true; await persist();
      } });
      for (const pool of zfsPools) {
        const poolNames = [...names.values()].filter(name => name.split("/")[0].split("@")[0] === pool);
        for (const name of poolNames) { actions.set(name, await intent({ kind: "zfs", name, originGuid: datasets.find(value => value.name === name.split("@")[0])!.guid, hold })); attempted.add(name); }
        try { await command("zfs", ["snapshot", "-o", `${property}=${context.sessionId}`, ...poolNames]); }
        finally { for (const name of poolNames) try { const guid = await attest(name, true); owned.set(name, { guid, held: false }); actions.get(name)!.snapshotGuid = guid; await persist(); } catch { /* Ambiguous creation is never permission to destroy an unknown object. */ } }
        for (const name of poolNames) if (!owned.has(name)) throw failure("ZFS snapshot creation could not be attested");
        await command("zfs", ["hold", hold, ...poolNames]); for (const name of poolNames) { owned.get(name)!.held = true; actions.get(name)!.held = true; } await persist();
      }
      const mountedSnapshots = new Map<string, string>();
      for (const mounted of zfsSelected) {
        const dataset = datasetName(mounted.source); let point = mountedSnapshots.get(dataset); const name = names.get(dataset)!;
        const currentDataset = (await command("zfs", ["get", "-H", "-p", "-o", "value", "guid", dataset])).trim();
        if (currentDataset !== datasets.find(value => value.name === dataset)!.guid) throw failure("ZFS origin dataset identity changed");
        if (!point) { point = path.join(workspace, `snapshot-${index++}`); await managedMount(point, ["-t", "zfs", "-o", "ro,nosuid,nodev,noexec", "--", name, point], value => value.type === "zfs" && value.source === name && value.options.includes("ro")); mountedSnapshots.set(dataset, point); snapshotObjects.add(`zfs:${owned.get(name)!.guid}`); }
        const snapshotPath = path.join(point, mounted.root); const info = await stat(snapshotPath);
        mappings.push({ root: mounted.point, snapshotPath, identity: `zfs:${owned.get(name)!.guid}`, device: String(info.dev), excludedRoots: exclusions(mounted) });
      }
    }

    const lvmSelected = selected.filter(value => value.type === "ext4" || value.type === "xfs");
    if (lvmSelected.length) {
      backends.add("lvm");
      const inventory = async (cleanup = false) => lvmRows(await command("lvs", ["--reportformat", "json", "--units", "b", "--nosuffix", "-o", lvmFields], cleanup));
      const rows = await inventory(); const byOrigin = new Map<string, { point: string; uuid: string }>();
      for (const mounted of lvmSelected) {
        if (mounted.superOptions.some(option => option.startsWith("logdev=") || option.startsWith("rtdev="))) throw failure("XFS external log/realtime devices require coordinated snapshots and are unsupported");
        const [major, minor] = mounted.device.split(":"); const origin = rows.find(row => row.lv_kernel_major === major && row.lv_kernel_minor === minor);
        if (!origin || !lvmUuid(origin.lv_uuid) || !/^[A-Za-z0-9_+.-]+$/.test(origin.vg_name) || !/^[A-Za-z0-9_+.-]+$/.test(origin.lv_name) || !origin.lv_path.startsWith("/dev/")) throw failure("Source filesystem is not on an attested supported LVM logical volume");
        const originDevice = await stat(await io.realpath(origin.lv_path)); if (!originDevice.isBlockDevice() || originDevice.rdev !== linuxDeviceNumber(major, minor)) throw failure("LVM origin block device identity disagrees with its mounted filesystem");
        if (origin.pool_lv || origin.lv_attr[0] === "V" || origin.lv_attr[0] === "t") throw failure("LVM thin-pool snapshots are not enabled: pool exhaustion and activation require native qualification");
        if (!["-", "o"].includes(origin.lv_attr[0]) || origin.lv_attr[4] !== "a" || origin.lv_health_status) throw failure("LVM origin must be a healthy active linear/origin volume");
        let snapshot = byOrigin.get(origin.lv_uuid);
        if (!snapshot) {
          const cow = context.lvmCowSizeBytes ?? 8 * 1024 ** 3;
          if (!Number.isSafeInteger(cow) || cow < 256 * 1024 ** 2 || cow > 1024 ** 4) throw failure("LVM COW size must be between 256 MiB and 1 TiB");
          const name = `delta_${context.sessionId.replaceAll("-", "")}_${index++}`; const tag = `delta_backupper_${context.sessionId.replaceAll("-", "")}`; let identity: LvmRow | undefined; let attempted = false;
          const action = await intent({ kind: "lvm", vg: origin.vg_name, name, originUuid: origin.lv_uuid, tag });
          const attest = async (cleanup = false) => {
            const current = (await inventory(cleanup)).find(row => row.vg_name === origin.vg_name && row.lv_name === name);
            if (!current || !lvmUuid(current.lv_uuid) || current.origin_uuid !== origin.lv_uuid || !current.lv_tags.split(",").includes(tag) || (identity && current.lv_uuid !== identity.lv_uuid)) throw failure("LVM snapshot UUID/origin/session identity changed", "SNAPSHOT_IDENTITY_CHANGED");
            return current;
          };
          const healthy = (current: LvmRow) => {
            const percent = Number(current.snap_percent);
            if (current.lv_attr[0] !== "s" || current.lv_attr[1] !== "r" || current.lv_attr[4] !== "a" || current.lv_health_status || !current.snap_percent || !Number.isFinite(percent) || percent < 0 || percent >= 95) throw failure("LVM snapshot is invalid, unhealthy, or its COW area is nearly full", "SNAPSHOT_INVALIDATED");
          };
          resources.push({ label: `${origin.vg_name}/${name}`, async verify(cleanup) { healthy(await attest(cleanup)); }, async release() {
            if (!attempted) return;
            const current = (await inventory(true)).find(row => row.vg_name === origin.vg_name && row.lv_name === name);
            if (!current) return;
            if (!identity) throw failure("Refusing to remove an unattested LVM snapshot");
            await attest(true);
            await command("lvremove", ["--yes", "--select", `lv_uuid=${identity.lv_uuid}`, "--", `${origin.vg_name}/${name}`], true);
            if ((await inventory(true)).some(row => row.lv_uuid === identity!.lv_uuid || (row.vg_name === origin.vg_name && row.lv_name === name))) throw failure("LVM snapshot removal was not confirmed");
            action.done = true; await persist();
          } });
          if (rows.some(row => row.vg_name === origin.vg_name && row.lv_name === name)) throw failure("LVM snapshot session name is already in use");
          attempted = true;
          // Device-mapper/LVM freezes and thaws the origin itself. Explicit
          // fsfreeze here can deadlock a root-filesystem backup.
          try { await command("lvcreate", ["--snapshot", "--permission", "r", "--size", `${cow}B`, "--name", name, "--addtag", tag, "--", `${origin.vg_name}/${origin.lv_name}`]); }
          finally { try { identity = await attest(true); action.snapshotUuid = identity.lv_uuid; await persist(); } catch { /* Do not remove a volume without its UUID and session tag. */ } }
          if (!identity) throw failure("LVM snapshot creation could not be attested"); healthy(identity);
          if (identity.lv_path !== `/dev/${origin.vg_name}/${name}`) throw failure("Unexpected LVM snapshot device path");
          const devicePath = await io.realpath(identity.lv_path); const device = await stat(devicePath);
          if (!device.isBlockDevice() || device.rdev !== linuxDeviceNumber(identity.lv_kernel_major, identity.lv_kernel_minor)) throw failure("LVM snapshot device node does not identify the attested snapshot volume");
          action.snapshotDevice = devicePath; action.snapshotRdev = String(device.rdev); action.kernelDevice = `${identity.lv_kernel_major}:${identity.lv_kernel_minor}`; await persist();
          const point = path.join(workspace, `snapshot-${index++}`); const fsOptions = mounted.type === "ext4" ? "ro,noload,nosuid,nodev,noexec" : "ro,nouuid,norecovery,nosuid,nodev,noexec";
          await managedMount(point, ["-t", mounted.type, "-o", fsOptions, "--", devicePath, point], value => value.type === mounted.type && value.device === `${identity!.lv_kernel_major}:${identity!.lv_kernel_minor}` && value.root === "/" && value.options.includes("ro") && value.superOptions.some(option => mounted.type === "ext4" ? option === "noload" || option === "norecovery" : option === "norecovery"));
          snapshot = { point, uuid: identity.lv_uuid }; byOrigin.set(origin.lv_uuid, snapshot); snapshotObjects.add(`lvm:${identity.lv_uuid}`);
        }
        const snapshotPath = path.join(snapshot.point, mounted.root); const info = await stat(snapshotPath);
        mappings.push({ root: mounted.point, snapshotPath, identity: `lvm:${snapshot.uuid}`, device: String(info.dev), excludedRoots: exclusions(mounted) });
      }
    }
    if (!mappings.length) throw failure("No readable snapshots were created");
    for (const source of sourcePaths) if (!mappings.some(mapping => inside(mapping.root, source))) throw failure("A source is not represented by a snapshot mapping");
    const backend = backends.size === 1 ? [...backends][0] : "mixed";
    const verify = async () => { if (released) throw failure("Snapshot lease has been released"); context.signal?.throwIfAborted(); await topology(); for (const resource of resources) await resource.verify(); };
    await verify();
    return { backend, mappings, atomicSet: snapshotObjects.size === 1 || (backends.size === 1 && backends.has("zfs") && zfsPools.size === 1), verify, release };
  } catch (error) {
    try { await release(); } catch (cleanupError) { throw Object.assign(new AggregateError([error, cleanupError], "Snapshot setup failed and cleanup could not be verified"), { code: "SNAPSHOT_CLEANUP_UNVERIFIED", cleanupVerified: false }); }
    if (error && typeof error === "object") Object.assign(error, { cleanupVerified: true });
    throw error;
  }
}
