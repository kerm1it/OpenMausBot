import { basename, join } from "node:path";
import { ATTACHMENTS_DIR } from "./attachments.ts";
import { messageAttachmentName, messageReferencesFile, openMessageFile } from "./message-file.ts";
import { isSkillReferencePath, referenceLimitError } from "./skill-storage.ts";
import { skillFileFromBytes, validSkillFilePath, MAX_SKILL_DIRECTORY_FILES, type SkillFile } from "./skill-files.ts";
import { parseSkillManageReferences } from "./skill-request-card.ts";
import type { Message } from "./store.ts";

export interface SkillToolChanges {
  files: SkillFile[];
  removeFiles?: string[];
  patch?: boolean;
}

/** Binary inputs must be attachments in the authenticated source conversation, never arbitrary host paths. */
export async function readSkillToolAttachment(messages: readonly Message[], id: string, path: string, executable: boolean): Promise<SkillFile> {
  if (!id || basename(id) !== id || id.includes("\\") || id.includes("\0")) throw new Error("Use an attachment filename from this conversation");
  const attachment = messages.flatMap(message => message.attachments ?? []).find(item => basename(item.path) === id);
  const candidate = attachment?.path ?? join(ATTACHMENTS_DIR, id);
  if (!attachment && !messages.some(message => messageReferencesFile(message.text ?? "", candidate) || messageAttachmentName(message.text ?? "", candidate) !== null)) throw new Error("That attachment is not in this conversation");
  const opened = await openMessageFile(candidate, [ATTACHMENTS_DIR]);
  try { return skillFileFromBytes(path, await opened.handle.readFile(), executable); }
  finally { await opened.handle.close(); }
}

export async function parseSkillToolChanges(
  body: Record<string, unknown>,
  readAttachment: (id: string, path: string, executable: boolean) => Promise<SkillFile>,
): Promise<SkillToolChanges | { error: string }> {
  const patch = body.files !== undefined || body.remove_files !== undefined;
  if (patch && body.references !== undefined) return { error: "Use files/remove_files or legacy references, not both" };
  const files: SkillFile[] = [];
  if (typeof body.skill_md === "string" && body.skill_md.trim()) files.push({ path: "SKILL.md", content: body.skill_md });
  if (!patch) {
    const references = parseSkillManageReferences(body.references);
    if ("error" in references) return references;
    if (references.some(file => !isSkillReferencePath(file.path))) return { error: "Legacy references must use references/<topic>.md; use files for scripts and attachments" };
    const limit = referenceLimitError(references);
    if (limit) return { error: limit };
    return { files: [...files, ...references] };
  }
  if (body.files !== undefined && (!Array.isArray(body.files) || body.files.length > MAX_SKILL_DIRECTORY_FILES)) {
    return { error: "files must be a bounded list of Skill file writes" };
  }
  const removeFiles = body.remove_files ?? [];
  if (!Array.isArray(removeFiles) || removeFiles.length > MAX_SKILL_DIRECTORY_FILES || removeFiles.some(path => typeof path !== "string" || !validSkillFilePath(path) || path === "SKILL.md")) {
    return { error: "remove_files must contain relative supporting-file paths" };
  }
  try {
    for (const value of body.files as unknown[] ?? []) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Each Skill file needs a relative path and content or attachment_id");
      const row = value as Record<string, unknown>;
      if (Object.keys(row).some(key => !["path", "content", "attachment_id", "executable"].includes(key))) throw new Error("Unknown Skill file write field");
      if (typeof row.path !== "string" || !validSkillFilePath(row.path)) throw new Error("Use a relative Skill file path");
      if (row.executable !== undefined && typeof row.executable !== "boolean") throw new Error("executable must be a boolean");
      const text = typeof row.content === "string", attachment = typeof row.attachment_id === "string";
      if (text === attachment || (row.content !== undefined && !text) || (row.attachment_id !== undefined && !attachment)) throw new Error("Supply exactly one of content and attachment_id");
      files.push(text ? { path: row.path, content: row.content as string, ...(row.executable !== undefined ? { executable: row.executable } : {}) }
        : await readAttachment(row.attachment_id as string, row.path, row.executable === true));
    }
    const paths = files.map(file => file.path);
    if (new Set(paths).size !== paths.length || new Set(removeFiles).size !== removeFiles.length || removeFiles.some(path => paths.includes(path))) throw new Error("Skill file writes and removals must have distinct paths");
    return { files, removeFiles: removeFiles as string[], patch: true };
  } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}
