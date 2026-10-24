import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { zipSync, type Zippable } from "fflate";
import { z } from "zod";
import { botExtensionSchema, botTemplateProfileSchema, botTemplateRoutineSchema, type TemplateFileReference } from "../shared/bot-template-format.ts";
import type { BotTemplateExportOptions } from "../shared/extension-import.ts";
import { readAttachment } from "./attachments.ts";
import type { ExtensionPlugins } from "./extension-dependencies.ts";
import { slug } from "./extension-grok.ts";
import { extensionError, resourceFiles } from "./extension-source.ts";
import { copyResourceDirectory } from "./plugins.ts";
import { ownerOrAdmin, type RequestAuth } from "./request-auth.ts";
import type { RoutineManager } from "./routines.ts";
import { readLibrarySkillDirectory } from "./skill-library.ts";
import { readSkillDirectory, resolveBotSkills } from "./skills.ts";
import type { Store } from "./store.ts";
import { listMemoryTopics, readMemoryFile, readMemoryTopic } from "./workspace.ts";

const exportOptionsSchema = z.object({ id: z.string().max(64).optional(), name: z.string().max(80).optional(), summary: z.string().max(4000).optional(), publisher: z.string().max(200).optional(), includeMemory: z.boolean().optional(), includeRoutines: z.boolean().optional() }).strict();

export async function exportBotTemplate(deps: { store: Store; plugins: ExtensionPlugins; routines: () => RoutineManager | null }, id: string, rawOptions: BotTemplateExportOptions, auth: RequestAuth): Promise<{bytes: Buffer;filename: string}> {
  if (!ownerOrAdmin(auth)) extensionError("Exporting bot templates requires admin scope", 403);
  const parsedOptions = exportOptionsSchema.safeParse(rawOptions);
  if (!parsedOptions.success) extensionError("Invalid template export options");
  const options = parsedOptions.data;
  const bot = deps.store.bot(id);
  if (!bot) extensionError("Bot was not found", 404);
  const extensionId = options.id || slug(bot.name) || `bot-${randomUUID().slice(0, 8)}`;
  const root = mkdtempSync(join(tmpdir(), "omb-template-export-"));
  const write = (path: string, bytes: string | Buffer) => { const target = join(root, path); mkdirSync(join(target, ".."), { recursive: true }); writeFileSync(target, bytes); return { path }; };
  const writeJson = (path: string, value: unknown) => write(path, `${JSON.stringify(value, null, 2)}\n`);
  try {
    const { name, title, description, soul, color, mascotBody, mascotExpression, avatarCrop, avatarZoom, avatarFocusX, avatarFocusY } = bot;
    const profile = botTemplateProfileSchema.parse({ schemaVersion: 1, profile: { name: options.name?.trim() || name, title, description, soul, color, mascotBody, mascotExpression, avatarCrop, avatarZoom, avatarFocusX, avatarFocusY } });
    if (bot.avatarUrl) {
      const match = bot.avatarUrl.match(/^\/api\/attachments\/([\w.-]+)$/);
      if (!match) extensionError("The bot avatar is not a stored attachment");
      const avatar = readAttachment(match[1]!);
      if (!avatar) extensionError("The bot avatar file is missing");
      const path = `assets/avatar${extname(match[1]!)}`;
      write(path, avatar.bytes);
      profile.profile.avatar = { path, mediaType: avatar.mime };
    }
    const skills: TemplateFileReference[] = [];
    for (const skill of resolveBotSkills(bot.id, bot.assignedSkills)) {
      const own = readSkillDirectory(bot.id, skill.name);
      const directory = own ?? readLibrarySkillDirectory(skill.name);
      if (!directory) extensionError(`Skill directory is unavailable: ${skill.name}`);
      await copyResourceDirectory(directory.directory, join(root, "skills", skill.name));
      skills.push({ path: `skills/${skill.name}/SKILL.md` });
    }
    const memory: TemplateFileReference[] = [];
    if (options.includeMemory) {
      const index = readMemoryFile(bot.id).text;
      if (index) memory.push(write("MEMORY.md", index));
      for (const topic of listMemoryTopics(bot.id)) {
        const text = readMemoryTopic(bot.id, topic.name);
        if (text !== null) memory.push(write(`memory/${topic.name}`, text));
      }
    }
    const routines: TemplateFileReference[] = [], warnings: string[] = [];
    if (options.includeRoutines) for (const [index, routine] of (deps.routines()?.listRoutines() ?? []).filter(value => value.botId === bot.id).entries()) {
      if (routine.schedule.type === "limit_reset") { warnings.push(`Routine ${routine.name} uses an account-specific limit-reset schedule and was omitted.`); continue; }
      let schedule = routine.schedule;
      if (schedule.type === "daily") {
        const [hour, minute] = schedule.time.split(":");
        schedule = { type: "cron", expression: `${Number(minute)} ${Number(hour)} * * ${schedule.weekdays.join(",")}`, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
      }
      const attachments = (routine.attachments ?? []).map((attachment, attachmentIndex) => {
        const saved = readAttachment(basename(attachment.path));
        if (!saved) extensionError(`Routine attachment is missing: ${attachment.name}`);
        const path = `assets/routines/${index}/${attachmentIndex}${extname(attachment.name)}`;
        write(path, saved.bytes);
        return { path, name: attachment.name, kind: attachment.kind, mediaType: saved.mime };
      });
      const portable = botTemplateRoutineSchema.parse({ schemaVersion: 1, name: routine.name, prompt: routine.prompt, schedule, durationMinutes: routine.durationMinutes, timeoutMinutes: routine.timeoutMinutes, overlap: routine.overlap, attachments });
      routines.push(writeJson(`routines/${index}.json`, portable));
    }
    const installed = deps.plugins.list();
    const plugins = (bot.plugins ?? []).map(pluginId => {
      const plugin = installed.find(value => value.id === pluginId);
      if (!plugin) extensionError(`Selected plugin is not installed: ${pluginId}`);
      return { id: plugin.id, optional: false, source: plugin.source };
    });
    const manifest = botExtensionSchema.parse({ schemaVersion: 1, id: extensionId,
      name: { en: profile.profile.name }, summary: { en: options.summary || bot.description || bot.name },
      publisher: { name: options.publisher || "Personal export" }, category: "general", tags: [], plugins,
      entrypoints: { profile: { path: "bot.json" }, skills, memory, routines },
    });
    writeJson("bot.json", profile); writeJson("extension.json", manifest);
    if (warnings.length) write("IMPORT-NOTES.md", warnings.join("\n\n"));
    const zipped: Zippable = {};
    for (const file of resourceFiles(root)) zipped[file.path] = [readFileSync(join(root, file.path)), { os: 3, attrs: (file.executable ? 0o100755 : 0o100644) << 16 }];
    return { bytes: Buffer.from(zipSync(zipped)), filename: `${extensionId}.zip` };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
