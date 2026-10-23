import { pluginIdSchema, pluginSourceSchema, PLUGIN_SOURCE_ERROR } from "../shared/plugins.ts";

export async function callPluginTool(name: string, args: Record<string, unknown>, fetcher: (path: string, options?: RequestInit) => Promise<any>): Promise<unknown> {
  switch (name) {
    case "uninstall_plugin": {
      const id = pluginIdSchema.safeParse(args.plugin_id);
      if (!id.success) throw new Error("uninstall_plugin needs a valid plugin_id.");
      return fetcher("/api/plugins/uninstall", { method: "POST", body: JSON.stringify({ plugin_id: id.data }) });
    }
    case "list_plugins": return fetcher("/api/plugins");
    case "install_plugin": {
      const source = pluginSourceSchema.safeParse(args.source);
      if (!source.success) throw new Error(PLUGIN_SOURCE_ERROR);
      return fetcher("/api/plugins/install", { method: "POST", body: JSON.stringify({ source: source.data }) });
    }
    default: throw new Error(`Unknown plugin tool: ${name}`);
  }
}
