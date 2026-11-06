import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionPreparationProgress } from "../shared/extension-import.ts";
import { parseDocument } from "yaml";
import { botTemplateProfileSchema, botTemplateRoutineSchema } from "../shared/bot-template-format.ts";
import { grokExportFromRecipe, parseGrokExport } from "../shared/grok-recipe.ts";
import { isSkillName, parseSkillMd, yamlFrontmatterValue } from "../shared/skill-md.ts";
import { cleanSchedule } from "./routine-schedules.ts";
import type { PreparedBotTemplate } from "./extension-model.ts";
import { downloadGithubDirectory, downloadResource, extensionError, githubSource, resourcePath, responseBytes } from "./extension-source.ts";

const record = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const text = (...values: unknown[]) => values.find(value => typeof value === "string" && value.trim()) as string | undefined;
const list = (value: unknown): any[] => Array.isArray(value) ? value : [];
export const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64);

export function grokPluginSource(plugin: Record<string, any>): string {
  const git = text(plugin.gitUrl, plugin.repositoryUrl);
  if (git && githubSource(git)) {
    const parsed = githubSource(git)!;
    const ref = text(plugin.gitRef) ?? parsed.ref;
    const path = typeof plugin.gitPath === "string" ? plugin.gitPath : parsed.path;
    return ref || path ? `https://github.com/${parsed.repository}/tree/${encodeURIComponent(ref ?? "HEAD")}/${path.split("/").map(encodeURIComponent).join("/")}` : `https://github.com/${parsed.repository}`;
  }
  if (plugin.releaseRepo && plugin.releaseAsset) {
    const repo = String(plugin.releaseRepo).replace(/^https:\/\/github.com\//, "").replace(/\/$/, "");
    return plugin.releaseTag
      ? `https://github.com/${repo}/releases/download/${encodeURIComponent(plugin.releaseTag)}/${encodeURIComponent(plugin.releaseAsset)}`
      : `https://github.com/${repo}/releases/latest/download/${encodeURIComponent(plugin.releaseAsset)}`;
  }
  const source = text(plugin.sourceDownload?.url, plugin.sourceDownload?.archiveUrl, plugin.downloadUrl);
  if (source) return source;
  return extensionError("This Grok plugin has no downloadable implementation source", 422);
}

function protoFields(bytes: Uint8Array): Map<number, Array<Uint8Array | bigint>> {
  const fields = new Map<number, Array<Uint8Array | bigint>>();
  let cursor = 0;
  const varint = () => {
    let value = 0n;
    for (let shift = 0n; shift <= 63n && cursor < bytes.length; shift += 7n) {
      const next = bytes[cursor++]!;
      value |= BigInt(next & 127) << shift;
      if (next < 128) return value;
    }
    return extensionError("Invalid Grok marketplace response", 502);
  };
  while (cursor < bytes.length) {
    const tag = Number(varint()), kind = tag & 7, number = tag >>> 3;
    let value: Uint8Array | bigint;
    if (kind === 0) value = varint();
    else if (kind === 2) {
      const size = Number(varint());
      if (!Number.isSafeInteger(size) || size < 0 || cursor + size > bytes.length) extensionError("Invalid Grok marketplace response", 502);
      value = bytes.subarray(cursor, cursor + size); cursor += size;
    } else if (kind === 1 || kind === 5) { cursor += kind === 1 ? 8 : 4; continue; }
    else return extensionError("Unsupported Grok marketplace response", 502);
    fields.set(number, [...(fields.get(number) ?? []), value]);
  }
  return fields;
}

/** Grok Bot 0.75.5 exposes public plugin source fields through this protobuf catalog. */
export async function fetchGrokPlugin(id: string, fetcher: typeof fetch = fetch): Promise<Record<string, any>> {
  let token = "";
  for (let page = 0; page < 20; page++) {
    const payload = token ? Buffer.concat([Buffer.from([10]), encodeVarint(Buffer.byteLength(token)), Buffer.from(token)]) : Buffer.alloc(0);
    const response = await fetcher("https://api2.cursor.sh/aiserver.v1.DashboardService/ListMarketplacePlugins", {
      method: "POST", headers: { "content-type": "application/proto", "connect-protocol-version": "1", "x-ghost-mode": "true" },
      body: new Uint8Array(payload), signal: AbortSignal.timeout(30_000), redirect: "error",
    });
    if (!response.ok) extensionError(`Grok plugin catalog failed (HTTP ${response.status})`, 502);
    const bytes = new Uint8Array(await responseBytes(response, 8 * 1024 * 1024));
    if (bytes.length > 8 * 1024 * 1024) extensionError("Grok plugin catalog is too large", 502);
    const fields = protoFields(bytes);
    for (const entry of fields.get(1) ?? []) {
      if (typeof entry === "bigint") continue;
      const plugin = protoFields(entry), number = plugin.get(1)?.[0];
      if (String(number) !== id) continue;
      const get = (key: number) => { const value = plugin.get(key)?.[0]; return value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : undefined; };
      return { id, name: get(2), displayName: get(3), description: get(4), repositoryUrl: get(8), gitUrl: get(24), gitRef: get(25), gitPath: get(26), releaseRepo: get(34), releaseAsset: get(35), releaseTag: get(36) };
    }
    const next = fields.get(2)?.[0];
    const nextToken = next instanceof Uint8Array ? Buffer.from(next).toString("utf8") : "";
    if (!nextToken || nextToken === token) break;
    token = nextToken;
  }
  return extensionError(`Grok plugin ${id} was not found in the public catalog`, 404);
}

function encodeVarint(value: number): Buffer {
  const out: number[] = [];
  while (value > 127) { out.push((value & 127) | 128); value >>>= 7; }
  out.push(value); return Buffer.from(out);
}

function portableGrokSkill(content: string, name: string, description?: string): string {
  const frontmatter = content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!frontmatter) return content;
  const document = parseDocument(frontmatter[1]!);
  let fields: unknown;
  try {
    if (document.errors.length) throw document.errors[0];
    fields = document.toJS({ maxAliasCount: 0 });
  } catch { return extensionError(`Grok skill ${name}: invalid YAML frontmatter`); }
  if (!record(fields)) extensionError(`Grok skill ${name}: frontmatter must be a YAML object`);
  const parsed = parseSkillMd(content);
  if (!("error" in parsed) && parsed.name === fields.name && parsed.description === fields.description) return content;
  const portableName = typeof fields.name === "string" && isSkillName(fields.name) ? fields.name : name;
  const portableDescription = text(fields.description, description) ?? name;
  document.delete("name");
  document.delete("description");
  const extra = document.contents && document.toString({ lineWidth: 0 });
  return `---\nname: ${portableName}\ndescription: ${yamlFrontmatterValue(portableDescription)}\n${extra && extra.trim() !== "{}" ? extra : ""}---\n${frontmatter[2]}`;
}

export async function prepareGrokRecipe(raw: unknown, root: string, source: string, fetcher: typeof fetch = fetch, onProgress?: (progress: ExtensionPreparationProgress) => void): Promise<PreparedBotTemplate> {
  if (!record(raw)) extensionError("The Grok recipe must be a JSON object");
  const recipe = record(raw.recipe) ? raw.recipe : raw;
  const legacy = recipe.format === "openmaus.grok/1" || recipe.format === "grokbot-bundle/v1" ? parseGrokExport(recipe) : grokExportFromRecipe(recipe);
  const profile = botTemplateProfileSchema.parse({ schemaVersion: 1, profile: {
    name: legacy.name, title: legacy.title, description: legacy.description, soul: legacy.instructions,
    ...(legacy.color ? { color: legacy.color } : {}),
  }, requirements: legacy.plugins.map(plugin => ({ kind: "app", name: plugin.name, description: plugin.note })) });
  const draft: PreparedBotTemplate = { root, source, profile, skills: [], memory: [], routines: [], pluginReferences: [], warnings: [] };
  for (const app of list(recipe.apps)) {
    if (!record(app)) continue;
    const name = text(app.name) ?? "MCP server";
    const url = text(app.mcpUrl, app.mcp_url);
    draft.profile.requirements ??= [];
    draft.profile.requirements.push({ kind: url ? "mcp-server" : "app", name, description: url });
    draft.warnings.push(`${name} needs to be connected in Apps or MCP settings. Credentials are not imported.`);
  }
  const rawSkills = list(recipe.skills).length ? list(recipe.skills) : legacy.skills;
  onProgress?.({ stage: "skills", completed: 0, total: rawSkills.length });
  for (const input of rawSkills) {
    if (!record(input)) continue;
    const name = slug(text(input.name, input.slug) ?? "skill");
    if (!isSkillName(name)) { draft.warnings.push("A Grok skill has no portable name and was omitted."); continue; }
    const directory = join(root, "skills", name);
    mkdirSync(directory, { recursive: true });
    const github = text(input.sourceUrl, input.url);
    const skillDirectory = github ? githubSource(github) : null;
    if (skillDirectory) await downloadGithubDirectory({ ...skillDirectory, path: skillDirectory.path.replace(/(^|\/)SKILL\.md$/, "") }, directory, fetcher);
    else {
      let content = text(input.body, input.content, input.text, input.instructions) ?? "";
      if (!content) { draft.warnings.push(`Skill ${name} has no downloadable contents and was omitted.`); continue; }
      if (!/^\uFEFF?---\r?\n/.test(content)) content = `---\nname: ${name}\ndescription: ${yamlFrontmatterValue(text(input.description) ?? name)}\n---\n\n${content}`;
      writeFileSync(join(directory, "SKILL.md"), content);
      for (const file of list(input.files)) {
        if (!record(file) || typeof file.path !== "string") continue;
        const target = resourcePath(directory, file.path);
        mkdirSync(dirname(target), { recursive: true });
        if (typeof file.content === "string") writeFileSync(target, file.encoding === "base64" ? Buffer.from(file.content, "base64") : file.content);
        else if (typeof file.url === "string") writeFileSync(target, await downloadResource(file.url, fetcher));
        if (file.executable === true) chmodSync(target, 0o755);
      }
    }
    const skillPath = join(directory, "SKILL.md");
    const original = readFileSync(skillPath, "utf8");
    const portable = portableGrokSkill(original, name, text(input.description));
    const parsed = parseSkillMd(portable);
    if ("error" in parsed) extensionError(`Grok skill ${name}: ${parsed.error}`);
    if (draft.skills.some(value => value.name === parsed.name)) extensionError(`The recipe contains duplicate skill ${parsed.name}`);
    if (portable !== original) writeFileSync(skillPath, portable);
    draft.skills.push({ name: parsed.name, description: parsed.description, directory, path: `skills/${name}/SKILL.md` });
    onProgress?.({ stage: "skills", name: parsed.name, completed: draft.skills.length, total: rawSkills.length });
  }
  const memory = recipe.memories ?? recipe.memory;
  const memories = list(memory).flatMap(value => typeof value === "string" ? [value] : record(value) && value.kind !== "log" ? [text(value.content, value.text) ?? ""] : []).filter(Boolean);
  if (memories.length) draft.memory.push({ path: "MEMORY.md", text: memories.join("\n\n") });
  for (const item of list(recipe.plugins ?? recipe.integrations)) {
    if (typeof item === "string") draft.pluginReferences.push({ id: item, optional: false, ecosystem: "grok-bot" });
    else if (record(item)) {
      const id = text(String(item.pluginId ?? item.id ?? ""), item.name);
      if (id) draft.pluginReferences.push({ id, name: text(item.name), source: text(item.source, item.sourceUrl), optional: item.optional === true, ecosystem: "grok-bot" });
    }
  }
  for (const item of list(recipe.routines)) {
    const candidate = record(item) && record(item.schedule) ? { ...item, schemaVersion: 1 } : null;
    if (candidate) { const parsed = botTemplateRoutineSchema.safeParse(candidate); if (parsed.success) { draft.routines.push(parsed.data); continue; } }
    const name = record(item) ? text(item.name) : undefined;
    const routine = legacy.routines.find(value => value.name === name);
    if (routine?.cron) draft.routines.push(botTemplateRoutineSchema.parse({ schemaVersion: 1, name: routine.name, prompt: routine.prompt, schedule: { type: "cron", expression: routine.cron, timeZone: routine.timeZone || "UTC" } }));
    else draft.warnings.push(`Routine ${name ?? "without a schedule"} needs a supported schedule and was omitted.`);
  }
  for (const routine of draft.routines) {
    try { cleanSchedule(routine.schedule, Date.now()); } catch (error) { extensionError(`Invalid routine schedule: ${(error as Error).message}`); }
  }
  if (/CreateAgent|SendToAgent|SendToUser|update_state|\/home\/box\/agent-data\//.test(legacy.instructions)) draft.warnings.push("This template refers to Grok-specific APIs or paths; review its instructions before use.");
  return draft;
}
