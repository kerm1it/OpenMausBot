import { resolve } from "node:path";

const turns = new Map<string, Set<string>>();

export function retainSkillTurnDirectories(threadId: string, directories: Iterable<string>): void {
  const paths = turns.get(threadId) ?? new Set<string>();
  for (const directory of directories) paths.add(resolve(directory));
  turns.set(threadId, paths);
}

export function releaseSkillTurnDirectories(threadId: string): void {
  turns.delete(threadId);
}

export function skillDirectoryInUse(directory: string): boolean {
  const path = resolve(directory);
  return [...turns.values()].some(paths => paths.has(path));
}
