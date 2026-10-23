import { PASS, type RouteHandler } from "./table.ts";
import { PLUGIN_SOURCE_ERROR } from "../../shared/plugins.ts";
import type { createPluginService } from "../plugin-service.ts";

export function createPluginRoutes(plugins: ReturnType<typeof createPluginService>): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (!["/api/plugins", "/api/plugins/install", "/api/plugins/uninstall"].includes(path)) return PASS;
    if (!auth.scopes.includes("admin")) return json(res, 403, { error: "Plugin library access requires admin scope" });
    if (path === "/api/plugins" && method === "GET") return json(res, 200, { plugins: plugins.list() });
    if (path === "/api/plugins/install" && method === "POST") {
      const body = await readBody(req);
      if (!body || typeof body.source !== "string") return json(res, 400, { error: PLUGIN_SOURCE_ERROR });
      return json(res, 201, await plugins.install(body.source));
    }
    if (path === "/api/plugins/uninstall" && method === "POST") {
      const body = await readBody(req);
      return json(res, 200, await plugins.uninstall(body?.plugin_id));
    }
    return PASS;
  };
}

export function createInternalPluginRoutes(plugins: ReturnType<typeof createPluginService>) {
  return async ({ method, path, res, json, readBody, requireActive }: {
    method: string; path: string; res: import("node:http").ServerResponse;
    json: typeof import("../harness/http.ts").json;
    readBody: () => Promise<any>; requireActive: () => void;
  }) => {
      if (method === "GET" && path === "/api/internal/plugins") return json(res, 200, { plugins: plugins.list() });
      if (method === "POST" && path === "/api/internal/plugins/install") {
        const body = await readBody();
        if (typeof body?.source !== "string") return json(res, 400, { error: "source must be an HTTP or HTTPS URL; local paths are not supported" });
        return json(res, 201, await plugins.install(body.source, requireActive));
      }
      if (method === "POST" && path === "/api/internal/plugins/uninstall") {
        const body = await readBody();
        return json(res, 200, await plugins.uninstall(body?.plugin_id, requireActive));
      }
    return PASS;
  };
}
