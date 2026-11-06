import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DATA_DIR, type AppConfig } from "./config.ts";
import { createSkillsLibraryHost } from "./host/skills-library.ts";
import { skillFileFromBytes, readSkillDirectoryFiles, writeSkillDirectoryFiles, type SkillFile } from "./skill-files.ts";
import { installLibrarySkill, readLibrarySkillDirectory, readLegacyLibrarySkillDirectoryForReview, readSkillLibraryIndex, setLibrarySkillReviewState } from "./skill-library.ts";
import { learnSource } from "./skill-learn.ts";
import { previousSkillVersion, skillRequestReferences } from "./skill-request-card.ts";
import { shareLearnedSkill, updateSharedLearnedSkill, undoSharedLearnedSkill } from "./skill-share.ts";
import { migrateBotSkillsToLibrary } from "./skills-library-migration.ts";
import { applyStagedSkillWrite, getStagedSkillWrite, installSkillDirectory, listSkills, readLegacySkillDirectoryForReview, readSkillDirectory, readStagedSkillFiles, removeSkill, setSkillEnabled, stageSkillWrite, undoSkillWrite } from "./skills.ts";
import type { BotRecord, Store } from "./store.ts";
import { ensureTaskWorkspace } from "./workspace.ts";

const scratch: string[] = [];
const md = (name: string, description = "Uses the complete directory.") => `---\nname: ${name}\ndescription: ${description}\n---\n\nRun scripts/probe.sh and read assets/data.bin.\n`;
const files = (name: string): SkillFile[] => [
  { path: "SKILL.md", content: md(name) },
  { path: "scripts/probe.sh", content: "\ufeff#!/bin/sh\nprintf fixture\n", ...(process.platform !== "win32" ? { executable: true } : {}) },
  skillFileFromBytes("assets/data.bin", Buffer.from([0, 255, 10, 128])),
  { path: "assets/empty", content: "" },
];
function directory(contents: SkillFile[]) {
  const path = mkdtempSync(join(tmpdir(), "omb-directory-"));
  scratch.push(path);
  writeSkillDirectoryFiles(path, contents);
  return path;
}
function stage(bot: string, input: Parameters<typeof stageSkillWrite>[1]) {
  const result = stageSkillWrite(bot, { ...input, patch: true });
  if ("error" in result) throw new Error(result.error);
  return result;
}
function apply(bot: string, value: ReturnType<typeof stage>) {
  const result = applyStagedSkillWrite(bot, value.id, { expectedSha256: value.sha256, expectedDirectorySha256: value.directorySha256 });
  if ("error" in result) throw new Error(result.error);
  return result;
}
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("complete Skill directories", () => {
  it("preserves binary bytes, empty files, UTF-8 BOM and executable flags through private installation", () => {
    const bot = randomUUID(), name = "full-private";
    const installed = installSkillDirectory(bot, "template:fixture", directory(files(name)));
    expect(installed).toMatchObject({ name, enabled: false, skippedFiles: [] });
    const snapshot = readSkillDirectory(bot, name)!;
    expect(readSkillDirectoryFiles(snapshot.directory)).toEqual(files(name).sort((a, b) => a.path === "SKILL.md" ? -1 : b.path === "SKILL.md" ? 1 : a.path < b.path ? -1 : 1));
    expect(readFileSync(join(snapshot.directory, "assets/data.bin"))).toEqual(Buffer.from([0, 255, 10, 128]));
    expect(readFileSync(join(snapshot.directory, "assets/empty"))).toHaveLength(0);
    if (process.platform !== "win32") expect(statSync(join(snapshot.directory, "scripts/probe.sh")).mode & 0o100).toBeTruthy();
    expect(setSkillEnabled(bot, name, true)).toMatchObject({ enabled: true });
    writeFileSync(join(snapshot.directory, "scripts/probe.sh"), "changed");
    expect(listSkills(bot)[0].enabled).toBe(false);
    expect(readSkillDirectory(bot, name)).toBeNull();
  });

  it("persists pending binary snapshots without placing binary bytes into stage JSON or card metadata", () => {
    const bot = randomUUID();
    const staged = stage(bot, { action: "create", files: files("pending"), source: learnSource("fixture") });
    const json = readFileSync(join(DATA_DIR, "skill-state", bot, "staged.json"), "utf8");
    expect(json).not.toContain(Buffer.from([0, 255, 10, 128]).toString("base64"));
    expect(getStagedSkillWrite(bot, staged.id)?.files).toEqual(staged.files);
    const card = skillRequestReferences(staged);
    expect(card.files).toEqual(expect.arrayContaining([expect.objectContaining({ path: "assets/data.bin", binary: true, size: 4 })]));
    expect(JSON.stringify(card)).not.toContain(Buffer.from([0, 255, 10, 128]).toString("base64"));
    apply(bot, staged);
    expect(readStagedSkillFiles(bot, staged.id)).toEqual(staged.files);
  });

  it("supports script-only patches, explicit deletion, empty writes and complete durable Undo", () => {
    const bot = randomUUID(), name = "patch-skill";
    apply(bot, stage(bot, { action: "create", files: files(name), source: learnSource("fixture") }));
    const previous = previousSkillVersion(bot, { action: "update", name })!;
    expect(previous.directoryRevision).toMatch(/^[a-f0-9]{64}$/);
    const original = readSkillDirectory(bot, name)!;
    const update = stage(bot, { action: "update", targetName: name, files: [{ path: "scripts/probe.sh", content: "", executable: true }], removeFiles: ["assets/data.bin"] });
    apply(bot, update);
    const updated = readSkillDirectory(bot, name)!;
    expect(readFileSync(join(updated.directory, "scripts/probe.sh"))).toHaveLength(0);
    expect(existsSync(join(updated.directory, "assets/data.bin"))).toBe(false);
    expect(undoSkillWrite(bot, { stagedId: update.id, action: "update", name,
      previous: { skillMd: previous.preview, source: previous.source, directoryRevision: previous.directoryRevision } })).toEqual({ undone: true });
    expect(readSkillDirectory(bot, name)?.digest).toBe(original.digest);
  });

  it("shares and updates whole directories atomically, then restores all files with Undo", () => {
    const author = { id: randomUUID(), name: "Author", section: "Team", assignedSkills: [] as string[] };
    const mate = { id: randomUUID(), name: "Mate", section: "Team", assignedSkills: [] as string[] };
    const bots = [author, mate];
    const root = mkdtempSync(join(tmpdir(), "omb-library-directory-")); scratch.push(root);
    const name = "shared-directory";
    apply(author.id, stage(author.id, { action: "create", files: files(name), source: learnSource("fixture") }));
    const patchAssigned = (id: string, assigned: string[]) => { bots.find(bot => bot.id === id)!.assignedSkills = assigned; };
    const shared = shareLearnedSkill({ author, bots, name, patchAssigned, root });
    if ("error" in shared) throw new Error(shared.error);
    const before = readLibrarySkillDirectory(name, root)!;
    expect(readSkillDirectoryFiles(before.directory)).toEqual(readSkillDirectoryFiles(directory(files(name))));
    const rejected = updateSharedLearnedSkill({ bot: mate, bots, name, files: [{ path: "assets/empty", content: "v2" }], expectSha256: shared.sha256, patchAssigned, root });
    expect(rejected).toMatchObject({ error: expect.stringContaining("changed since it was read") });
    const updated = updateSharedLearnedSkill({ bot: mate, bots, name, files: [{ path: "assets/empty", content: "v2" }], expectSha256: before.digest, patchAssigned, root });
    if ("error" in updated) throw new Error(updated.error);
    expect(readLibrarySkillDirectory(name, root)?.digest).not.toBe(before.digest);
    expect(readFileSync(join(before.directory, "assets/empty"))).toHaveLength(0);
    expect(undoSharedLearnedSkill({ authorId: mate.id, name, action: "update", share: updated.share, previous: updated.previous, bots, patchAssigned, root })).toEqual({ undone: true });
    expect(readLibrarySkillDirectory(name, root)?.digest).toBe(before.digest);
  });

  it("migrates reviewed supporting files while template imports remain private", () => {
    const bot = randomUUID(), name = `migrate-${randomUUID().slice(0, 8)}`;
    expect(installSkillDirectory(bot, "github:fixture", directory(files(name)))).not.toHaveProperty("error");
    expect(setSkillEnabled(bot, name, true)).toMatchObject({ enabled: true });
    expect(migrateBotSkillsToLibrary(bot).outcomes).toEqual([expect.objectContaining({ name, outcome: "migrated" })]);
    const migrated = readLibrarySkillDirectory(name)!;
    expect(readFileSync(join(migrated.directory, "assets/data.bin"))).toEqual(Buffer.from([0, 255, 10, 128]));
    const privateName = "template-private";
    installSkillDirectory(bot, "template:fixture", directory(files(privateName)));
    expect(migrateBotSkillsToLibrary(bot).outcomes).toEqual([]);
    expect(readSkillLibraryIndex()[privateName]).toBeUndefined();
  });

  it("pins prompt, slash command, list revision, native directory and share note to a turn", () => {
    const bot = { id: randomUUID(), name: "Pinned", assignedSkills: ["pin-shared"] } as BotRecord;
    const name = "pin-shared";
    installLibrarySkill({ name, instructions: md(name), files: files(name), source: learnSource("fixture"), reviewState: "approved" });
    const record = { ...bot, section: "Team" };
    const store = { bot: () => record, bots: [record], messagesFor: () => [], groupByThread: () => undefined, patchBot: () => {} } as unknown as Store;
    const host = createSkillsLibraryHost({ store, cfg: { features: { skillsLibrary: true, shareLearnedSkills: "ask" } } as unknown as AppConfig, appendSkillRequestCard: () => ({ requestId: "", summary: "" }) });
    const thread = randomUUID();
    host.beginTurnSkills(record, thread);
    const before = host.skillsIndex(record, thread);
    const pinned = host.harnessListing(record.id, [], thread)[0];
    const path = join(ensureTaskWorkspace(record.id, thread), ".agents", "skills", name);
    const target = realpathSync(path);
    expect(before).toContain(JSON.stringify(join(path, "SKILL.md")));
    const updated = updateSharedLearnedSkill({ bot: record, bots: [record], name, files: [{ path: "scripts/probe.sh", content: "v2", executable: true }], expectSha256: pinned.revision!, patchAssigned: () => {} });
    if ("error" in updated) throw new Error(updated.error);
    expect(host.skillsIndex(record, thread)).toBe(before);
    expect(host.harnessListing(record.id, [], thread)[0].revision).toBe(pinned.revision);
    expect(realpathSync(path)).toBe(target);
    expect(host.expandSkillCommand(record, thread, `/${name}`, undefined, [], true)).toContain(JSON.stringify(join(path, "SKILL.md")));
    host.releaseTurnSkills(thread);
    host.beginTurnSkills(record, thread);
    expect(host.skillsIndex(record, thread)).toBe(before);
    expect(realpathSync(path)).not.toBe(target);
    expect(host.harnessListing(record.id, [], thread)[0].revision).not.toBe(pinned.revision);
    host.releaseTurnSkills(thread);
  });

  it("announces a newly shared Skill with the same frozen revision used by native links and the list", () => {
    const author = { id: randomUUID(), name: "Author", section: "Fresh", assignedSkills: [] as string[] };
    const mate = { id: randomUUID(), name: "Mate", section: "Fresh", assignedSkills: [] as string[] };
    const name = "fresh-turn-note", bots = [author, mate];
    apply(author.id, stage(author.id, { action: "create", files: files(name), source: learnSource("fixture") }));
    const patchAssigned = (id: string, names: string[]) => { bots.find(bot => bot.id === id)!.assignedSkills = names; };
    const shared = shareLearnedSkill({ author, bots, name, patchAssigned });
    if ("error" in shared) throw new Error(shared.error);
    const store = { bot: () => mate, bots, messagesFor: () => [{ at: 1 }], groupByThread: () => undefined } as unknown as Store;
    const host = createSkillsLibraryHost({ store, cfg: { features: { skillsLibrary: true, shareLearnedSkills: "ask" } } as AppConfig, appendSkillRequestCard: () => ({ requestId: "", summary: "" }) });
    const bot = mate as BotRecord, thread = randomUUID(); host.beginTurnSkills(bot, thread);
    const note = host.shareNote(bot, thread, true), listed = host.harnessListing(bot.id, [], thread)[0];
    const file = join(ensureTaskWorkspace(bot.id, thread), ".agents", "skills", name, "SKILL.md");
    expect(host.skillsIndex(bot, thread)).not.toContain(name);
    expect(note.text).toContain(`New team skill available: ${name}`);
    expect(note.text).toContain(JSON.stringify(file));
    expect(listed.enabled).toBe(true);
    const target = realpathSync(file);
    const updated = updateSharedLearnedSkill({ bot: mate, bots, name, files: [{ path: "scripts/probe.sh", content: "v2" }], expectSha256: listed.revision!, patchAssigned });
    if ("error" in updated) throw new Error(updated.error);
    expect(host.shareNote(bot, thread, true).text).toBe(note.text);
    expect(host.harnessListing(bot.id, [], thread)[0].revision).toBe(listed.revision);
    expect(realpathSync(file)).toBe(target);
    host.releaseTurnSkills(thread);
  });

  it("requires a new full-directory review before legacy sidecars become enabled", () => {
    const bot = randomUUID(), name = "legacy-sidecars";
    installSkillDirectory(bot, "legacy:fixture", directory([{ path: "SKILL.md", content: md(name) }]));
    setSkillEnabled(bot, name, true);
    const manifestPath = join(DATA_DIR, "skill-state", bot, "skills.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    delete manifest[name].directorySha256;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const original = readSkillDirectory(bot, name)!;
    writeSkillDirectoryFiles(original.directory, [{ path: "scripts/added.sh", content: "printf new", executable: true }]);
    expect(listSkills(bot)[0].enabled).toBe(false);
    expect(setSkillEnabled(bot, name, true)).toHaveProperty("error");
    const review = readLegacySkillDirectoryForReview(bot, name)!;
    expect(setSkillEnabled(bot, name, true, review.digest)).toMatchObject({ enabled: true, directorySha256: review.digest });

    const root = mkdtempSync(join(tmpdir(), "omb-legacy-library-")); scratch.push(root);
    installLibrarySkill({ name, instructions: md(name), root, source: "legacy:fixture", reviewState: "approved" });
    const libraryPath = readLibrarySkillDirectory(name, root)!.directory;
    const indexPath = join(root, "index.json"), index = JSON.parse(readFileSync(indexPath, "utf8"));
    delete index[name].directorySha256;
    writeFileSync(indexPath, JSON.stringify(index));
    writeSkillDirectoryFiles(libraryPath, [{ path: "assets/new.bin", content: "AP8=", encoding: "base64" }]);
    expect(setLibrarySkillReviewState(name, "approved", root)).toHaveProperty("error");
    const libraryReview = readLegacyLibrarySkillDirectoryForReview(name, root)!;
    expect(setLibrarySkillReviewState(name, "approved", root, libraryReview.digest)).toMatchObject({ enabled: true, directorySha256: libraryReview.digest });
  });

  it("rejects a private write derived from a turn pinned before another task updated it", () => {
    const bot = { id: randomUUID(), name: "Concurrent" } as BotRecord, name = "private-concurrent";
    apply(bot.id, stage(bot.id, { action: "create", files: files(name), source: learnSource("fixture") }));
    const store = { bot: () => bot, messagesFor: () => [], groupByThread: () => undefined } as unknown as Store;
    const host = createSkillsLibraryHost({ store, cfg: {} as AppConfig, appendSkillRequestCard: () => ({ requestId: "", summary: "" }) });
    const thread = randomUUID(); host.beginTurnSkills(bot, thread);
    expect(host.privateUpdateRefusal(bot.id, thread, name)).toBeNull();
    apply(bot.id, stage(bot.id, { action: "update", targetName: name, files: [{ path: "scripts/probe.sh", content: "v2" }] }));
    expect(host.privateUpdateRefusal(bot.id, thread, name)).toContain("changed since this turn began");
    host.releaseTurnSkills(thread); host.beginTurnSkills(bot, thread);
    expect(host.privateUpdateRefusal(bot.id, thread, name)).toBeNull();
    host.releaseTurnSkills(thread);
  });

  it("cleans replaced private storage so update, remove and reinstall remain usable", () => {
    const bot = randomUUID(), name = "replace-remove";
    apply(bot, stage(bot, { action: "create", files: files(name), source: learnSource("fixture") }));
    const old = readSkillDirectory(bot, name)!.directory;
    apply(bot, stage(bot, { action: "update", targetName: name, files: [{ path: "scripts/probe.sh", content: "v2" }] }));
    expect(existsSync(old)).toBe(false);
    expect(removeSkill(bot, name)).toEqual({ removed: true });
    expect(installSkillDirectory(bot, "template:fixture", directory(files(name)))).not.toHaveProperty("error");
  });

  it("retains private native targets until a running turn releases them", () => {
    const bot = { id: randomUUID(), name: "Private" } as BotRecord;
    installSkillDirectory(bot.id, "template:fixture", directory(files("live-private")));
    setSkillEnabled(bot.id, "live-private", true);
    const store = { bot: () => bot, messagesFor: () => [], groupByThread: () => undefined } as unknown as Store;
    const host = createSkillsLibraryHost({ store, cfg: {} as AppConfig, appendSkillRequestCard: () => ({ requestId: "", summary: "" }) });
    const thread = randomUUID();
    host.beginTurnSkills(bot, thread);
    const source = readSkillDirectory(bot.id, "live-private")!.directory;
    removeSkill(bot.id, "live-private");
    expect(existsSync(source)).toBe(true);
    expect(host.readBotSkillFile(bot, "live-private", thread)).toBe(md("live-private"));
    host.releaseTurnSkills(thread);
    expect(existsSync(source)).toBe(false);
    expect(installSkillDirectory(bot.id, "template:fixture", directory(files("live-private")))).not.toHaveProperty("error");
  });
});
