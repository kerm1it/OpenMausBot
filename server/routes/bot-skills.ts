import { z } from "zod";

import type { SkillsLibrarySkillWire } from "../../shared/wire.ts";
import type { AppConfig } from "../config.ts";
import { setImportedSkillEnabled } from "../imported-skills.ts";
import { botSkillTemplateSchema } from "../new-bot-defaults.ts";
import { fetchSkillFromSource } from "../skill-fetch.ts";
import { installLibrarySkill, listLibrarySkills, readLibrarySkillFile, readLibrarySkillRevision, readLegacyLibrarySkillDirectoryForReview, readLibrarySkillDirectory, readSkillLibraryIndex, setLibrarySkillReviewState, setLibrarySkillEveryBot, skillsLibraryEnabled } from "../skill-library.ts";
import {
  getStagedSkillWrite, readStagedSkillFiles, installSkill, readLegacySkillDirectoryForReview, readSkillDirectory, listBotSkillsWithOrigin, listStagedSkillWrites, parseSkillMd, removeSkill, scanSkillText, setSkillEnabled,
  type SkillListing, type StagedSkillWrite,
} from "../skills.ts";
import type { BotRecord, Store } from "../store.ts";
import { readSkillDirectoryFiles, skillFileBytes } from "../skill-files.ts";
import { skillFileFromBytes } from "../skill-files.ts";
import { skillImportSummary } from "../skill-folder.ts";
import { skillDirectoryReview } from "../skill-directory-review.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface BotSkillsRouteDeps {
  store: Store;
  cfg: AppConfig;
  listBotSkills(bot: BotRecord, threadId?: string): SkillListing[];
  readBotSkillFile(bot: BotRecord, name: string): string | null;
  stagedSkillListing(staged: StagedSkillWrite): Omit<StagedSkillWrite, "files" | "baseSha256" | "baseAppliedStageId">;
  fetchSkills?: typeof fetchSkillFromSource;
}

export function createBotSkillsRoutes(deps: BotSkillsRouteDeps): RouteHandler {
  const { store, cfg, listBotSkills, readBotSkillFile, stagedSkillListing, fetchSkills = fetchSkillFromSource } = deps;
  return async ({ req, res, url, path, method, json, readBody }) => {
    let m: RegExpMatchArray | null = null;
    const fileMatch = path.match(/^\/api\/(?:bots\/([\w-]+)\/(skills|staged-skills)\/([\w-]+)|skills-library\/([a-z0-9-]+))\/files$/);
    if (fileMatch && method === "GET") {
      const [, botId, kind, name, libraryName] = fileMatch;
      const bot = botId ? store.bot(botId) : undefined;
      const own = bot && name ? readSkillDirectory(bot.id, name) ?? readLegacySkillDirectoryForReview(bot.id, name) : null;
      const shared = libraryName && skillsLibraryEnabled(cfg) ? readLibrarySkillDirectory(libraryName) ?? readLegacyLibrarySkillDirectoryForReview(libraryName) :
        bot && name && skillsLibraryEnabled(cfg) && bot.assignedSkills?.includes(name) ? readLibrarySkillDirectory(name) : null;
      const staged = kind === "staged-skills" && bot && name ? getStagedSkillWrite(bot.id, name) : null;
      const revision = new URL(req.url!, "http://localhost").searchParams.get("revision");
      const historical = libraryName && skillsLibraryEnabled(cfg) && revision ? readLibrarySkillRevision(libraryName, revision) : null;
      const files = historical ?? staged?.files ?? (kind === "staged-skills" && bot && name ? readStagedSkillFiles(bot.id, name) ?? [] : own || shared ? readSkillDirectoryFiles((own ?? shared)!.directory) : []);
      const selected = files.find(file => file.path === new URL(req.url!, "http://localhost").searchParams.get("path"));
      if (!selected) return json(res, 404, { error: "no such Skill file" });
      res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": "attachment",
        "x-content-type-options": "nosniff", "content-security-policy": "sandbox" });
      res.end(skillFileBytes(selected));
      return;
    }
    // Imports land DISABLED: a person enables one after reading SKILL.md and its scan warnings.
    m = path.match(/^\/api\/bots\/([\w-]+)\/skill-template$/);
    if (m && method === "POST") {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const checked = botSkillTemplateSchema.safeParse(await readBody(req));
      if (!checked.success) return json(res, 400, { error: checked.error.message });
      const input = checked.data;
      const parsed = parseSkillMd(input.text);
      if ("error" in parsed || parsed.name !== input.name) return json(res, 400, { error: "Skill name does not match its contents" });
      const installed = installSkill(m[1], input.source, [{ path: "SKILL.md", content: input.text }]);
      if ("error" in installed) return json(res, 422, { error: installed.error });
      if (input.enabled) {
        const enabled = setSkillEnabled(m[1], input.name, true);
        if ("error" in enabled) return json(res, 422, { error: enabled.error });
      }
      return json(res, 201, { installed });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/skills$/);
    if (m && method === "GET") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      // The thread names a folder on disk: only one of this bot's own threads may pick it.
      const asked = url.searchParams.get("threadId");
      const threadId = asked && store.taskByThread(bot.id, asked) ? asked : bot.threadId;
      if (skillsLibraryEnabled(cfg)) {
        const { skills, library } = listBotSkillsWithOrigin(m[1]!, store.bot(m[1])!.assignedSkills);
        const names = new Set(skills.map((skill) => skill.name));
        return json(res, 200, {
          skills: [...skills, ...listBotSkills(bot, threadId).filter((skill) => !names.has(skill.name))],
          library,
          assignedSkills: store.bot(m[1])!.assignedSkills,
          staged: listStagedSkillWrites(m[1]).map(stagedSkillListing),
        });
      }
      return json(res, 200, {
        skills: listBotSkills(bot, threadId),
        staged: listStagedSkillWrites(m[1]).map(stagedSkillListing),
      });
    }
    if (m && method === "POST") {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const parsed = z.object({ source: z.string().min(1).max(2000) }).safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "source must be a GitHub or skills.sh URL, or owner/repo" });
      const fetched = await fetchSkills(parsed.data.source);
      if ("error" in fetched) return json(res, 422, { error: fetched.error });
      const results = fetched.skills.map((skill) => ({
        skill,
        result: installSkill(
          m![1]!,
          skill.source,
          skill.files.map(file => skillFileFromBytes(file.path, file.content, file.executable)),
          skill.github,
          skill.skipped.map(file => file.path),
        ),
      }));
      const errors = results.flatMap(({ result }) => ("error" in result ? [result.error] : []));
      const done = results.flatMap(({ skill, result }) => "error" in result ? [] : [{ skill, installed: result }]);
      if (!done.length) return json(res, 422, { error: errors.join("; ") || "nothing importable found" });
      const imported = done.map(({ skill, installed }) => skillImportSummary(installed.name, skill.files, skill.skipped));
      return json(res, 201, { installed: done.map(({ installed }) => installed), imported, errors });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/skills\/([a-z0-9-]+)$/);
    if (m && method === "GET") {
      const bot = store.bot(m[1]);
      const legacy = bot ? readLegacySkillDirectoryForReview(bot.id, m[2]!) : null;
      const text = bot ? readBotSkillFile(bot, m[2]!) ?? (legacy ? readSkillDirectoryFiles(legacy.directory)[0]!.content : null) : null;
      if (text === null) return json(res, 404, { error: "no such skill" });
      const directory = bot ? readSkillDirectory(bot.id, m[2]!) ?? legacy ?? (skillsLibraryEnabled(cfg) && bot.assignedSkills?.includes(m[2]!) ? readLibrarySkillDirectory(m[2]!) : null) : null;
      return json(res, 200, { text, ...(directory ? skillDirectoryReview(readSkillDirectoryFiles(directory.directory), path) : {}) });
    }
    if (m && method === "PATCH") {
      const parsed = z.object({ enabled: z.boolean(), directorySha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "enabled must be true or false" });
      const bot = store.bot(m[1]);
      // A skill from this computer that none of the bot's own or library skills shadows: this bot's switch for it.
      if (bot && listBotSkills(bot).some((skill) => skill.name === m![2] && (skill as { origin?: string }).origin === "imported")) {
        const result = setImportedSkillEnabled(bot.id, m[2]!, parsed.data.enabled);
        if ("error" in result) return json(res, 409, { error: result.error });
        return json(res, 200, { skill: result });
      }
      const directory = readSkillDirectory(m[1]!, m[2]!) ?? readLegacySkillDirectoryForReview(m[1]!, m[2]!);
      if (parsed.data.enabled && parsed.data.directorySha256 && directory?.digest !== parsed.data.directorySha256) return json(res, 409, { error: "Skill changed after review; review it again" });
      const result = setSkillEnabled(m[1]!, m[2]!, parsed.data.enabled, parsed.data.directorySha256);
      if ("error" in result) return json(res, 404, { error: result.error });
      return json(res, 200, { skill: result });
    }
    if (m && method === "DELETE") {
      const result = removeSkill(m[1]!, m[2]!);
      if ("error" in result) return json(res, 404, { error: result.error });
      return json(res, 200, { ok: true });
    }

    m = path.match(/^\/api\/skills-library$/);
    if (m && method === "GET") {
      if (!skillsLibraryEnabled(cfg)) return json(res, 404, { error: "skills library is not enabled" });
      const index = readSkillLibraryIndex();
      const skills: SkillsLibrarySkillWire[] = listLibrarySkills()
        .map((listing): SkillsLibrarySkillWire => ({
          name: listing.name,
          description: listing.description,
          source: listing.source,
          enabled: listing.enabled,
          everyBot: index[listing.name]?.everyBot === true,
          tags: listing.tags ?? [],
          version: index[listing.name]?.package?.release ?? null,
          importedAt: listing.importedAt,
          ...(listing.license ? { license: listing.license } : {}),
          ...(listing.compatibility ? { compatibility: listing.compatibility } : {}),
          warnings: listing.warnings,
          assignedBots: store.bots
            .filter((bot) => index[listing.name]?.everyBot === true || bot.assignedSkills?.includes(listing.name))
            .map((bot) => ({ id: bot.id, name: bot.name })),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return json(res, 200, { skills });
    }
    if (m && method === "POST") {
      if (!skillsLibraryEnabled(cfg)) return json(res, 404, { error: "skills library is not enabled" });
      const parsed = z.object({ text: z.string().min(1).optional(), source: z.string().min(1).max(2000).optional() }).safeParse(await readBody(req));
      if (!parsed.success || (!parsed.data.text && !parsed.data.source)) return json(res, 400, { error: "Paste a GitHub or skills.sh URL, or the SKILL.md contents" });
      if (parsed.data.source) {
        const fetched = await fetchSkillFromSource(parsed.data.source);
        if ("error" in fetched) return json(res, 422, fetched);
        const results = fetched.skills.map(fetched => {
          const rawInstructions = fetched.files.find(file => file.path === "SKILL.md")?.content;
          const instructions = rawInstructions === undefined ? "" : Buffer.from(rawInstructions).toString("utf8");
          const skill = parseSkillMd(instructions);
          return "error" in skill ? skill : installLibrarySkill({ name: skill.name, instructions,
            files: fetched.files.map(file => skillFileFromBytes(file.path, file.content, file.executable)),
            skippedFiles: fetched.skipped.map(file => file.path), github: fetched.github,
            source: fetched.source, license: skill.license, compatibility: skill.compatibility, tags: skill.tags, reviewState: "disabled" });
        });
        const installed = results.filter(result => !("error" in result));
        const errors = results.flatMap(result => "error" in result ? [result.error] : []);
        if (!installed.length) return json(res, 422, { error: errors.join("; ") || "No importable Skills" });
        return json(res, 201, { skill: installed[0], installed, errors });
      }
      const skill = parseSkillMd(parsed.data.text!);
      if ("error" in skill) return json(res, 400, { error: skill.error });
      const installed = installLibrarySkill({
        name: skill.name,
        instructions: parsed.data.text!,
        source: "local-import",
        license: skill.license,
        compatibility: skill.compatibility,
        tags: skill.tags,
        warnings: scanSkillText(parsed.data.text!),
        reviewState: "disabled",
      });
      if ("error" in installed) return json(res, 422, { error: installed.error });
      return json(res, 201, { skill: installed });
    }
    m = path.match(/^\/api\/skills-library\/([a-z0-9-]+)$/);
    if (m && method === "GET") {
      if (!skillsLibraryEnabled(cfg)) return json(res, 404, { error: "skills library is not enabled" });
      const legacy = readLegacyLibrarySkillDirectoryForReview(m[1]!);
      const text = readLibrarySkillFile(m[1]!) ?? (legacy ? readSkillDirectoryFiles(legacy.directory)[0]!.content : null);
      if (text === null) return json(res, 404, { error: "no such skill" });
      const directory = readLibrarySkillDirectory(m[1]!) ?? legacy;
      return json(res, 200, { text, ...(directory ? skillDirectoryReview(readSkillDirectoryFiles(directory.directory), path) : {}) });
    }
    if (m && method === "PATCH") {
      if (!skillsLibraryEnabled(cfg)) return json(res, 404, { error: "skills library is not enabled" });
      const parsed = z.object({ enabled: z.boolean().optional(), everyBot: z.boolean().optional(), directorySha256: z.string().regex(/^[a-f0-9]{64}$/).optional() })
        .refine(body => (body.enabled !== undefined) !== (body.everyBot !== undefined)).safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "enabled or everyBot must be true or false" });
      const directory = readLibrarySkillDirectory(m[1]!) ?? readLegacyLibrarySkillDirectoryForReview(m[1]!);
      if (parsed.data.enabled && parsed.data.directorySha256 && directory?.digest !== parsed.data.directorySha256) return json(res, 409, { error: "Skill changed after review; review it again" });
      const result = parsed.data.enabled !== undefined
        ? setLibrarySkillReviewState(m[1]!, parsed.data.enabled ? "approved" : "disabled", undefined, parsed.data.directorySha256)
        : setLibrarySkillEveryBot(m[1]!, parsed.data.everyBot!);
      if ("error" in result) return json(res, 404, { error: result.error });
      return json(res, 200, { skill: result });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/skills-library$/);
    if (m && method === "PUT") {
      if (!skillsLibraryEnabled(cfg)) return json(res, 404, { error: "skills library is not enabled" });
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const parsed = z.object({ skills: z.array(z.string().min(1).max(64)).max(200) }).safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "skills must be a list of skill names" });
      const index = readSkillLibraryIndex();
      const names = [...new Set(parsed.data.skills)];
      const unknown = names.filter((name) => !index[name]);
      if (unknown.length) return json(res, 422, { error: "not in the library: " + unknown.join(", ") });
      store.patchBot(m[1]!, { assignedSkills: names });
      return json(res, 200, { assignedSkills: names });
    }
    return PASS;
  };
}
