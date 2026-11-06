import { parseGrokExport, type GrokBot } from "./grok-import.ts";

export function grokExportBots(input: unknown): GrokBot[] | null {
  let value = input;
  if (typeof value === "string") {
    if (!value.includes('"grok-bot-export"')) return null;
    return parseGrokExport(value);
  }
  if (!value || typeof value !== "object" || !("format" in value) || value.format !== "grok-bot-export") return null;
  return parseGrokExport(JSON.stringify(value));
}

export function grokBotRecipe(bot: GrokBot) {
  const events = bot.routines.filter(routine => !routine.cron || !["", "schedule", "scheduled", "time", "cron", "interval"].includes(routine.trigger.toLowerCase()));
  return {
    name: bot.name,
    description: bot.description,
    persona: { name: bot.name, title: bot.title, instructions: bot.instructions },
    skills: bot.skills.map(skill => ({ name: skill.name, description: skill.description, content: skill.instructions })),
    memories: [...bot.memories, ...bot.userFacts, ...events.map(routine => `Event routine: ${routine.name}\n${routine.instruction}\nTrigger: ${routine.trigger}\n${routine.details || routine.when}`)],
    routines: bot.routines.filter(routine => !events.includes(routine)).map(routine => ({
      name: routine.name, cron: routine.cron, timeZone: routine.timeZone || "UTC", prompt: routine.instruction,
    })),
    apps: bot.apps,
  };
}
