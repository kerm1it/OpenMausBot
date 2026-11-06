import type { ServerResponse } from "node:http";
import { DATA_DIR, skillAuthoringEnabled, type AppConfig } from "../config.ts";
import { appendDecision } from "../decision-log.ts";
import type { DirectApply } from "../direct-apply.ts";
import type { json } from "../harness/http.ts";
import type { SkillsLibraryHost } from "../host/skills-library.ts";
import { learnSource } from "../skill-learn.ts";
import { parseSkillToolChanges, readSkillToolAttachment } from "../skill-tool-input.ts";
import { listStagedSkillWrites, rejectStagedSkillWrite, stageSkillWrite, type SkillListing } from "../skills.ts";
import type { BotRecord, Store } from "../store.ts";
import { PASS } from "./table.ts";

type Staged = Exclude<ReturnType<typeof stageSkillWrite>, { error: string }>;
interface InternalSkillsDeps {
  cfg: AppConfig;
  store: Store;
  skillsHost: SkillsLibraryHost;
  connectorThread(botId: string, threadId: string): unknown;
  listBotSkills(bot: BotRecord): SkillListing[];
  stagedSkillListing(staged: Staged): unknown;
  appliesDirectly(botId: string, threadId: string): DirectApply | null;
  persistence(botId: string, threadId: string, opensCard: boolean): { ok: true } | { ok: false; status: number; error: string };
  apply(from: BotRecord, threadId: string, staged: Staged, direct: DirectApply): { error: string } | Record<string, unknown>;
  appendCard(args: { botId: string; threadId: string; staged: Staged }): { requestId: string; summary: string };
}

export function createInternalSkillsRoutes(deps: InternalSkillsDeps) {
  return async (ctx: {
    method: string; path: string; res: ServerResponse; json: typeof json;
    from: BotRecord; capability: { threadId: string; skillAuthoring?: boolean };
    readBody(): Promise<Record<string, unknown>>; requireActive(): void;
  }) => {
    const { method, path, res, json, from, capability } = ctx;
    if (!(method === "GET" && path === "/api/internal/skills") && !(method === "POST" && path === "/api/internal/skills/stage")) return PASS;
    if (!skillAuthoringEnabled(deps.cfg)) return json(res, 403, { error: "skill authoring is not enabled in Settings" });
    if (!capability.skillAuthoring) return json(res, 403, { error: "skill authoring is not enabled for this turn" });
    const threadId = capability.threadId;
    if (!deps.connectorThread(from.id, threadId)) return json(res, 403, { error: "source conversation does not belong to sender" });
    if (method === "GET") return json(res, 200, {
      skills: deps.skillsHost.harnessListing(from.id, deps.listBotSkills(from), threadId),
      staged: listStagedSkillWrites(from.id).map(deps.stagedSkillListing),
    });
    const body = await ctx.readBody();
    const direct = deps.appliesDirectly(from.id, threadId);
    const persistence = deps.persistence(from.id, threadId, !direct);
    if (!persistence.ok) return json(res, persistence.status, { error: persistence.error });
    const action = body.action === "create" || body.action === "update" ? body.action : undefined;
    if (!action) return json(res, 400, { error: 'action must be "create" or "update"' });
    const skillMd = typeof body.skill_md === "string" ? body.skill_md : undefined;
    if (action === "create" && !skillMd?.trim()) return json(res, 400, { error: "skill_manage create needs skill_md with YAML name and description" });
    const source = typeof body.source === "string" ? body.source.trim() : "";
    if (!source) return json(res, 400, { error: 'source must be a URL, folder, or "conversation"' });
    const targetName = typeof body.skill_name === "string" ? body.skill_name.trim() : "";
    if (action === "update" && !targetName) return json(res, 400, { error: "skill_name is required when action is update" });
    const changes = await parseSkillToolChanges(body, (id, path, executable) => readSkillToolAttachment(deps.store.messagesFor(threadId), id, path, executable));
    if ("error" in changes) return json(res, 400, changes);
    ctx.requireActive();
    if (action === "update" && deps.skillsHost.editable(from.id, targetName)) return json(res,
      ...deps.skillsHost.harnessUpdate(from, threadId, targetName, skillMd, body.gist, body.base_revision, direct, changes));
    const stale = action === "update" ? deps.skillsHost.privateUpdateRefusal(from.id, threadId, targetName) : null;
    if (stale) return json(res, 409, { error: stale });
    const staged = stageSkillWrite(from.id, {
      action, targetName: targetName || undefined, ...changes,
      gist: typeof body.gist === "string" ? body.gist : undefined,
      source: learnSource(source),
    });
    if ("error" in staged) return json(res, 422, { error: staged.error });
    if (direct) {
      const applied = deps.apply(from, threadId, staged, direct);
      if ("error" in applied) return json(res, 422, { state: "failed", error: applied.error });
      return json(res, 201, { state: "applied", stagedId: staged.id, name: staged.name, action: staged.action,
        gist: staged.gist, warnings: staged.warnings, ...applied, summary: `Skill ${staged.name} ${staged.action === "create" ? "enabled" : "updated"}.` });
    }
    let card: ReturnType<InternalSkillsDeps["appendCard"]>;
    try { card = deps.appendCard({ botId: from.id, threadId, staged }); }
    catch (error) { rejectStagedSkillWrite(from.id, staged.id); throw error; }
    appendDecision(DATA_DIR, { threadId, requestId: card.requestId, botId: from.id, botName: from.name,
      tool: "stage_skill", summary: card.summary, decision: "card-shown", source: "skill" });
    return json(res, 201, { state: "pending", stagedId: staged.id, name: staged.name, action: staged.action,
      gist: staged.gist, warnings: staged.warnings, summary: card.summary });
  };
}
