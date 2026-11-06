import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { botExtensionSchema, botTemplateProfileSchema, botTemplateRoutineSchema, pluginExtensionSchema, templateFileReferenceSchema, type TemplateFileReference } from "../shared/bot-template-format.ts";
import type { ExtensionFilePreview, ExtensionImportPreview } from "../shared/extension-import.ts";
import { parseSkillMd } from "../shared/skill-md.ts";
import type { PreparedBotTemplate } from "./extension-model.ts";
import { cleanSchedule } from "./routine-schedules.ts";
import { resourcePath } from "./plugins.ts";
import { extensionError, resourceFiles } from "./extension-source.ts";

export function readResourceJson(root: string, path: string): unknown {
  try { return JSON.parse(readFileSync(resourcePath(root, path), "utf8")); }
  catch { return extensionError(`Invalid or missing JSON resource: ${path}`); }
}

export function checkedResourceFile(root: string, ref: TemplateFileReference): string {
  templateFileReferenceSchema.parse(ref);
  const path = resourcePath(root, ref.path);
  if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) extensionError(`Resource file is missing: ${ref.path}`);
  const bytes = readFileSync(path);
  if (ref.size !== undefined && ref.size !== bytes.length) extensionError(`Resource size does not match: ${ref.path}`);
  if (ref.sha256 && ref.sha256 !== createHash("sha256").update(bytes).digest("hex")) extensionError(`Resource checksum does not match: ${ref.path}`);
  return path;
}

export function prepareOpenMausBot(root: string, source: string): PreparedBotTemplate {
  const parsed = botExtensionSchema.safeParse(readResourceJson(root, "extension.json"));
  if (!parsed.success) extensionError(`Invalid bot extension manifest: ${parsed.error.issues[0]?.message}`);
  const manifest = parsed.data;
  for (const ref of Object.values(manifest.entrypoints).flatMap(value => Array.isArray(value) ? value : [value])) checkedResourceFile(root, ref);
  const profile = botTemplateProfileSchema.parse(readResourceJson(root, manifest.entrypoints.profile.path));
  if (profile.profile.avatar) checkedResourceFile(root, profile.profile.avatar);
  const names = new Set<string>();
  const skills = manifest.entrypoints.skills.map(ref => {
    if (basename(ref.path) !== "SKILL.md") extensionError("Skill entry points must identify SKILL.md");
    const skill = parseSkillMd(readFileSync(checkedResourceFile(root, ref), "utf8"));
    if ("error" in skill) extensionError(`Invalid skill ${ref.path}: ${skill.error}`);
    if (names.has(skill.name)) extensionError(`The template contains duplicate skill ${skill.name}`);
    names.add(skill.name);
    return { name: skill.name, description: skill.description, path: ref.path, directory: dirname(resourcePath(root, ref.path)) };
  });
  const memory = manifest.entrypoints.memory.map(ref => {
    const path = /^(?:MEMORY\.md|memory\/[a-zA-Z0-9_-]+\.md)$/.test(ref.path) ? ref.path : `memory/${basename(ref.path).replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/\.md$/, "")}.md`;
    return { path, text: readFileSync(checkedResourceFile(root, ref), "utf8") };
  });
  const routines = manifest.entrypoints.routines.map(ref => {
    const routine = botTemplateRoutineSchema.parse(readResourceJson(root, ref.path));
    try { cleanSchedule(routine.schedule, Date.now()); } catch (error) { extensionError(`Invalid routine schedule: ${(error as Error).message}`); }
    for (const attachment of routine.attachments ?? []) checkedResourceFile(root, attachment);
    return routine;
  });
  return { root, source, profile, skills, memory, routines,
    pluginReferences: manifest.plugins.map(value => ({ ...value, ecosystem: "openmausbot" as const })), warnings: existsSync(resourcePath(root, "IMPORT-NOTES.md")) ? [readFileSync(resourcePath(root, "IMPORT-NOTES.md"), "utf8")] : [],
  };
}

export function checkPluginExtension(root: string): string | null {
  if (!existsSync(resourcePath(root, "extension.json"))) return null;
  const manifest = pluginExtensionSchema.parse(readResourceJson(root, "extension.json"));
  for (const ref of Object.values(manifest.entrypoints).flatMap(value => value ?? [])) checkedResourceFile(root, ref);
  return manifest.id;
}

export function filePreviews(root: string, prefix = ""): ExtensionFilePreview[] {
  return resourceFiles(root).map(file => {
    let text: string | undefined;
    if (file.size <= 256 * 1024) {
      const bytes = readFileSync(resourcePath(root, file.path));
      if (!bytes.includes(0)) {
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch {}
      }
    }
    return { path: prefix ? `${prefix}/${file.path}` : file.path, size: file.size, executable: file.executable, ...(text === undefined ? {} : { text }) };
  });
}

export function botPreview(id: string, draft: PreparedBotTemplate): ExtensionImportPreview {
  return {
    id, type: "bot", source: draft.source, name: draft.profile.profile.name,
    description: draft.profile.profile.description ?? "", profile: draft.profile.profile,
    requirements: draft.profile.requirements ?? [],
    skills: draft.skills.map(skill => ({ name: skill.name, description: skill.description, path: skill.path, files: filePreviews(skill.directory, dirname(skill.path) === "." ? "" : dirname(skill.path)) })),
    plugins: [], memory: draft.memory, routines: draft.routines.map(routine => ({ name: routine.name, schedule: JSON.stringify(routine.schedule) })),
    files: filePreviews(draft.root), warnings: draft.warnings,
  };
}
