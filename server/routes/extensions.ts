import type { BotTemplateExportOptions, ExtensionImportPreview, ExtensionPreparationEvent, ExtensionPreparationProgress } from "../../shared/extension-import.ts";
import type { ExtensionHost } from "../extension-host.ts";
import { EXTENSION_MAX_BYTES, extensionError } from "../extension-source.ts";
import { ownerOrAdmin, type RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export function createExtensionRoutes(deps: {
  host: ExtensionHost;
  exportBot: (id: string, options: BotTemplateExportOptions, auth: RequestAuth) => Promise<{ bytes: Buffer; filename: string }>;
}): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody, url }) => {
    const prepared = path.match(/^\/api\/extensions\/([\w-]+)(?:\/(files|import))?$/);
    const exporting = path.match(/^\/api\/bots\/([\w-]+)\/template$/);
    if (path !== "/api/extensions/prepare" && !prepared && !exporting) return PASS;
    if (!ownerOrAdmin(auth)) return json(res, 403, { error: "Extension import and export requires the admin scope" });
    if (path === "/api/extensions/prepare" && method === "POST") {
      const controller = new AbortController();
      const streaming = String(req.headers.accept ?? "").includes("application/x-ndjson");
      const send = (event: ExtensionPreparationEvent) => {
        if (res.destroyed || res.writableEnded) return;
        if (!res.headersSent) res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-accel-buffering": "no" });
        res.write(`${JSON.stringify(event)}\n`);
      };
      const progress = streaming ? (progress: ExtensionPreparationProgress) => send({ type: "progress", progress }) : undefined;
      const ready = (preview: ExtensionImportPreview) => {
        if (controller.signal.aborted) { deps.host.discard(preview.id); return; }
        if (!streaming) return json(res, 200, preview);
        send({ type: "ready", preview });
        res.end();
      };
      const cancel = () => { if (!res.writableEnded) controller.abort(); };
      res.once("close", cancel);
      try {
        const binary = String(req.headers["content-type"] ?? "").split(";")[0] === "application/zip";
        if (!binary) {
          const body = await readBody(req);
          if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "Import input must be a JSON object" });
          return ready(await deps.host.prepare(body.input, undefined, controller.signal, progress));
        }
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of req) { bytes += chunk.length; if (bytes > EXTENSION_MAX_BYTES) extensionError("Template archive exceeds 64 MiB", 413); chunks.push(Buffer.from(chunk)); }
        return ready(await deps.host.prepare(undefined, Buffer.concat(chunks), controller.signal, progress));
      } catch (error) {
        if (!streaming) throw error;
        send({ type: "error", message: error instanceof Error ? error.message : "Import preparation failed", status: (error as {status?:number}).status ?? 500 });
        res.end();
      } finally { res.off("close", cancel); }
    }
    if (prepared) {
      const [, id, operation] = prepared;
      if (method === "DELETE" && !operation) { deps.host.discard(id!); return json(res, 200, { ok: true }); }
      if (method === "POST" && operation === "import") return json(res, 201, await deps.host.import(id!, await readBody(req), auth));
      if (method === "GET" && operation === "files") {
        const bytes = deps.host.file(id!, url.searchParams.get("path") ?? "");
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.length, "content-disposition": "attachment", "x-content-type-options": "nosniff", "cache-control": "no-store" }); res.end(bytes); return;
      }
    }
    if (exporting && (method === "GET" || method === "POST")) {
      const result = await deps.exportBot(exporting[1]!, method === "POST" ? await readBody(req) : {}, auth);
      res.writeHead(200, { "content-type": "application/zip", "content-length": result.bytes.length, "content-disposition": `attachment; filename="${result.filename}"`, "cache-control": "no-store" }); res.end(result.bytes); return;
    }
    return PASS;
  };
}
