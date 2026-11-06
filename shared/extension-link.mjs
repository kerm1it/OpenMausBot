const SOURCES = new Set(["openmausbot", "grok-bot"]);
const TYPES = new Set(["bot", "plugin"]);
const SHARE_ID = /^[A-Za-z0-9_-]{21}$/;
const PLUGIN_ID = /^\d{1,19}$/;
const LOCAL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function validId(type, source, value) {
  if (typeof value !== "string" || value.length > 100) return false;
  return source === "grok-bot" ? (type === "bot" ? SHARE_ID : PLUGIN_ID).test(value) : LOCAL_ID.test(value);
}

function sourceUrl(value) {
  if (typeof value !== "string" || value.length > 4096) return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}

/** Desktop delivery accepts only a complete typed request; untyped input is parsed by the import service. */
export function isExtensionImportRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).some(key => !["type", "source", "id", "url"].includes(key))) return false;
  if (!TYPES.has(value.type) || !SOURCES.has(value.source)) return false;
  if ((value.id !== undefined) === (value.url !== undefined)) return false;
  return value.id !== undefined ? validId(value.type, value.source, value.id) : sourceUrl(value.url);
}

export function extensionImportFromLink(input) {
  if (typeof input !== "string" || input.length > 8192) return null;
  let url;
  try { url = new URL(input.trim()); } catch { return null; }
  if (url.username || url.password || url.port || url.hash) return null;
  if (url.protocol === "openmausbot:") {
    if (url.hostname !== "app" || url.pathname !== "/v1/import") return null;
    const keys = [...url.searchParams.keys()];
    if (new Set(keys).size !== keys.length || keys.some(key => !["type", "source", "id", "url"].includes(key))) return null;
    const request = Object.fromEntries(url.searchParams);
    return isExtensionImportRequest(request) ? request : null;
  }
  let type, id;
  if (url.protocol === "grokbot:" && url.hostname === "app") {
    if (url.pathname === "/v1/bot-template") type = "bot";
    else if (url.pathname === "/v1/plugin/add") type = "plugin";
    id = url.searchParams.get("id");
  } else if (url.protocol === "https:" && ["x.ai", "www.x.ai"].includes(url.hostname)) {
    const plugin = url.pathname.match(/^\/bot\/plugin\/([^/]+)\/?$/);
    const bot = url.pathname.match(/^\/bot\/([^/]+)\/?$/);
    if (plugin) { type = "plugin"; id = plugin[1]; }
    else if (bot) { type = "bot"; id = bot[1]; }
  }
  return type && validId(type, "grok-bot", id) ? { type, source: "grok-bot", id } : null;
}
