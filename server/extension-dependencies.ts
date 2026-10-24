import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionPluginPreview } from "../shared/extension-import.ts";
import type { PreparedBotTemplate } from "./extension-model.ts";
import type { createPluginService } from "./plugin-service.ts";
import type { PreparedPlugin } from "./plugins.ts";
import { resolveExtension } from "./extension-resolve.ts";
import { extensionError, resourceDigest } from "./extension-source.ts";

export type ExtensionPlugins = ReturnType<typeof createPluginService>;
export interface PreparedDependency { preview: ExtensionPluginPreview; prepared?: PreparedPlugin; committed?: boolean; installedIdentity?: string }

export const installedPluginIdentity = (plugin: ReturnType<ExtensionPlugins["list"]>[number]) => JSON.stringify([plugin.source, plugin.version, plugin.installedAt, resourceDigest(plugin.path)]);

export async function prepareDependencies(draft: PreparedBotTemplate, stage: string, plugins: ExtensionPlugins): Promise<PreparedDependency[]> {
  const out: PreparedDependency[] = [];
  for (const [index, ref] of draft.pluginReferences.entries()) {
    let prepared: PreparedPlugin | undefined;
    try {
      const installed = plugins.list().find(plugin => plugin.id === ref.id);
      if (!ref.source && installed && ref.ecosystem === "grok-bot" && !/^\d+$/.test(ref.id)) {
        out.push({ installedIdentity: installedPluginIdentity(installed), preview: { id: installed.id, name: ref.name ?? installed.id, optional: ref.optional, source: installed.source, version: installed.version, installedVersion: installed.version, state: "installed" } });
        continue;
      }
      if (ref.source) prepared = await plugins.prepare(ref.source);
      else {
        const directory = join(stage, `dependency-${index}`);
        mkdirSync(directory, { recursive: true });
        try {
          const resolved = await resolveExtension({ type: "plugin", source: ref.ecosystem, id: ref.id }, directory);
          if (!("root" in resolved) || !resolved.root || typeof resolved.source !== "string") extensionError("Plugin dependency did not resolve to an implementation");
          prepared = await plugins.prepare(resolved.source, resolved.root);
        } finally { rmSync(directory, { recursive: true, force: true }); }
      }
      if (ref.ecosystem === "openmausbot" && prepared.id !== ref.id) extensionError(`Plugin ${ref.id} resolves to a different native ID (${prepared.id})`);
      if (out.some(value => value.preview.id === prepared!.id)) extensionError(`The template resolves multiple dependencies to plugin ${prepared.id}`);
      const current = plugins.list().find(plugin => plugin.id === prepared!.id);
      const same = current?.source === prepared.source && current.version === prepared.version && resourceDigest(current.path) === prepared.digest;
      out.push({ prepared, ...(current ? { installedIdentity: installedPluginIdentity(current) } : {}), preview: { id: prepared.id, name: ref.name ?? prepared.id, optional: ref.optional,
        source: prepared.source, version: prepared.version, ...(current ? { installedVersion: current.version } : {}), state: current ? same ? "installed" : "different" : "install" } });
    } catch (error) {
      if (prepared) plugins.discard(prepared);
      out.push({ preview: { id: ref.id, name: ref.name ?? ref.id, optional: ref.optional, state: "unavailable", error: error instanceof Error ? error.message : String(error) } });
    }
  }
  return out;
}

export async function commitDependencies(dependencies: PreparedDependency[], plugins: ExtensionPlugins, omit: string[], reuse: string[]): Promise<string[]> {
  const selected: string[] = [];
  for (const dependency of dependencies) {
    const preview = dependency.preview;
    if (omit.includes(preview.id)) continue;
    if (preview.state === "unavailable") extensionError(`Plugin ${preview.id} must be resolved or explicitly omitted`, 409);
    if (preview.state === "different" && !reuse.includes(preview.id)) extensionError(`Explicitly choose the installed version of plugin ${preview.id}`, 409);
    const current = plugins.list().find(plugin => plugin.id === preview.id);
    if (preview.state === "different") {
      if (!current || installedPluginIdentity(current) !== dependency.installedIdentity) extensionError(`Installed plugin ${preview.id} changed. Prepare again.`, 409);
    } else if (preview.state === "installed" || dependency.committed) {
      if (!current || (dependency.committed ? current.source !== preview.source || current.version !== preview.version : installedPluginIdentity(current) !== dependency.installedIdentity)) extensionError(`Installed plugin ${preview.id} changed. Prepare again.`, 409);
    } else {
      if (current) extensionError(`Plugin ${preview.id} was installed after this preview. Prepare again.`, 409);
      await plugins.commit(dependency.prepared!, () => {
        if (plugins.list().some(plugin => plugin.id === preview.id)) extensionError(`Plugin ${preview.id} was installed after this preview. Prepare again.`, 409);
      });
      dependency.committed = true;
    }
    selected.push(preview.id);
  }
  return selected;
}
