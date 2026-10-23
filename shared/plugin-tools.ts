export const NATIVE_PLUGIN_TOOLS = [
  {
    name: "install_plugin",
    description: "Install a shared plugin from an HTTP/HTTPS archive or GitHub URL; no local paths. Returns its ID for a bot's plugins selection. Components stay native.",
    inputSchema: { type: "object", additionalProperties: false, properties: { source: { type: "string", maxLength: 4096, pattern: "^[hH][tT][tT][pP][sS]?://", description: "HTTP/HTTPS archive or GitHub URL; no local paths." } }, required: ["source"] },
  },
  {
    name: "uninstall_plugin",
    description: "Uninstall a shared plugin and clear bot/default selections. Refuses while a turn uses it.",
    inputSchema: { type: "object", additionalProperties: false, properties: { plugin_id: { type: "string", maxLength: 100 } }, required: ["plugin_id"] },
  },
  {
    name: "list_plugins",
    description: "List installed shared plugins and their IDs, versions and sources. Does not enable anything.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
] satisfies Array<{ name: string; description: string; inputSchema: { type: "object"; [key: string]: unknown } }>;
