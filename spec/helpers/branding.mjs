import { createHash } from "node:crypto";
import { NtExecutable, NtExecutableResource, Resource } from "resedit";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const sortIcons = icons => icons.sort((first, second) => first.width - second.width || first.height - second.height || first.sha256.localeCompare(second.sha256));

/** Compare actual icon payloads, independently of resource IDs and languages. */
export function iconFilePayloads(bytes) {
  if (bytes.length < 6 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) throw new Error("Invalid ICO file.");
  const count = bytes.readUInt16LE(4);
  if (!count || bytes.length < 6 + count * 16) throw new Error("Invalid ICO directory.");
  const icons = [];
  for (let index = 0; index < count; index++) {
    const offset = 6 + index * 16, size = bytes.readUInt32LE(offset + 8), start = bytes.readUInt32LE(offset + 12);
    if (!size || start < 6 + count * 16 || start + size > bytes.length) throw new Error("Invalid ICO image bounds.");
    icons.push({ width: bytes[offset] || 256, height: bytes[offset + 1] || 256, sha256: sha256(bytes.subarray(start, start + size)) });
  }
  return sortIcons(icons);
}

export function inspectWindowsBranding(bytes) {
  const executable = NtExecutable.from(bytes, { ignoreCert: true });
  const resources = NtExecutableResource.from(executable);
  const metadata = Resource.VersionInfo.fromEntries(resources.entries).flatMap(info => info.getAllLanguagesForStringValues().map(language => ({ ...language, ...info.getStringValues(language) })));
  const executionLevels = resources.entries.filter(entry => entry.type === 24).map(entry => Buffer.from(entry.bin).toString("utf8").match(/requestedExecutionLevel[^>]*\blevel=["']([^"']+)["']/i)?.[1] ?? null);
  const icons = Resource.IconGroupEntry.fromEntries(resources.entries).map(group => ({ id: group.id, lang: group.lang, images: sortIcons(group.icons.map(icon => {
    const entry = resources.entries.find(item => item.type === 3 && item.id === icon.iconID && item.lang === group.lang);
    if (!entry) throw new Error("PE icon group references a missing image.");
    return { width: icon.width || 256, height: icon.height || 256, sha256: sha256(Buffer.from(entry.bin)) };
  })) }));
  return { metadata, icons, executionLevels, certificateTable: executable.newHeader.optionalHeaderDataDirectory.get(4) };
}

export function inspectIcns(bytes) {
  if (bytes.length < 8 || bytes.toString("ascii", 0, 4) !== "icns" || bytes.readUInt32BE(4) !== bytes.length) throw new Error("Invalid ICNS container.");
  const chunks = [];
  let offset = 8;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new Error("Truncated ICNS chunk.");
    const type = bytes.toString("ascii", offset, offset + 4), length = bytes.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > bytes.length) throw new Error("Invalid ICNS chunk bounds.");
    chunks.push({ type, bytes: length - 8, sha256: sha256(bytes.subarray(offset + 8, offset + length)) });
    offset += length;
  }
  return chunks;
}
