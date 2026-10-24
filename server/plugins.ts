import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import * as tar from "tar";
import { unzipSync } from "fflate";
import { botPluginsSchema, pluginIdSchema, pluginSourceSchema, PLUGIN_SOURCE_ERROR, type InstalledPlugin } from "../shared/plugins.ts";
import { DATA_DIR } from "./config.ts";

const MANIFESTS = ["plugin.json", ".cursor-plugin/plugin.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json"];
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 10_000;
type Manifest = Record<string, unknown>;
const fail = (message: string): never => { throw Object.assign(new Error(message), { status: 400 }); };
const record = (value: unknown): value is Manifest => Boolean(value && typeof value === "object" && !Array.isArray(value));

function inside(root: string, path: string): string {
  if (path.includes("\\") || isAbsolute(path) || path.split("/").includes("..")) fail(`Plugin path escapes its directory: ${path}`);
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail(`Plugin path escapes its directory: ${path}`);
  return target;
}

async function copyPackage(source: string, target: string): Promise<void> {
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

async function download(url: string): Promise<Buffer> {
  let current = new URL(url);
  const signal = AbortSignal.timeout(60_000);
  for (let redirects = 0; redirects < 6; redirects++) {
    if (!pluginSourceSchema.safeParse(current.href).success) fail(PLUGIN_SOURCE_ERROR);
    const response = await fetch(current, { redirect: "manual", signal });
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      await response.body?.cancel();
      const next = new URL(response.headers.get("location")!, current);
      if (current.protocol === "https:" && next.protocol === "http:") fail("HTTPS plugin downloads cannot redirect to HTTP");
      current = next;
      continue;
    }
    if (!response.ok) fail(`Plugin download failed (HTTP ${response.status})`);
    if (Number(response.headers.get("content-length") ?? 0) > MAX_BYTES) fail("Plugin download exceeds 64 MiB");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of response.body ?? []) {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) fail("Plugin download exceeds 64 MiB");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  return fail("Too many plugin download redirects");
}

async function extract(bytes: Buffer, target: string, archive: string) {
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
      inside(target, name);
      const mode = bytes.readUInt32LE(offset + 38) >>> 16;
      const type = mode & 0o170000;
      if (type && type !== 0o100000 && type !== 0o040000) fail("Plugin archives cannot contain links or special files");
      modes.set(name, mode);
      offset += 46 + nameLength + extraLength + commentLength;
    }
    const entries = unzipSync(bytes, { filter: entry => {
      inside(target, entry.name);
      if (++files > MAX_FILES || (total += entry.originalSize) > MAX_BYTES) fail("Plugin archive exceeds size or file-count limit");
      return true;
    } });
    for (const [name, data] of Object.entries(entries)) {
      const path = inside(target, name);
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
        inside(target, entry.path);
        if (!["File", "Directory", "ExtendedHeader", "GlobalExtendedHeader"].includes(entry.type)) fail("Plugin archives cannot contain links or special files");
        if (++files > MAX_FILES || (total += entry.size) > MAX_BYTES) fail("Plugin archive exceeds size or file-count limit");
      } catch (error) { invalid ??= error as Error; }
    } });
    if (invalid) throw invalid;
    await tar.x({ file: archive, cwd: target, strict: true });
  }
}

function packageRoot(root: string): string {
  if (MANIFESTS.some(file => existsSync(join(root, file)))) return root;
  const children = readdirSync(root).filter(name => name !== "__MACOSX");
  if (children.length === 1 && lstatSync(join(root, children[0]!)).isDirectory()) return packageRoot(join(root, children[0]!));
  return fail("No plugin manifest found at the source root");
}

function validatePaths(root: string, value: unknown) {
  if (typeof value === "string") {
    const path = inside(root, value);
    if (!existsSync(path)) fail(`Plugin manifest references a missing path: ${value}`);
  } else if (Array.isArray(value)) value.forEach(item => validatePaths(root, item));
}

// Claude Code's explicit agents field accepts files; its default agents/ scan accepts a directory.
function claudeManifest(root: string, host: Manifest, agents: unknown): Manifest {
  const claude = { ...host };
  if (agents !== undefined && agents !== "./agents/" && agents !== "./agents") {
    const paths = Array.isArray(agents) ? agents : [agents];
    const expand = (path: unknown): string[] => {
      if (typeof path !== "string") return [];
      if (lstatSync(inside(root, path)).isDirectory()) return readdirSync(inside(root, path)).flatMap(name => expand(`${path.replace(/\/$/, "")}/${name}`));
      return path.endsWith(".md") ? [path] : [];
    };
    claude.agents = paths.flatMap(expand);
  }
  return claude;
}

function prepareManifests(root: string): { id: string; version: string; description?: string } {
  const manifests = new Map<string, Manifest>();
  for (const file of MANIFESTS) if (existsSync(join(root, file))) {
    let value: unknown;
    try { value = JSON.parse(readFileSync(join(root, file), "utf8")); } catch { return fail(`Invalid JSON in ${file}`); }
    if (!record(value)) fail(`${file} must be a JSON object`);
    manifests.set(file, value as Manifest);
  }
  const original = [...manifests.values()][0]!;
  const parsedId = pluginIdSchema.safeParse(original.name);
  if (!parsedId.success) fail("Plugin name must be a lowercase kebab-case ID");
  const id = parsedId.data!;
  const version = original.version ?? "0.0.0";
  if (typeof version !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,99}$/.test(version)) fail("Invalid plugin version");
  for (const manifest of manifests.values()) {
    if (manifest.name !== id || (manifest.version !== undefined && manifest.version !== version)) fail("Plugin manifests disagree on name or version");
    for (const key of ["skills", "agents", "commands", "hooks", "mcpServers", "apps", "rules", "lspServers", "outputStyles"]) validatePaths(root, manifest[key]);
    const openai = record(manifest.extensions) ? manifest.extensions["com.openai"] : null;
    if (record(openai)) for (const key of ["hooks", "apps", "onboardingSkill"]) validatePaths(root, openai[key]);
  }
  const identity: Manifest = Object.fromEntries(["name", "version", "description", "author", "homepage", "repository", "license", "keywords"].filter(key => original[key] !== undefined).map(key => [key, original[key]]));
  identity.version = version;
  const write = (file: string, data: Manifest) => {
    if (manifests.has(file)) return;
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), JSON.stringify(data, null, 2) + "\n");
  };
  if ([".cursor-plugin/plugin.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json"].some(file => !manifests.has(file))) {
    const component = (key: string): unknown => {
      const values = [...manifests.values()].map(manifest => manifest[key]).filter(value => value !== undefined);
      if (values.some(value => JSON.stringify(value) !== JSON.stringify(values[0]))) {
        fail(`Plugin manifests disagree on ${key}; provide an explicit manifest for the target CLI`);
      }
      return values[0];
    };
    const host: Manifest = { ...identity };
    for (const key of ["skills", "commands", "hooks", "mcpServers"]) {
      const value = component(key);
      if (value !== undefined) host[key] = value;
    }
    if (host.mcpServers === undefined && existsSync(join(root, "mcp.json"))) host.mcpServers = "./mcp.json";
    const agents = !manifests.has(".cursor-plugin/plugin.json") || !manifests.has(".claude-plugin/plugin.json") ? component("agents") : undefined;
    const cursor = { ...host };
    if (agents !== undefined) cursor.agents = agents;
    write(".cursor-plugin/plugin.json", cursor);
    const claude = claudeManifest(root, host, agents);
    write(".claude-plugin/plugin.json", claude);
    write(".codex-plugin/plugin.json", host);
  }
  write("plugin.json", { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", ...identity });
  return { id, version: version as string, ...(typeof original.description === "string" ? { description: original.description } : {}) };
}

export class PluginLibrary {
  private pending: Promise<unknown> = Promise.resolve();
  readonly root: string;
  constructor(root = join(DATA_DIR, "plugins")) { this.root = root; }
  list(): InstalledPlugin[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root).filter(name => pluginIdSchema.safeParse(name).success).flatMap(name => {
      const file = join(this.root, name, "installation.json");
      if (!existsSync(file)) return [];
      const plugin = JSON.parse(readFileSync(file, "utf8")) as InstalledPlugin;
      return [{ ...plugin, path: join(this.root, name, "package") }];
    });
  }
  selection(raw: unknown, snapshot = this.list()): string[] {
    const parsed = botPluginsSchema.safeParse(raw);
    if (!parsed.success) return fail("plugins must be an array of plugin IDs (at most 100)");
    const installed = new Set(snapshot.map(plugin => plugin.id));
    for (const id of parsed.data) if (!installed.has(id)) fail(`Plugin is not installed: ${id}`);
    return parsed.data;
  }
  resolve(ids: string[] = [], driverKind?: string, snapshot = this.list()): InstalledPlugin[] {
    if (ids.length && driverKind && !["claudeAgent", "cursorAgent", "codex"].includes(driverKind)) {
      fail("Native plugins require a Claude Code, Cursor Agent or Codex engine");
    }
    const plugins = new Map(snapshot.map(plugin => [plugin.id, plugin]));
    return this.selection(ids, snapshot).map(id => plugins.get(id)!);
  }
  install(source: string, beforeCommit?: (plugin: InstalledPlugin, replacing: boolean) => void): Promise<InstalledPlugin & { status: "installed" }> {
    const result = this.pending.then(() => this.installOne(source, beforeCommit));
    this.pending = result.catch(() => {});
    return result;
  }
  uninstall(id: string, beforeCommit?: () => void): Promise<{ id: string; status: "uninstalled"; removed: boolean }> {
    const result = this.pending.then(() => {
      if (!pluginIdSchema.safeParse(id).success) return fail("plugin_id must be a lowercase kebab-case plugin ID");
      const destination = join(this.root, id);
      const removed = existsSync(destination);
      const retired = join(this.root, `.uninstall-${randomUUID()}`);
      if (removed) renameSync(destination, retired);
      try { beforeCommit?.(); }
      catch (error) { if (removed) renameSync(retired, destination); throw error; }
      if (removed) rmSync(retired, { recursive: true, force: true });
      return { id, status: "uninstalled" as const, removed };
    });
    this.pending = result.catch(() => {});
    return result;
  }
  private async installOne(source: string, beforeCommit?: (plugin: InstalledPlugin, replacing: boolean) => void): Promise<InstalledPlugin & { status: "installed" }> {
    const parsed = pluginSourceSchema.safeParse(source);
    if (!parsed.success) return fail(PLUGIN_SOURCE_ERROR);
    source = parsed.data;
    mkdirSync(this.root, { recursive: true });
    const stage = join(this.root, `.stage-${randomUUID()}`);
    const content = join(stage, "content");
    mkdirSync(stage);
    let previous: string | undefined;
    try {
      const url = new URL(source);
      if (url.username || url.password) fail("Plugin URLs cannot contain embedded credentials");
      let archiveUrl = source;
      let subdir = "";
      if (url.hostname === "github.com") {
        const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
        const [owner, repo, kind, ref, ...path] = parts;
        if (!owner || !repo || (kind && kind !== "tree")) fail("Use a GitHub repository or /tree/REF/directory URL");
        const repository = repo!.replace(/\.git$/, "");
        archiveUrl = kind ? `https://codeload.github.com/${owner}/${repository}/tar.gz/${encodeURIComponent(ref!)}` : `https://api.github.com/repos/${owner}/${repository}/tarball`;
        subdir = path.join("/");
      }
      await extract(await download(archiveUrl), content, join(stage, "download.tar"));
      const roots = readdirSync(content);
      const from = subdir ? inside(join(content, roots[0]!), subdir) : packageRoot(content);
      const prepared = join(stage, "package");
      await copyPackage(from, prepared);
      const metadata = prepareManifests(prepared);
      const installed: InstalledPlugin = { ...metadata, source, installedAt: Date.now(), path: join(this.root, metadata.id, "package") };
      writeFileSync(join(stage, "installation.json"), JSON.stringify(installed, null, 2) + "\n");
      rmSync(content, { recursive: true, force: true });
      rmSync(join(stage, "download.tar"), { force: true });
      const destination = join(this.root, metadata.id);
      beforeCommit?.(installed, existsSync(destination));
      if (existsSync(destination)) { previous = join(this.root, `.previous-${randomUUID()}`); renameSync(destination, previous); }
      try { renameSync(stage, destination); }
      catch (error) { if (previous) renameSync(previous, destination); throw error; }
      if (previous) rmSync(previous, { recursive: true, force: true });
      return { ...installed, status: "installed" };
    } finally { rmSync(stage, { recursive: true, force: true }); }
  }
}

export const pluginLibrary = new PluginLibrary();
