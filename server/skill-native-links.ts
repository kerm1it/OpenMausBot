import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { DATA_DIR } from "./config.ts";
import { isSkillName } from "../shared/skill-md.ts";
import { directoryEntryState, entryExistsWithoutFollowing } from "./skill-storage.ts";
import { readManagedLinks, writeManagedLinks } from "./skill-link-registry.ts";
import { workspaceDir } from "./workspace.ts";
import { skillsLibraryRoot } from "./skill-library.ts";

const skillStateDir = (botId: string) => join(DATA_DIR, "skill-state", botId);
const skillsDir = (botId: string) => join(workspaceDir(botId), "skills");

function nativeLinkDirectory(root: string, relative: string, create: boolean): string | null {
  const [family, leaf] = relative.split("/");
  if (!family || !leaf) return null;
  const familyDir = join(root, family);
  let familyState = directoryEntryState(familyDir);
  if (familyState === "missing" && create) {
    try {
      mkdirSync(familyDir, { mode: 0o700 });
    } catch {
      return null;
    }
    familyState = directoryEntryState(familyDir);
  }
  if (familyState !== "directory") return null;

  const linkDir = join(familyDir, leaf);
  let linkState = directoryEntryState(linkDir);
  if (linkState === "missing" && create) {
    try {
      mkdirSync(linkDir, { mode: 0o700 });
    } catch {
      return null;
    }
    linkState = directoryEntryState(linkDir);
  }
  return linkState === "directory" ? linkDir : null;
}

/** Approval and enablement state stays outside the bot's working directory. */
function comparablePath(path: string): string {
  const normalized = resolve(path).replace(/^\\\\\?\\/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function nativeLinkPointsToSkill(link: string, target: string): boolean {
  try {
    if (!lstatSync(link).isSymbolicLink()) return false;
    try {
      return comparablePath(realpathSync(link)) === comparablePath(realpathSync(target));
    } catch {
      const rawTarget = readlinkSync(link);
      const resolvedTarget = resolve(dirname(link), rawTarget.replace(/^\\\\\?\\/, ""));
      return comparablePath(resolvedTarget) === comparablePath(target);
    }
  } catch {
    return false;
  }
}

function nativeLinkDirectlyTargetsOwnedSkill(
  link: string,
  root: string,
  name: string,
  revisionWasManaged: boolean,
  targetBaseDirectory = dirname(link),
): boolean {
  try {
    if (!lstatSync(link).isSymbolicLink()) return false;
    const rawTarget = readlinkSync(link);
    const resolvedTarget = resolve(targetBaseDirectory, rawTarget.replace(/^\\\\\?\\/, ""));
    const insideSkills = relative(join(root, "skills"), resolvedTarget).replaceAll("\\", "/");
    const insideLibrary = relative(join(skillsLibraryRoot(), "skills"), resolvedTarget).replaceAll("\\", "/");
    return insideSkills === name || (revisionWasManaged && (/^\.revisions\/[a-f0-9]{64}$/.test(insideSkills) ||
      insideLibrary === name || insideLibrary.startsWith(`.revisions/${name}/`) && /^[a-f0-9]{64}$/.test(insideLibrary.slice(`.revisions/${name}/`.length))));
  } catch {
    return false;
  }
}

type NativeLinkRemoval = "removed" | "preserved" | "retry";

/** renameSync is the identity boundary: a workspace process can replace the name, not which entry was moved. */
function removeOwnedNativeLink(
  botId: string,
  link: string,
  root: string,
  name: string,
  revisionWasManaged: boolean,
  beforeRemove?: (link: string) => void,
): NativeLinkRemoval {
  const quarantineDir = join(skillStateDir(botId), "link-removal");
  try {
    mkdirSync(quarantineDir, { recursive: true, mode: 0o700 });
  } catch {
    return "retry";
  }
  const quarantined = join(quarantineDir, randomUUID());
  beforeRemove?.(link);
  try {
    renameSync(link, quarantined);
  } catch {
    return nativeLinkDirectlyTargetsOwnedSkill(link, root, name, revisionWasManaged)
      ? "retry"
      : "preserved";
  }

  if (nativeLinkDirectlyTargetsOwnedSkill(
    quarantined,
    root,
    name,
    revisionWasManaged,
    dirname(link),
  )) {
    try {
      unlinkSync(quarantined);
      return "removed";
    } catch {
      try {
        if (!entryExistsWithoutFollowing(link)) renameSync(quarantined, link);
      } catch {}
      return "retry";
    }
  }

  try {
    if (!entryExistsWithoutFollowing(link)) renameSync(quarantined, link);
  } catch {}
  return "preserved";
}

const NATIVE_SKILL_DIRS = [".claude/skills", ".agents/skills", ".grok/skills"];

/** Compares link text, never real paths: an unsafe skills/ root is not followed, and a user-replaced link stays. */
function removeNativeLinksForUnsafeSkillsRoot(
  botId: string,
  root: string,
  linkRoot: string,
  threadId: string | undefined,
  previouslyManaged: string[],
  beforeRemove?: (link: string) => void,
): void {
  const retry = new Set<string>();
  for (const dir of NATIVE_SKILL_DIRS) {
    const linkDir = nativeLinkDirectory(linkRoot, dir, false);
    if (!linkDir) {
      for (const name of previouslyManaged) retry.add(name);
      continue;
    }
    let existing: string[];
    try {
      existing = readdirSync(linkDir).filter(isSkillName);
    } catch {
      for (const name of previouslyManaged) retry.add(name);
      continue;
    }
    for (const name of new Set([...existing, ...previouslyManaged])) {
      const link = join(linkDir, name);
      if (!nativeLinkDirectlyTargetsOwnedSkill(link, root, name, previouslyManaged.includes(name))) continue;
      const result = removeOwnedNativeLink(
        botId,
        link,
        root,
        name,
        previouslyManaged.includes(name),
        beforeRemove,
      );
      if (result === "retry") retry.add(name);
    }
  }
  try {
    writeManagedLinks(botId, [...retry], threadId);
  } catch {
  }
}

/** Links, not copies; junctions on Windows, where directory symlinks need privileges. */
export function syncNativeSkillLinks(
  botId: string,
  desired: ReadonlyMap<string, string>,
  options: { beforeRemove?: (link: string) => void; task?: { threadId: string; folder: string } } = {},
): void {
  const root = workspaceDir(botId);
  const linkRoot = options.task?.folder ?? root, threadId = options.task?.threadId;
  const previouslyManaged = readManagedLinks(botId, threadId);
  // The bot can replace its skills root: never follow it, but still revoke existing app links.
  if (directoryEntryState(skillsDir(botId)) === "unsafe") {
    removeNativeLinksForUnsafeSkillsRoot(botId, root, linkRoot, threadId, previouslyManaged, options.beforeRemove);
    return;
  }
  const enabled = [...desired].map(([name, target]) => [name, { target }] as const);
  const managed = new Set<string>();
  for (const dir of NATIVE_SKILL_DIRS) {
    const linkDir = nativeLinkDirectory(linkRoot, dir, enabled.length > 0);
    if (!linkDir) continue;
    let existing: string[] = [];
    try {
      existing = readdirSync(linkDir).filter(isSkillName);
    } catch {
    }
    for (const name of new Set([...existing, ...previouslyManaged])) {
      const link = join(linkDir, name);
      const target = desired.get(name);
      if (target && nativeLinkPointsToSkill(link, target)) {
        managed.add(name);
      } else if (nativeLinkDirectlyTargetsOwnedSkill(link, root, name, previouslyManaged.includes(name))) {
        const result = removeOwnedNativeLink(
          botId,
          link,
          root,
          name,
          previouslyManaged.includes(name),
          options.beforeRemove,
        );
        if (result === "retry") managed.add(name);
      }
    }
    if (!enabled.length) continue;
    for (const [name, entry] of enabled) {
      const link = join(linkDir, name);
      const target = entry.target;
      if (nativeLinkPointsToSkill(link, target)) {
        managed.add(name);
        continue;
      }
      try {
        symlinkSync(
          target,
          link,
          process.platform === "win32" ? "junction" : "dir",
        );
        managed.add(name);
      } catch {
      }
    }
  }
  try {
    writeManagedLinks(botId, [...managed], threadId);
  } catch {
  }
}
