import { pluginIdSchema, pluginSourceSchema, PLUGIN_SOURCE_ERROR } from "../../shared/plugins.ts";
import type { HarnessClient, Json } from "./agents-client.ts";

export const PLUGIN_TOOL_NAMES = new Set(["install_plugin", "uninstall_plugin", "list_plugins"]);

export async function callPluginTool(name: string, args: Json, client: HarnessClient): Promise<{ text: string; isError?: boolean }> {
  if (name === "uninstall_plugin") {
    if (!pluginIdSchema.safeParse(args.plugin_id).success) return { text: "uninstall_plugin needs a valid plugin_id.", isError: true };
    const result = await client.api("/api/internal/plugins/uninstall", { method: "POST", body: JSON.stringify({ plugin_id: args.plugin_id }) });
    return { text: JSON.stringify(result), ...(result.error ? { isError: true } : {}) };
  }
  if (name === "install_plugin" && !pluginSourceSchema.safeParse(args.source).success) return { text: PLUGIN_SOURCE_ERROR, isError: true };
  const result = await client.api(`/api/internal/plugins${name === "install_plugin" ? "/install" : ""}`, name === "install_plugin" ? { method: "POST", body: JSON.stringify({ source: args.source }) } : undefined);
  return { text: JSON.stringify(result), ...(result.error ? { isError: true } : {}) };
}
