import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { TextDecoder } from "node:util";
import { parseSkillMd, scanSkillText, SKILL_FILE_MAX_BYTES, type ParsedSkill } from "../shared/skill-md.ts";

export interface SkillFile {
  path: string;
  content: string;
  encoding?: "base64";
  executable?: boolean;
}

export interface SkillFileDescriptor {
  path: string;
  size: number;
  sha256: string;
  executable: boolean;
  binary: boolean;
}

export interface PreparedSkillFiles {
  files: SkillFile[];
  parsed: ParsedSkill;
  warnings: string[];
  skippedFiles: string[];
}

export const MAX_SKILL_DIRECTORY_BYTES = 32 * 1024 * 1024;
export const MAX_SKILL_DIRECTORY_FILES = 1000;

export function validSkillFilePath(path: string): boolean {
  return Boolean(path) && path.length <= 2048 && !path.includes("\\") && !path.includes("\0") &&
    !path.startsWith("/") && !/^[a-zA-Z]:/.test(path) &&
    path.split("/").every(part => part !== "." && part !== ".." && Boolean(part));
}

export function skillFileBytes(file: SkillFile): Buffer {
  if (file.encoding === "base64") {
    const bytes = Buffer.from(file.content, "base64");
    if (bytes.toString("base64") !== file.content) throw new Error(`Invalid binary encoding: ${file.path}`);
    return bytes;
  }
  return Buffer.from(file.content, "utf8");
}

export function skillFileFromBytes(path: string, bytes: Uint8Array, executable = false): SkillFile {
  const content = Buffer.from(bytes);
  let text: string | null;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content); if (text.includes("\0")) text = null; }
  catch { text = null; }
  return { path, content: text ?? content.toString("base64"), ...(text === null ? { encoding: "base64" as const } : {}), ...(executable ? { executable: true } : {}) };
}

export function skillFileDescriptor(file: SkillFile): SkillFileDescriptor {
  const bytes = skillFileBytes(file);
  return { path: file.path, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
    executable: Boolean(file.executable), binary: file.encoding === "base64" };
}

export function skillDirectorySha256(files: readonly SkillFile[]): string {
  const records = files.map(skillFileDescriptor).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    .map(file => [file.path, file.size, file.sha256, file.executable]);
  return createHash("sha256").update(JSON.stringify(records)).digest("hex");
}

export function validateSkillFiles(files: readonly SkillFile[]): void {
  if (!files.length || files.length > MAX_SKILL_DIRECTORY_FILES) throw new Error(`A Skill may contain at most ${MAX_SKILL_DIRECTORY_FILES} files`);
  const paths = new Set<string>();
  let bytes = 0;
  for (const file of files) {
    if (!validSkillFilePath(file.path)) throw new Error(`Invalid Skill file path: ${file.path}`);
    if (paths.has(file.path)) throw new Error(`Duplicate Skill file: ${file.path}`);
    paths.add(file.path);
    bytes += skillFileBytes(file).length;
    if (bytes > MAX_SKILL_DIRECTORY_BYTES) throw new Error("Skill directory exceeds 32 MiB");
  }
  for (const path of paths) {
    let parent = posix.dirname(path);
    while (parent !== ".") {
      if (paths.has(parent)) throw new Error(`Skill path is both a file and directory: ${parent}`);
      parent = posix.dirname(parent);
    }
  }
}

export function readSkillDirectoryFiles(directory: string): SkillFile[] {
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error("Skill root must be a real directory");
  const files: SkillFile[] = [];
  let bytes = 0;
  const walk = (folder: string, prefix: string, depth: number) => {
    if (depth > 20) throw new Error("Skill directory exceeds 20 levels");
    for (const name of readdirSync(folder).sort()) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (!validSkillFilePath(path)) throw new Error(`Invalid Skill file path: ${path}`);
      const full = join(folder, name), stat = lstatSync(full);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error(`Skill contains a link or special file: ${path}`);
      if (stat.isDirectory()) { walk(full, path, depth + 1); continue; }
      if (files.length >= MAX_SKILL_DIRECTORY_FILES || (bytes += stat.size) > MAX_SKILL_DIRECTORY_BYTES) throw new Error("Skill directory exceeds file-count or size limit");
      files.push(skillFileFromBytes(path, readFileSync(full), Boolean(stat.mode & 0o111)));
    }
  };
  walk(directory, "", 0);
  validateSkillFiles(files);
  return files.sort((a, b) => a.path === "SKILL.md" ? -1 : b.path === "SKILL.md" ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export function writeSkillDirectoryFiles(directory: string, files: readonly SkillFile[]): void {
  validateSkillFiles(files);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const file of files) {
    const path = join(directory, file.path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, skillFileBytes(file), { mode: file.executable ? 0o700 : 0o600 });
    if (process.platform !== "win32") chmodSync(path, file.executable ? 0o700 : 0o600);
  }
}

export function prepareSkillFiles(input: SkillFile[]): PreparedSkillFiles | { error: string } {
  try {
    const rootMd = input.filter(file => file.path === "SKILL.md");
    const nestedMds = input.filter(file => file.path.endsWith("/SKILL.md"));
    const skillMds = rootMd.length ? rootMd : nestedMds.filter(file => !nestedMds.some(parent => parent !== file && file.path.startsWith(parent.path.slice(0, -"SKILL.md".length))));
    if (skillMds.length !== 1) return { error: skillMds.length ? "A Skill must contain exactly one SKILL.md" : "no SKILL.md found at that location" };
    const md = skillMds[0]!;
    if (md.encoding) return { error: "SKILL.md must be UTF-8 text" };
    if (Buffer.byteLength(md.content) > SKILL_FILE_MAX_BYTES) return { error: `SKILL.md is larger than ${SKILL_FILE_MAX_BYTES / 1024}KB` };
    const parsed = parseSkillMd(md.content);
    if ("error" in parsed) return parsed;
    const prefix = md.path.slice(0, -"SKILL.md".length);
    const files = input.map(file => {
      if (!file.path.startsWith(prefix)) throw new Error(`File is outside the Skill root: ${file.path}`);
      const { executable, ...content } = file;
      return { ...content, path: file.path.slice(prefix.length), ...(executable && process.platform !== "win32" ? { executable: true } : {}) };
    }).sort((a, b) => a.path === "SKILL.md" ? -1 : b.path === "SKILL.md" ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    validateSkillFiles(files);
    const warnings = files.flatMap(file => file.encoding ? [] : scanSkillText(file.content).map(warning => file.path === "SKILL.md" ? warning : `${file.path}: ${warning}`));
    return { files, parsed, warnings, skippedFiles: [] };
  } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}

export function prepareLearnedSkillFiles(files: SkillFile[]): PreparedSkillFiles | { error: string } {
  if (files.filter(file => file.path === "SKILL.md").length !== 1) {
    return { error: "learned skills must contain exactly one SKILL.md" };
  }
  return prepareSkillFiles(files);
}

export function mergeSkillFilePatch(base: readonly SkillFile[], writes: readonly SkillFile[], removals: readonly string[] = []): SkillFile[] {
  const merged = new Map(base.map(file => [file.path, file]));
  for (const path of removals) {
    if (!validSkillFilePath(path) || path === "SKILL.md") throw new Error(`Invalid Skill removal path: ${path}`);
    if (!merged.delete(path)) throw new Error(`Cannot remove missing Skill file: ${path}`);
  }
  for (const file of writes) merged.set(file.path, file);
  const result = [...merged.values()];
  validateSkillFiles(result);
  return result;
}
