import { chmodSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
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

export async function extractResourceArchive(bytes: Buffer, target: string, archive: string, subdirectory?: string) {
  mkdirSync(target, { recursive: true });
  if (subdirectory !== undefined) resourcePath(target, subdirectory);
  const selected = (subdirectory ?? "").replace(/^\.\//, "").replace(/\/$/, "");
  const selectedPath = (name: string): string | null => {
    resourcePath(target, name);
    if (subdirectory === undefined) return name;
    const slash = name.indexOf("/");
    if (slash < 0) return null;
    const path = name.slice(slash + 1);
    if (!selected) return path;
    return path === selected || path === `${selected}/` ? "" : path.startsWith(`${selected}/`) ? path.slice(selected.length + 1) : null;
  };
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
      const path = selectedPath(name);
      const mode = bytes.readUInt32LE(offset + 38) >>> 16;
      const type = mode & 0o170000;
      if (path !== null && type && type !== 0o100000 && type !== 0o040000) fail("Plugin archives cannot contain links or special files");
      modes.set(name, mode);
      offset += 46 + nameLength + extraLength + commentLength;
    }
    const entries = unzipSync(bytes, { filter: entry => {
      if (selectedPath(entry.name) === null) return false;
      if (++files > MAX_FILES || (total += entry.originalSize) > MAX_BYTES) fail("Plugin archive exceeds size or file-count limit");
      return true;
    } });
    for (const [name, data] of Object.entries(entries)) {
      const path = resourcePath(target, selectedPath(name)!);
      if (name.endsWith("/")) mkdirSync(path, { recursive: true });
      else { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data); chmodSync(path, 0o644 | ((modes.get(name) ?? 0) & 0o111)); }
    }
  } else {
    const tar = await import("tar");
    const expanded = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes, { maxOutputLength: subdirectory === undefined ? MAX_BYTES : 4 * MAX_BYTES }) : bytes;
    writeFileSync(archive, expanded);
    // Inspect the complete archive before extraction; neither links nor device entries are installed.
    let invalid: Error | undefined;
    const included = new Set<string>();
    await tar.t({ file: archive, onReadEntry: entry => {
      try {
        const path = selectedPath(entry.path);
        if (path === null || !path) return;
        if (!["File", "Directory", "ExtendedHeader", "GlobalExtendedHeader"].includes(entry.type)) fail("Plugin archives cannot contain links or special files");
        if (++files > MAX_FILES || (total += entry.size) > MAX_BYTES) fail("Plugin archive exceeds size or file-count limit");
        included.add(entry.path);
      } catch (error) { invalid ??= error as Error; }
    } });
    if (invalid) throw invalid;
    await tar.x({ file: archive, cwd: target, strict: true, strip: subdirectory === undefined ? 0 : 1 + (selected ? selected.split("/").length : 0), filter: path => included.has(path) });
  }
  if (subdirectory !== undefined && !files) throw Object.assign(new Error(`GitHub resource directory was not found: ${subdirectory}`), { status: 404 });
}
