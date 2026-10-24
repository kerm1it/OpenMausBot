import { chmodSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import * as tar from "tar";
import { unzipSync } from "fflate";

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 10_000;
const fail = (message: string): never => { throw Object.assign(new Error(message), { status: 400 }); };

export function resourcePath(root: string, path: string): string {
  if (path.includes("\\") || isAbsolute(path) || path.split("/").includes("..")) fail(`Plugin path escapes its directory: ${path}`);
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail(`Plugin path escapes its directory: ${path}`);
  return target;
}

export async function copyResourceDirectory(source: string, target: string): Promise<void> {
  let count = 0;
  let bytes = 0;
  async function walk(from: string, to: string) {
    const stat = lstatSync(from);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) fail("Plugin packages cannot contain links or special files");
    if (++count > MAX_FILES || (bytes += stat.isFile() ? stat.size : 0) > MAX_BYTES) fail("Plugin package exceeds size or file-count limit");
    if (stat.isDirectory()) {
      await mkdir(to, { recursive: true });
      for (const name of readdirSync(from)) {
        if (name === ".git") continue;
        await walk(join(from, name), join(to, name));
      }
    } else await copyFile(from, to);
  }
  await walk(source, target);
}

export async function extractResourceArchive(bytes: Buffer, target: string, archive: string) {
  mkdirSync(target, { recursive: true });
  let total = 0;
  let files = 0;
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    // Keep executable script bits, and reject Unix links, from the ZIP central directory.
    const modes = new Map<string, number>();
    let end = bytes.length - 22;
    while (end >= Math.max(0, bytes.length - 65_557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
    if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50) fail("Invalid ZIP directory");
    let offset = bytes.readUInt32LE(end + 16);
    const count = bytes.readUInt16LE(end + 10);
    for (let index = 0; index < count; index++) {
      if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) fail("Invalid ZIP entry");
      const nameLength = bytes.readUInt16LE(offset + 28);
      const extraLength = bytes.readUInt16LE(offset + 30);
      const commentLength = bytes.readUInt16LE(offset + 32);
      const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
      resourcePath(target, name);
      const mode = bytes.readUInt32LE(offset + 38) >>> 16;
      const type = mode & 0o170000;
      if (type && type !== 0o100000 && type !== 0o040000) fail("Plugin archives cannot contain links or special files");
      modes.set(name, mode);
      offset += 46 + nameLength + extraLength + commentLength;
    }
    const entries = unzipSync(bytes, { filter: entry => {
      resourcePath(target, entry.name);
      if (++files > MAX_FILES || (total += entry.originalSize) > MAX_BYTES) fail("Plugin archive exceeds size or file-count limit");
      return true;
    } });
    for (const [name, data] of Object.entries(entries)) {
      const path = resourcePath(target, name);
      if (name.endsWith("/")) mkdirSync(path, { recursive: true });
      else { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data); chmodSync(path, 0o644 | ((modes.get(name) ?? 0) & 0o111)); }
    }
  } else {
    const expanded = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes, { maxOutputLength: MAX_BYTES }) : bytes;
    writeFileSync(archive, expanded);
    // Inspect the complete archive before extraction; neither links nor device entries are installed.
    let invalid: Error | undefined;
    await tar.t({ file: archive, onReadEntry: entry => {
      try {
        resourcePath(target, entry.path);
        if (!["File", "Directory", "ExtendedHeader", "GlobalExtendedHeader"].includes(entry.type)) fail("Plugin archives cannot contain links or special files");
        if (++files > MAX_FILES || (total += entry.size) > MAX_BYTES) fail("Plugin archive exceeds size or file-count limit");
      } catch (error) { invalid ??= error as Error; }
    } });
    if (invalid) throw invalid;
    await tar.x({ file: archive, cwd: target, strict: true });
  }
}
