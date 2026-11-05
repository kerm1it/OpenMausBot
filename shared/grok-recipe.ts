export const GROK_EXPORT_FORMAT = "openmaus.grok/1";
export const GROK_BUNDLE_FORMAT = "grokbot-bundle/v1";
const MAX_EXPORT_CHARS = 4 * 1024 * 1024;

export interface GrokTemplateCard {
  shareId: string;
  name: string;
  creator?: string;
  description: string;
  url: string;
  color?: string;
}

export interface GrokExport {
  format: typeof GROK_EXPORT_FORMAT | typeof GROK_BUNDLE_FORMAT;
  name: string;
  title?: string;
  description: string;
  instructions: string;
  creator?: string;
  sourceUrl?: string;
  color?: string;
  skills: Array<{ name: string; description: string; body: string }>;
  routines: Array<{ name: string; schedule: string; cron: string; timeZone: string; prompt: string }>;
  plugins: Array<{ name: string; note: string }>;
  memories: string[];
}

export class GrokImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrokImportError";
  }
}

const SHARE_ID = /^[A-Za-z0-9_-]{21}$/;

/** The share id from https://x.ai/bot/<id> (www, a trailing slash or a query allowed) or grokbot://app/v1/bot-template?id=<id>. */
export function grokShareIdFrom(text: string): string | null {
  const raw = String(text ?? "").trim();
  let url: URL;
  try {
    url = new URL(/^(?:www\.)?x\.ai\//i.test(raw) ? `https://${raw}` : raw);
  } catch {
    return null;
  }
  if (url.username || url.password || url.port) return null;
  if (url.protocol === "grokbot:") {
    const id = url.searchParams.get("id") ?? "";
    return url.hostname === "app" && url.pathname === "/v1/bot-template" && SHARE_ID.test(id) ? id : null;
  }
  if (url.protocol !== "https:" || (url.hostname !== "x.ai" && url.hostname !== "www.x.ai")) return null;
  const match = url.pathname.match(/^\/bot\/([^/]+)\/?$/);
  return match && SHARE_ID.test(match[1]!) ? match[1]! : null;
}

export const grokShareUrl = (shareId: string) => `https://x.ai/bot/${shareId}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown): string =>
  typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
const first = (...values: unknown[]) => values.map(str).find(Boolean) ?? "";
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
/** One line of plain text: control and separator characters become spaces (a scan, as in bot-profile.ts). */
function oneLine(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029 ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim();
}
const clip = (value: string, max: number) => (value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`);

/** The JSON object in a pasted reply: inside a ```json fence, or the outermost braces. */
function replyObject(text: string): unknown {
  if (text.length > MAX_EXPORT_CHARS) throw new GrokImportError("That reply is larger than 4 MB.");
  const candidates = [...text.matchAll(/```[a-zA-Z]*[ \t]*\r?\n?([\s\S]*?)```/g)].map((match) => match[1]!);
  const open = text.indexOf("{"), close = text.lastIndexOf("}");
  if (open >= 0 && close > open) candidates.push(text.slice(open, close + 1));
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate.trim());
      if (isRecord(value)) return value;
    } catch {
      // try the next candidate
    }
  }
  throw new GrokImportError("That is not the JSON reply from Grok Bot. Copy the whole code block it wrote and paste it here.");
}

/** A reply or file that says it is a Grok Bot export (it may still be malformed). */
export function isGrokExport(value: unknown): boolean {
  if (typeof value === "string") return value.includes(GROK_EXPORT_FORMAT) || value.includes(GROK_BUNDLE_FORMAT);
  return isRecord(value) && (value.format === GROK_EXPORT_FORMAT || value.format === GROK_BUNDLE_FORMAT);
}

/** Forgiving reader for openmaus.grok/1 and grokbot-bundle/v1: text (fenced or not) or an object. */
export function parseGrokExport(input: unknown): GrokExport {
  const root = typeof input === "string" ? replyObject(input.replace(/^\uFEFF/, "")) : input;
  if (!isRecord(root)) throw new GrokImportError("That is not a Grok Bot export.");
  const format = root.format;
  const bundle = format === GROK_BUNDLE_FORMAT;
  if (format !== undefined && format !== GROK_EXPORT_FORMAT && !bundle) throw new GrokImportError("That is not a Grok Bot export.");
  const persona = isRecord(root.persona) ? root.persona : {};
  const source = isRecord(root.source) ? root.source : {};
  const instructions = first(root.instructions, root.soul, root.systemPrompt, persona.instructions, persona.description);
  const name = oneLine(first(root.name, persona.name, root.botName));
  if (!name && !instructions) throw new GrokImportError("That Grok Bot export has no name or instructions.");
  // A bundle keeps its instructions in persona.description: describe the bot by their first paragraph.
  const description = first(root.description, persona.description === instructions ? "" : persona.description) ||
    (bundle ? clip(instructions.split(/\n\s*\n/)[0]!.trim(), 300) : "");
  const title = oneLine(first(root.title, persona.title));
  const creator = oneLine(first(root.creator, root.author, source.sharerName));
  const color = first(root.color, persona.avatarColor, source.color);
  const shareId = grokShareIdFrom(first(typeof root.source === "string" ? root.source : "", source.url, root.url, root.sourceUrl));
  const skills = list(root.skills).flatMap((skill) => {
    if (typeof skill === "string") return [{ name: skill, description: "", body: "" }];
    if (!isRecord(skill)) return [];
    return [{ name: first(skill.name, skill.title), description: first(skill.description, skill.summary), body: first(skill.body, skill.instructions, skill.content, skill.text) }];
  });
  const routines = list(root.routines).flatMap((routine) => {
    if (!isRecord(routine)) return [];
    return [{
      name: first(routine.name, routine.title),
      schedule: first(routine.schedule, routine.when, routine.trigger, routine.triggerSummary),
      cron: first(routine.cron, routine.cronExpression),
      timeZone: first(routine.timeZone, routine.timezone, routine.tz),
      prompt: first(routine.prompt, routine.instructions, routine.task),
    }];
  });
  const plugins = list(root.plugins ?? root.apps ?? root.integrations).flatMap((plugin) => {
    const label = typeof plugin === "string" ? plugin.trim() : isRecord(plugin) ? first(plugin.name, plugin.label, plugin.id, plugin.slug) : "";
    return label ? [{ name: oneLine(label), note: isRecord(plugin) ? first(plugin.note, plugin.reason, plugin.description) : "" }] : [];
  });
  const memories = list(root.memories).map((memory) => (isRecord(memory) ? first(memory.text, memory.content) : str(memory))).filter(Boolean);
  return {
    format: bundle ? GROK_BUNDLE_FORMAT : GROK_EXPORT_FORMAT,
    name: name || "Grok Bot",
    ...(title ? { title } : {}),
    description,
    instructions,
    ...(creator ? { creator } : {}),
    ...(shareId ? { sourceUrl: grokShareUrl(shareId) } : {}),
    ...(color ? { color } : {}),
    skills,
    routines,
    plugins,
    memories,
  };
}

/** The recipe Cursor's GetGrokBotTemplateImportDetails points at, as an export. The field names follow
 * pi-grokbot-import (MIT, github.com/Shixuuu/pi-grokbot-import); a grokbot-bundle/v1 or openmaus.grok/1 is read as is. */
export function grokExportFromRecipe(recipe: unknown, card?: GrokTemplateCard): GrokExport {
  if (!isRecord(recipe)) throw new GrokImportError("Cursor's answer is not a Grok Bot recipe.");
  const fromCard = card ? { creator: card.creator, sourceUrl: card.url, description: card.description } : {};
  if (recipe.format === GROK_BUNDLE_FORMAT || recipe.format === GROK_EXPORT_FORMAT) {
    const x = parseGrokExport(recipe);
    return { ...x, ...(x.creator || !fromCard.creator ? {} : { creator: fromCard.creator }), ...(x.sourceUrl || !card ? {} : { sourceUrl: card.url }) };
  }
  const profile = isRecord(recipe.persona) ? recipe.persona : isRecord(recipe.profile) ? recipe.profile : {};
  const memory = recipe.memories ?? recipe.memory;
  const memories = typeof memory === "string" ? [memory] : isRecord(memory) ? [first(memory.text, memory.content, memory.profile, memory.md)] : list(memory);
  const started = recipe.gettingStarted;
  const starter = typeof started === "string" ? { body: started } : isRecord(started) ? { name: first(started.name), description: first(started.description), body: first(started.content, started.body, started.text) } : null;
  const skills = [
    ...(starter?.body ? [{ name: starter.name || "getting-started", description: starter.description || "Getting started with this bot.", body: starter.body }] : []),
    ...list(recipe.skills).map((skill) => isRecord(skill) ? { name: first(skill.name, skill.slug), description: first(skill.description), body: first(skill.body, skill.content, skill.text, skill.instructions) } : skill),
  ];
  const routines = list(recipe.routines).map((routine) => {
    if (!isRecord(routine)) return routine;
    const when = isRecord(routine.schedule) ? routine.schedule : {};
    return {
      name: first(routine.name, routine.slug),
      schedule: first(typeof routine.schedule === "string" ? routine.schedule : "", routine.triggerSummary, routine.trigger, routine.description),
      cron: first(routine.cron, when.cron, when.expression),
      timeZone: first(routine.timeZone, routine.timezone, when.timeZone, when.timezone),
      prompt: first(routine.prompt, routine.content, routine.body, routine.instructions),
    };
  });
  const plugins = list(recipe.plugins ?? recipe.integrations).map((plugin) =>
    isRecord(plugin) ? { name: first(plugin.name, plugin.pluginId, plugin.id, plugin.slug), note: first(plugin.note, plugin.description) } : plugin);
  const x = parseGrokExport({
    format: GROK_EXPORT_FORMAT,
    name: first(profile.name, recipe.botName, recipe.name, card?.name),
    title: first(profile.title),
    description: first(fromCard.description, recipe.description),
    instructions: first(recipe.instructions, profile.instructions, profile.systemPrompt, profile.description),
    creator: first(fromCard.creator),
    sourceUrl: first(fromCard.sourceUrl),
    color: first(profile.avatarColor, profile.color, recipe.avatarColor, recipe.color, card?.color),
    skills, routines, plugins, memories,
  });
  if (!x.instructions && !x.skills.length && !x.routines.length) throw new GrokImportError("Cursor's answer did not include the bot's setup.");
  return x;
}
