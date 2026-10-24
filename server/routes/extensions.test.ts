import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionHost } from "../extension-host.ts";
import { createExtensionRoutes } from "./extensions.ts";
import { PASS, type RouteContext } from "./table.ts";

function setup(path: string, method = "POST", overrides: Partial<RouteContext> = {}) {
  const host = {prepare: vi.fn(async () => ({id: "preview"})), import: vi.fn(async () => ({botId: "created", warnings: []})), file: vi.fn(() => Buffer.from("asset")), discard: vi.fn(), close: vi.fn()} as unknown as ExtensionHost;
  const exporter = vi.fn(async () => ({bytes: Buffer.from("zip"), filename: "fixture.zip"}));
  const res = {writeHead: vi.fn(), end: vi.fn()} as unknown as RouteContext["res"];
  const json = vi.fn();
  const ctx = {path, method, url: new URL(path, "http://fixture.test"), auth: {kind: "loopback", scopes: ["admin", "client"]}, req: {headers: {}}, res, json, readBody: vi.fn(async () => ({input: "https://fixture.test/template.zip"})), ...overrides} as unknown as RouteContext;
  return {host, exporter, res, json, ctx, route: createExtensionRoutes({host, exportBot: exporter})};
}

describe("extension routes", () => {
  it("requires owner/admin authorization before preparing or exporting", async () => {
    for (const path of ["/api/extensions/prepare", "/api/bots/bot/template"]) {
      const fixture = setup(path, "POST", {auth: {kind: "loopback", trust: "service", scopes: ["client"]}});
      await fixture.route(fixture.ctx);
      expect(fixture.json).toHaveBeenCalledWith(fixture.res, 403, expect.any(Object));
      expect(fixture.host.prepare).not.toHaveBeenCalled(); expect(fixture.exporter).not.toHaveBeenCalled();
    }
  });
  it("shares preparation for JSON links and uploaded archives", async () => {
    const link = setup("/api/extensions/prepare"); await link.route(link.ctx);
    expect(link.host.prepare).toHaveBeenCalledWith("https://fixture.test/template.zip");
    const req = Readable.from([Buffer.from("zip fixture")]) as IncomingMessage;
    req.headers = {"content-type": "application/zip"};
    const zip = setup("/api/extensions/prepare", "POST", {req}); await zip.route(zip.ctx);
    expect(zip.host.prepare).toHaveBeenCalledWith(undefined, Buffer.from("zip fixture"));
  });
  it("serves resource files as downloads and dispatches bot export", async () => {
    const file = setup("/api/extensions/preview/files", "GET", {url: new URL("http://fixture.test/api/extensions/preview/files?path=skills/proof/a.bin")});
    await file.route(file.ctx);
    expect(file.host.file).toHaveBeenCalledWith("preview", "skills/proof/a.bin");
    expect(file.res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({"content-disposition": "attachment", "x-content-type-options": "nosniff"}));
    const exported = setup("/api/bots/bot/template", "GET"); await exported.route(exported.ctx);
    expect(exported.exporter).toHaveBeenCalledWith("bot", {}, exported.ctx.auth);
    expect(await exported.route({...exported.ctx, path: "/api/other"})).toBe(PASS);
  });
});
