import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { botPluginsSchema, pluginIdSchema, pluginSourceSchema, PLUGIN_SOURCE_ERROR, type InstalledPlugin } from "../shared/plugins.ts";
import { DATA_DIR } from "./config.ts";
import { resourcePath as inside, copyResourceDirectory as copyPackage } from "./resource-directory.ts";
import { fetchExtensionSource, resourceDigest } from "./extension-source.ts";

const MANIFESTS = ["plugin.json", ".cursor-plugin/plugin.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json"];
type Manifest = Record<string, unknown>;
const fail = (message: string): never => { throw Object.assign(new Error(message), { status: 400 }); };
const record = (value: unknown): value is Manifest => Boolean(value && typeof value === "object" && !Array.isArray(value));

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

export interface PreparedPlugin {
  id: string; version: string; description?: string; source: string; path: string; token: string; digest: string;
}

export class PluginLibrary {
  private prepared = new Map<string, PreparedPlugin>();
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
    const result = this.pending.then(async () => {
      const prepared = await this.prepare(source);
      try { return await this.commitOne(prepared, beforeCommit); }
      catch (error) { this.discard(prepared); throw error; }
    });
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
  async prepare(source: string, directory?: string): Promise<PreparedPlugin> {
    const parsed = pluginSourceSchema.safeParse(source);
    if (!parsed.success) return fail(PLUGIN_SOURCE_ERROR);
    source = parsed.data;
    mkdirSync(this.root, { recursive: true });
    const token = randomUUID();
    const stage = join(this.root, `.stage-${token}`);
    const prepared = join(stage, "package");
    mkdirSync(stage);
    try {
      if (directory) await copyPackage(directory, prepared);
      else {
        const content = join(stage, "content");
        const from = await fetchExtensionSource(source, content);
        await copyPackage(from, prepared);
        rmSync(content, { recursive: true, force: true });
        rmSync(`${content}.tar`, { force: true });
      }
      const metadata = prepareManifests(packageRoot(prepared));
      const result: PreparedPlugin = { ...metadata, source, path: prepared, token, digest: resourceDigest(prepared) };
      this.prepared.set(token, result);
      return result;
    } catch (error) { rmSync(stage, { recursive: true, force: true }); throw error; }
  }
  discard(prepared: PreparedPlugin): void {
    if (this.prepared.get(prepared.token) !== prepared) return;
    this.prepared.delete(prepared.token);
    rmSync(dirname(prepared.path), { recursive: true, force: true });
  }
  commit(prepared: PreparedPlugin, beforeCommit?: (plugin: InstalledPlugin, replacing: boolean) => void): Promise<InstalledPlugin & { status: "installed" }> {
    const result = this.pending.then(() => this.commitOne(prepared, beforeCommit));
    this.pending = result.catch(() => {});
    return result;
  }
  private async commitOne(prepared: PreparedPlugin, beforeCommit?: (plugin: InstalledPlugin, replacing: boolean) => void): Promise<InstalledPlugin & { status: "installed" }> {
    if (this.prepared.get(prepared.token) !== prepared) return fail("The prepared plugin expired. Prepare it again.");
    if (resourceDigest(prepared.path) !== prepared.digest) return fail("The prepared plugin changed. Prepare it again.");
    const installed: InstalledPlugin = { id: prepared.id, version: prepared.version, ...(prepared.description ? { description: prepared.description } : {}), source: prepared.source, installedAt: Date.now(), path: join(this.root, prepared.id, "package") };
    const stage = dirname(prepared.path), destination = join(this.root, prepared.id);
    writeFileSync(join(stage, "installation.json"), JSON.stringify(installed, null, 2) + "\n");
    beforeCommit?.(installed, existsSync(destination));
    let previous: string | undefined;
    try {
      if (existsSync(destination)) { previous = join(this.root, `.previous-${randomUUID()}`); renameSync(destination, previous); }
      try { renameSync(stage, destination); }
      catch (error) { if (previous) renameSync(previous, destination); throw error; }
      if (previous) rmSync(previous, { recursive: true, force: true });
      this.prepared.delete(prepared.token);
      return { ...installed, status: "installed" };
    } finally { if (!this.prepared.has(prepared.token)) rmSync(stage, { recursive: true, force: true }); }
  }

}

export const pluginLibrary = new PluginLibrary();

export { resourcePath, extractResourceArchive, copyResourceDirectory } from "./resource-directory.ts";
