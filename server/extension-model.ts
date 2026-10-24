import type { BotTemplateProfile, BotTemplateRoutine } from "../shared/bot-template-format.ts";

export interface PreparedBotSkill {
  name: string;
  description: string;
  directory: string;
  path: string;
}

export interface PreparedBotTemplate {
  profile: BotTemplateProfile;
  skills: PreparedBotSkill[];
  memory: Array<{ path: string; text: string }>;
  routines: BotTemplateRoutine[];
  pluginReferences: Array<{ id: string; name?: string; source?: string; optional: boolean; ecosystem: "openmausbot" | "grok-bot" }>;
  warnings: string[];
  root: string;
  source: string;
}
