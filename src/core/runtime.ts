import { isSea } from "node:sea";

export const VERSION = "0.0.0-stage0";

export function runtimeInfo() {
  return {
    product: "Delta Backupper",
    version: VERSION,
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    electron: process.versions.electron ?? null,
    standalone: isSea(),
  };
}
