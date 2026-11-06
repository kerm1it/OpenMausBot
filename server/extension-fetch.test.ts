import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { createExtensionHost } from "./extension-host.ts";
import { createPluginService } from "./plugin-service.ts";
import { PluginLibrary } from "./plugins.ts";
import { downloadResource } from "./extension-source.ts";
import { EXTENSION_DEPENDENCY_TIMEOUT_MS } from "./extension-fetch.ts";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup(fetcher: typeof fetch) {
  const root = mkdtempSync(join(tmpdir(), "omb-extension-timeout-")); roots.push(root);
  const plugins = createPluginService({ library: new PluginLibrary(join(root, "plugins")), store: { removePluginReferences: () => [] }, inUse: () => false, getDefaults: () => undefined, saveDefaults: () => {} });
  const host = createExtensionHost({ dataDir: root, plugins, fetcher, createBot: async () => ({ botId: "created" }) });
  return { root, plugins, host };
}
function stalled(signal: AbortSignal) {
  return new Response(new ReadableStream({ start(controller) {
    signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
  } }));
}

it("prepares and installs a Grok bot dependency using only direct download URLs", async () => {
  const archive = zipSync({ "repo-main/pstack/plugin.json": strToU8(JSON.stringify({ name: "pstack", version: "1.0.0" })), "repo-main/pstack/data.bin": new Uint8Array([0, 255, 3]) });
  const expected = [
    "https://raw.githubusercontent.com/kerm1it/grok-bot-exts/main/extensions/grok-bot/bots/_jOdbfkB16zxu7MRcmReE/recipe.json",
    "https://raw.githubusercontent.com/kerm1it/grok-bot-exts/main/extensions/grok-bot/plugins/9717366/plugin.json",
    "https://codeload.github.com/fixture/plugins/zip/main",
  ];
  const fetcher = vi.fn<typeof fetch>(async input => {
    const url = String(input);
    if (url === expected[0]) return Response.json({ name: "Direct download bot", instructions: "Do useful work", plugins: [{ pluginId: "9717366", name: "pstack" }] });
    if (url === expected[1]) return Response.json({ id: "9717366", gitUrl: "https://github.com/fixture/plugins", gitRef: "main", gitPath: "pstack" });
    if (url === expected[2]) return new Response(archive);
    throw new Error(`Unexpected request: ${url}`);
  });
  const { host, plugins } = setup(fetcher);
  try {
    const preview = await host.prepare("https://x.ai/bot/_jOdbfkB16zxu7MRcmReE");
    expect(preview.plugins).toEqual([expect.objectContaining({ id: "pstack", state: "install" })]);
    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual(expected);
    await host.import(preview.id, {}, { kind: "loopback", scopes: ["admin"] });
    expect(plugins.list()).toEqual([expect.objectContaining({ id: "pstack", version: "1.0.0" })]);
  } finally { host.close(); }
});

it("retries a stalled response body once on a fresh request", async () => {
  let attempts = 0;
  const fetcher = vi.fn<typeof fetch>(async (_input, init) => ++attempts === 1 ? stalled(init!.signal!) : new Response("recovered"));
  expect((await downloadResource("https://fixture.test/recipe.json", fetcher, 1024, 10)).toString()).toBe("recovered");
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("returns the bot preview when a plugin exceeds its preparation budget", async () => {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => timeout(ms === EXTENSION_DEPENDENCY_TIMEOUT_MS ? 20 : ms));
  const recipe = { name: "Preview survives", instructions: "Do useful work", plugins: [{ id: "slow", name: "Slow plugin", source: "https://fixture.test/slow.zip" }] };
  const fetcher = vi.fn<typeof fetch>(async (input, init) => String(input).endsWith("recipe.json") ? Response.json(recipe) : stalled(init!.signal!));
  const { host, plugins, root } = setup(fetcher);
  try {
    const preview = await host.prepare("https://fixture.test/recipe.json");
    expect(preview.name).toBe(recipe.name);
    expect(preview.plugins).toEqual([expect.objectContaining({ id: "slow", state: "unavailable", error: expect.stringContaining("Plugin preparation timed out") })]);
    const auth = { kind: "loopback" as const, scopes: ["admin" as const] };
    await expect(host.import(preview.id, {}, auth)).rejects.toThrow("explicitly omitted");
    expect(await host.import(preview.id, { omitPlugins: ["slow"] }, auth)).toMatchObject({ botId: "created" });
    expect(plugins.list()).toEqual([]);
    expect(readdirSync(join(root, "plugins"))).toEqual([]);
  } finally { host.close(); }
});

it("cancels active downloads and removes their staging directory when the client closes", async () => {
  let started!: () => void;
  const downloading = new Promise<void>(resolve => { started = resolve; });
  const fetcher = vi.fn<typeof fetch>(async (_input, init) => { started(); return stalled(init!.signal!); });
  const { host, root } = setup(fetcher);
  const controller = new AbortController();
  const pending = host.prepare("https://fixture.test/recipe.json", undefined, controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await downloading;
  controller.abort();
  await rejected;
  expect(fetcher).toHaveBeenCalledOnce();
  expect(readdirSync(join(root, "extension-imports"))).toEqual([]);
  host.close();
});
