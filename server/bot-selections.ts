import type { BotRecord } from "./store.ts";

export function clearVoiceSelections(bots: BotRecord[], save: (next: BotRecord[]) => void, publish: (bot: BotRecord) => void): BotRecord[] {
  const changed = bots.filter((bot) => bot.voice !== undefined && bot.voice !== "");
  if (!changed.length) return [];
  const next = bots.map((bot) =>
    bot.voice === undefined || bot.voice === "" ? bot : { ...bot, voice: undefined });
  save(next);
  for (const bot of changed) {
    delete bot.voice;
    publish(bot);
  }
  return changed;
}

export function removePluginReferences(bots: BotRecord[], id: string, save: (next: BotRecord[]) => void, publish: (bot: BotRecord) => void): BotRecord[] {
  const changed = bots.filter(bot => bot.plugins?.includes(id));
  if (!changed.length) return [];
  save(bots.map(bot => bot.plugins?.includes(id)
    ? { ...bot, plugins: bot.plugins.filter(plugin => plugin !== id) } : bot));
  for (const bot of changed) {
    bot.plugins = bot.plugins!.filter(plugin => plugin !== id);
    publish(bot);
  }
  return changed;
}
