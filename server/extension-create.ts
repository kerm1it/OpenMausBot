import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { MAUS_COLOR_NAMES } from "../shared/wire.ts";
import type { ExtensionImportOptions } from "../shared/extension-import.ts";
import type { RoutineContextAttachment } from "../shared/routines.ts";
import { saveFile, saveImage, deleteAttachment } from "./attachments.ts";
import { parseBotProfilePatch } from "./bot-profile.ts";
import { journalMemoryWrite } from "./memory-journal.ts";
import type { RequestAuth } from "./request-auth.ts";
import type { BotCreateRouteDeps } from "./routes/bots-create.ts";
import { installSkillDirectory } from "./skills.ts";
import type { PreparedBotTemplate } from "./extension-model.ts";
import { extensionError } from "./extension-source.ts";
import { resourcePath } from "./plugins.ts";

const mimes: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".csv": "text/csv", ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json", ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export async function createImportedBot(deps: BotCreateRouteDeps, draft: PreparedBotTemplate, options: ExtensionImportOptions, plugins: string[], auth: RequestAuth) {
  if (!auth.scopes.includes("admin")) extensionError("Importing bot resources requires admin scope", 403);
  const { avatar, color, mascotExpression, ...portable } = draft.profile.profile;
  const parsed = parseBotProfilePatch({ ...portable, name: options.name?.trim() || portable.name }, true);
  if (!parsed.ok) extensionError(parsed.error);
  const profilePatch = Object.fromEntries(Object.entries(parsed.patch).filter(([, value]) => value !== undefined));
  const section = options.section?.trim() || undefined;
  if (section && section.length > 60) extensionError("section must be at most 60 characters");
  const checked = options.modelSelection ? deps.checkedModelSelection(options.modelSelection, undefined, true) : null;
  if (checked && !checked.ok) extensionError(checked.error, checked.status);
  const selection = checked?.ok ? checked.selection : await deps.defaultSelection();
  if (deps.hostedModels && !deps.hostedModels.allows(selection)) extensionError(deps.hostedModels.error());
  const routines = deps.routines();
  if (options.includeRoutines && draft.routines.length && !routines) extensionError("Routines are not available in this workspace", 409);
  if (deps.store.bots.length >= deps.maxWorkspaceBots) extensionError(`this workspace is limited to ${deps.maxWorkspaceBots} bots`, 409);
  const creator = auth.kind === "session" && auth.session.membershipAuthority === "team" ? auth.session.email : undefined;
  const bot = deps.store.createBot({ ...profilePatch, mascotExpression, section, modelSelection: selection, plugins,
    ...(color && (MAUS_COLOR_NAMES as readonly string[]).includes(color) ? { color: color as typeof MAUS_COLOR_NAMES[number] } : {}),
    ...(deps.team && creator ? { createdBy: creator } : {}),
  });
  const createdRoutines: string[] = [], newAttachments: string[] = [];
  try {
    deps.store.patchBot(bot.id, profilePatch);
    if (avatar) {
      const file = resourcePath(draft.root, avatar.path), mime = avatar.mediaType ?? mimes[extname(file).toLowerCase()];
      if (!mime?.startsWith("image/")) extensionError("The template avatar must be a PNG, JPEG, GIF or WebP image");
      const saved = saveImage(readFileSync(file), mime);
      newAttachments.push(saved.path);
      deps.store.patchBot(bot.id, { avatarUrl: `/api/attachments/${basename(saved.path)}` });
    }
    for (const skill of draft.skills) {
      if (options.omitSkills?.includes(skill.name)) continue;
      const installed = installSkillDirectory(bot.id, `template:${draft.source}`, skill.directory);
      if ("error" in installed) extensionError(installed.error, 422);
    }
    if (options.includeMemory) for (const file of draft.memory) journalMemoryWrite(bot.id, file.path, file.text, { actor: "person", via: "api" });
    if (options.includeRoutines) for (const routine of draft.routines) {
      const attachments: RoutineContextAttachment[] = [];
      for (const file of routine.attachments ?? []) {
        const path = resourcePath(draft.root, file.path), bytes = readFileSync(path);
        const mime = file.mediaType ?? mimes[extname(path).toLowerCase()] ?? "application/octet-stream";
        let saved: { path: string; bytes: number };
        if (file.kind === "image") saved = saveImage(bytes, mime);
        else saved = await saveFile((async function* () { yield bytes; })(), file.name, mime, { expectedBytes: bytes.length });
        newAttachments.push(saved.path);
        attachments.push({ id: randomUUID(), name: file.name, kind: file.kind, path: saved.path, size: saved.bytes });
      }
      const { schemaVersion: _version, attachments: _attachments, ...portableRoutine } = routine;
      const created = routines!.create({ ...portableRoutine, attachments, botId: bot.id, enabled: false });
      createdRoutines.push(created.id);
      if (deps.cloudOwnerKey && auth.kind === "session" && deps.cloudOwnerSession(auth)) deps.cloudRoutineAuthors?.wrote(created.id, deps.cloudOwnerKey);
    }
    return { bot: { ...deps.wireBot(bot), messages: deps.store.messagesFor(bot.threadId), activeLeafId: deps.store.activeLeaf(bot.threadId) }, botId: bot.id, threadId: bot.threadId };
  } catch (error) {
    for (const id of createdRoutines) routines?.remove(id);
    deps.store.deleteBot(bot.id);
    for (const path of newAttachments) deleteAttachment(path);
    throw error;
  }
}
