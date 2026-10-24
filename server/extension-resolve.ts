import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionImportRequest } from "../shared/extension-import.ts";
import { extensionImportFromLink, isExtensionImportRequest } from "../shared/extension-link.mjs";
import { defaultCursorSession } from "./cursor-session.ts";
import { fetchGrokTemplateCard } from "./team-library.ts";
import { fetchGrokPlugin, grokPluginSource, prepareGrokRecipe } from "./extension-grok.ts";
import { checkPluginExtension, prepareOpenMausBot, readResourceJson } from "./extension-prepare.ts";
import { extensionError, fetchExtensionSource, marketSource, resourcePath, type ExtensionSource } from "./extension-source.ts";

export interface ResolveExtensionDeps {
  fetcher?: typeof fetch;
  fetchGrokBot?: (id: string) => Promise<unknown>;
}

export function parseExtensionInput(input: unknown): ExtensionImportRequest | Record<string, unknown> {
  if (typeof input === "string") {
    const value = input.trim();
    const linked = extensionImportFromLink(value);
    if (linked) return linked;
    if (/^https?:\/\//.test(value)) return { url: value };
    try { const json = JSON.parse(value); if (json && typeof json === "object" && !Array.isArray(json)) return json; } catch {}
    return extensionError("Use an extension link, HTTP URL or JSON recipe");
  }
  if (isExtensionImportRequest(input)) return input;
  return extensionError("The extension request must identify its type, source and ID or URL");
}

export async function resolveExtension(input: unknown, stage: string, deps: ResolveExtensionDeps = {}) {
  const request = parseExtensionInput(input);
  if (!isExtensionImportRequest(request) && !(Object.keys(request).length === 1 && "url" in request)) {
    const raw = request as Record<string, unknown>;
    if (raw.gitUrl || raw.releaseRepo || raw.sourceDownload || raw.downloadUrl) {
      const source = grokPluginSource(raw);
      return { root: await fetchExtensionSource(source, stage, deps.fetcher), source, type: "plugin" as const };
    }
    return { draft: await prepareGrokRecipe(request, stage, "grok-bot", deps.fetcher) };
  }
  const typed = request as ExtensionImportRequest;
  let root: string;
  let source: string | ExtensionSource = typed.url ?? marketSource(typed.source!, typed.type!, typed.id!);
  try { root = await fetchExtensionSource(source, stage, deps.fetcher); }
  catch (error) {
    if (!typed.id || typed.source !== "grok-bot" || (error as {status?:number}).status !== 404) throw error;
    if (typed.type === "bot") {
      const recipe = deps.fetchGrokBot ? await deps.fetchGrokBot(typed.id) : await defaultCursorSession().fetchRawTemplate(await fetchGrokTemplateCard(`https://x.ai/bot/${typed.id}`));
      mkdirSync(stage, { recursive: true });
      writeFileSync(join(stage, "recipe.json"), JSON.stringify(recipe));
      return { draft: await prepareGrokRecipe(recipe, stage, "grok-bot", deps.fetcher) };
    }
    const plugin = await fetchGrokPlugin(typed.id, deps.fetcher);
    source = grokPluginSource(plugin);
    root = await fetchExtensionSource(source, stage, deps.fetcher);
    return { root, source, type: "plugin" as const };
  }
  if (typed.id && typed.source === "openmausbot" && (readResourceJson(root, "extension.json") as {id?:unknown}).id !== typed.id) extensionError("The downloaded extension ID does not match the requested market ID");
  if (typed.id && typed.source === "grok-bot" && typed.type === "plugin" && String((readResourceJson(root, "plugin.json") as {id?:unknown}).id) !== typed.id) extensionError("The downloaded Grok plugin ID does not match the requested market ID");
  return resolveExtensionDirectory(root, typed.source, typed.type, typeof source === "string" ? source : `https://github.com/${source.repository}/tree/${source.ref}/${source.path}`, deps);
}

export async function resolveExtensionDirectory(root: string, source?: string, type?: string, origin = source ?? "archive", deps: ResolveExtensionDeps = {}) {
  if (existsSync(resourcePath(root, "extension.json"))) {
    const manifest = readResourceJson(root, "extension.json") as {entrypoints?:{profile?:unknown}};
    if (manifest.entrypoints?.profile) {
      if (type === "plugin") extensionError("The resource is a bot, not a plugin");
      return { draft: prepareOpenMausBot(root, origin) };
    }
  }
  if (existsSync(resourcePath(root, "recipe.json")) || existsSync(resourcePath(root, "template.json"))) {
    if (type === "plugin" || (source && source !== "grok-bot")) extensionError("The resource is a Grok bot recipe");
    const file = existsSync(resourcePath(root, "recipe.json")) ? "recipe.json" : "template.json";
    return { draft: await prepareGrokRecipe(readResourceJson(root, file), root, "grok-bot", deps.fetcher) };
  }
  if (source === "grok-bot" && existsSync(resourcePath(root, "plugin.json"))) {
    const metadata = readResourceJson(root, "plugin.json") as Record<string, unknown>;
    if (metadata.gitUrl || metadata.releaseRepo || metadata.sourceDownload) {
      const url = grokPluginSource(metadata);
      const directory = join(root, ".implementation");
      const implementation = await fetchExtensionSource(url, directory, deps.fetcher);
      return { root: implementation, source: url, type: "plugin" as const };
    }
  }
  if (type === "bot") extensionError("The resource does not contain a bot template");
  checkPluginExtension(root);
  return { root, source: origin, type: "plugin" as const };
}
