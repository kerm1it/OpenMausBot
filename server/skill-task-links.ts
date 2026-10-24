import { syncImportedSkillLinks, type ImportedSkillView } from "./imported-skills.ts";
import { syncSkillLinks } from "./skills.ts";
import { syncNativeSkillLinks } from "./skill-native-links.ts";
import { ensureTaskWorkspace } from "./workspace.ts";

const pinned = new Map<string, ReadonlyMap<string, string>>();

export function pinTaskSkillLinks(botId: string, threadId: string, directories: ReadonlyMap<string, string>): void {
  pinned.set(`${botId}:${threadId}`, directories);
}

export function releaseTaskSkillLinks(threadId: string): void {
  for (const key of pinned.keys()) if (key.endsWith(`:${threadId}`)) pinned.delete(key);
}

export function syncTaskSkillLinks(
  botId: string,
  threadId: string,
  options: { beforeRemove?: (link: string) => void } = {},
): void {
  const task = { threadId, folder: ensureTaskWorkspace(botId, threadId) };
  const directories = pinned.get(`${botId}:${threadId}`);
  if (directories) syncNativeSkillLinks(botId, directories, { ...options, task });
  else syncSkillLinks(botId, { ...options, task });
}

/** The turn's task folder, with the bot's enabled skills and this turn's skills from this computer (`imported`)
 * linked in. A failed link only loses native discovery; the prompt index still lists them. */
export function ensureTaskWorkspaceWithSkills(botId: string, threadId: string, imported: readonly ImportedSkillView[] = []): string {
  const folder = ensureTaskWorkspace(botId, threadId);
  const linkImported = () => {
    try {
      syncImportedSkillLinks(botId, folder, imported);
    } catch (error) {
      console.warn(`[skills] linking this computer's skills into the task folder failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  // Before the bot's own, so a name it now holds itself is free; after, so a name it gave up is linked this turn.
  linkImported();
  try {
    syncTaskSkillLinks(botId, threadId);
  } catch (error) {
    console.warn(`[skills] linking skills into the task folder failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  linkImported();
  return folder;
}
