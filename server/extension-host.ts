import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ExtensionImportOptions, ExtensionImportPreview, ExtensionImportResult } from "../shared/extension-import.ts";
import type { PreparedBotTemplate } from "./extension-model.ts";
import { botPreview, checkPluginExtension, filePreviews } from "./extension-prepare.ts";
import { commitDependencies, prepareDependencies, installedPluginIdentity, type ExtensionPlugins, type PreparedDependency } from "./extension-dependencies.ts";
import { resolveExtension, resolveExtensionDirectory, type ResolveExtensionDeps } from "./extension-resolve.ts";
import { extensionError, extensionRoot, resourceDigest, resourcePath } from "./extension-source.ts";
import { extractResourceArchive } from "./plugins.ts";
import type { RequestAuth } from "./request-auth.ts";

interface Snapshot { stage: string; root: string; digest: string; expires: number; preview: ExtensionImportPreview; draft?: PreparedBotTemplate; dependencies: PreparedDependency[]; result?: ExtensionImportResult; pending?: Promise<ExtensionImportResult> }
interface ExtensionHostDeps extends ResolveExtensionDeps {
  dataDir: string;
  plugins: ExtensionPlugins;
  createBot: (draft: PreparedBotTemplate, options: ExtensionImportOptions, plugins: string[], auth: RequestAuth) => Promise<Omit<ExtensionImportResult, "warnings">>;
}
const optionsSchema = z.object({ name: z.string().max(80).optional(), section: z.string().max(60).optional(), modelSelection: z.unknown().optional(), includeMemory: z.boolean().optional(), includeRoutines: z.boolean().optional(), omitPlugins: z.array(z.string()).max(100).optional(), reusePlugins: z.array(z.string()).max(100).optional(), omitSkills: z.array(z.string()).max(100).optional() }).strict();

export function createExtensionHost(deps: ExtensionHostDeps) {
  const snapshots = new Map<string, Snapshot>();
  const discard = (id: string) => {
    const snapshot = snapshots.get(id);
    if (!snapshot || snapshot.pending) return;
    snapshots.delete(id);
    for (const dependency of snapshot.dependencies) if (dependency.prepared) deps.plugins.discard(dependency.prepared);
    rmSync(snapshot.stage, { recursive: true, force: true });
    rmSync(`${snapshot.stage}.tar`, { force: true });
  };
  const prune = () => { for (const [id, snapshot] of snapshots) if (snapshot.expires < Date.now()) discard(id); };
  const get = (id: string) => {
    prune(); const snapshot = snapshots.get(id);
    if (!snapshot) extensionError("The import preview expired. Prepare the resource again.", 410);
    return snapshot;
  };
  const prepare = async (input: unknown, archive?: Buffer): Promise<ExtensionImportPreview> => {
    prune();
    if (snapshots.size >= 16) extensionError("Too many prepared imports. Close an existing preview.", 429);
    const id = randomUUID(), stage = join(deps.dataDir, "extension-imports", id);
    mkdirSync(stage, { recursive: true });
    let dependencies: PreparedDependency[] = [];
    try {
      let resolved;
      if (archive) {
        await extractResourceArchive(archive, stage, `${stage}.tar`);
        resolved = await resolveExtensionDirectory(extensionRoot(stage), undefined, undefined, "archive", deps);
        if (!("draft" in resolved)) extensionError("Local native plugin archives are not supported. Use an HTTP or HTTPS plugin source URL, or import Grok plugin metadata containing a remote source.");
      } else resolved = await resolveExtension(input, stage, deps);
      let preview: ExtensionImportPreview, root: string;
      if ("draft" in resolved && resolved.draft) {
        const draft = resolved.draft;
        root = draft.root;
        dependencies = await prepareDependencies(draft, stage, deps.plugins);
        preview = botPreview(id, draft);
        preview.plugins = dependencies.map(value => value.preview);
        snapshots.set(id, { stage, root, digest: resourceDigest(root), expires: Date.now() + 30 * 60_000, preview, draft, dependencies });
      } else {
        if (!resolved.root || typeof resolved.source !== "string") extensionError("The plugin source could not be resolved");
        const expectedId = checkPluginExtension(resolved.root);
        const prepared = await deps.plugins.prepare(resolved.source, resolved.root);
        if (expectedId && expectedId !== prepared.id) { deps.plugins.discard(prepared); extensionError(`The native plugin ID does not match extension ${expectedId}`); }
        const current = deps.plugins.list().find(value => value.id === prepared.id);
        const same = current?.source === prepared.source && current.version === prepared.version && resourceDigest(current.path) === prepared.digest;
        dependencies = [{ prepared, ...(current ? { installedIdentity: installedPluginIdentity(current) } : {}), preview: { id: prepared.id, name: prepared.id, optional: false, source: prepared.source, version: prepared.version, ...(current ? { installedVersion: current.version } : {}), state: current ? same ? "installed" : "different" : "install" } }];
        root = prepared.path;
        preview = { id, type: "plugin", source: resolved.source, name: prepared.id, description: prepared.description ?? "", requirements: [], skills: [], memory: [], routines: [], files: filePreviews(root), plugins: dependencies.map(value => value.preview), warnings: [] };
        snapshots.set(id, { stage, root, digest: resourceDigest(root), expires: Date.now() + 30 * 60_000, preview, dependencies });
      }
      return preview;
    } catch (error) {
      for (const dependency of dependencies) if (dependency.prepared) deps.plugins.discard(dependency.prepared);
      rmSync(stage, { recursive: true, force: true }); rmSync(`${stage}.tar`, { force: true });
      if (error instanceof z.ZodError) extensionError(`Invalid extension contents: ${error.issues[0]?.message}`);
      throw error;
    }
  };
  const importSnapshot = (id: string, rawOptions: unknown, auth: RequestAuth): Promise<ExtensionImportResult> => {
    const snapshot = get(id);
    if (snapshot.result) return Promise.resolve(snapshot.result);
    if (snapshot.pending) return snapshot.pending;
    const parsed = optionsSchema.safeParse(rawOptions);
    if (!parsed.success) extensionError("Invalid import options");
    const options = parsed.data as ExtensionImportOptions;
    const run = async () => {
      for (const id of [...options.omitPlugins ?? [], ...options.reusePlugins ?? []]) if (!snapshot.dependencies.some(value => value.preview.id === id)) extensionError(`Unknown plugin selection: ${id}`);
      if (!snapshot.draft && options.omitPlugins?.length) extensionError("A plugin installation cannot omit its plugin");
      if (resourceDigest(snapshot.root) !== snapshot.digest) extensionError("The prepared resource changed. Prepare it again.", 409);
      const ids = await commitDependencies(snapshot.dependencies, deps.plugins, options.omitPlugins ?? [], options.reusePlugins ?? []);
      const warnings = [...snapshot.preview.warnings, ...(options.omitPlugins?.length ? ["Some plugin dependencies were omitted; the imported bot may have reduced capabilities."] : [])];
      const result: ExtensionImportResult = snapshot.draft
        ? { ...await deps.createBot(snapshot.draft, options, ids, auth), warnings }
        : { pluginId: ids[0], warnings };
      snapshot.result = result;
      rmSync(snapshot.stage, { recursive: true, force: true });
      rmSync(`${snapshot.stage}.tar`, { force: true });
      for (const dependency of snapshot.dependencies) if (dependency.prepared) deps.plugins.discard(dependency.prepared);
      return result;
    };
    snapshot.pending = run().finally(() => { snapshot.pending = undefined; });
    return snapshot.pending;
  };
  return { prepare, import: importSnapshot, discard,
    file(id: string, path: string) { const snapshot = get(id); if (snapshot.result) extensionError("This import has completed", 410); if (!snapshot.preview.files.some(file => file.path === path)) extensionError("Resource file was not found", 404); return readFileSync(resourcePath(snapshot.root, path)); },
    close() { for (const id of snapshots.keys()) discard(id); },
  };
}
export type ExtensionHost = ReturnType<typeof createExtensionHost>;
