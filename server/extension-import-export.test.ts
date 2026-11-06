import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import { zipSync, strToU8, unzipSync } from "fflate";
import { afterEach, expect, it } from "vitest";
import { createExtensionHost } from "./extension-host.ts";
import { exportBotTemplate } from "./extension-export.ts";
import { createPluginService } from "./plugin-service.ts";
import { PluginLibrary } from "./plugins.ts";
import { Store } from "./store.ts";

const auth = { kind: "loopback" as const, scopes: ["admin" as const, "client" as const] };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), "omb-extension-review-")); roots.push(root);
  const store = new Store(() => ({ instanceId: "claude", model: "fixture" }));
  const plugins = createPluginService({ library: new PluginLibrary(join(root, "plugins")), store, inUse: () => false, getDefaults: () => undefined, saveDefaults: () => {} });
  return { root, store, plugins };
}
it("cancelling a tar-backed template removes its archive and extracted preview", async () => {
  const { root, plugins } = setup();
  const directory = join(root, "source"); mkdirSync(directory);
  writeFileSync(join(directory, "recipe.json"), JSON.stringify({ name: "Archive bot", instructions: "Do useful work." }));
  const stream = tar.c({ cwd: directory, gzip: true }, ["recipe.json"]);
  const chunks: Uint8Array[] = []; for await (const chunk of stream) chunks.push(chunk);
  const host = createExtensionHost({ dataDir: root, plugins, importBot: async () => ({ botId: "created" }) });
  const preview = await host.prepare(undefined, Buffer.concat(chunks));
  host.discard(preview.id);
  expect(readdirSync(join(root, "extension-imports"))).toEqual([]);
  host.close();
});
it("exporting with a new bot name keeps the portable profile and displayed name consistent", async () => {
  const { store, plugins } = setup();
  const bot = store.createBot({ name: "Original bot" });
  try {
    const archive = await exportBotTemplate({ store, plugins, routines: () => null }, bot.id, { name: "Renamed template" }, auth);
    const files = unzipSync(archive.bytes);
    const manifest = JSON.parse(Buffer.from(files["extension.json"]!).toString());
    const profile = JSON.parse(Buffer.from(files["bot.json"]!).toString());
    expect(manifest.name.en).toBe("Renamed template");
    expect(profile.profile.name).toBe("Renamed template");
  } finally { store.deleteBot(bot.id); }
});
it("imports a Grok Skill from an ordinary GitHub Skill directory", async () => {
  const { root } = setup();
  const { prepareGrokRecipe } = await import("./extension-grok.ts");
  const skill = "---\nname: report\ndescription: Report\n---\nRead the references.\n";
  const archive = zipSync({"repo-main/report/SKILL.md": strToU8(skill)});
  const fetcher: typeof fetch = async input => {
    if (String(input) !== "https://codeload.github.com/fixture/skills/zip/main") throw new Error(`Unexpected request ${input}`);
    return new Response(archive);
  };
  const draft = await prepareGrokRecipe({ name: "Grok remote Skill", instructions: "Use report.", skills: [{ name: "report", sourceUrl: "https://github.com/fixture/skills/tree/main/report" }] }, root, "grok-bot", fetcher);
  expect(draft.skills.map(value => value.name)).toEqual(["report"]);
});
it("preserves a Grok plugin source's explicit GitHub ref and subdirectory", async () => {
  const { grokPluginSource } = await import("./extension-grok.ts");
  expect(grokPluginSource({ gitUrl: "https://github.com/cursor/plugins/tree/release-1/pstack" })).toBe("https://github.com/cursor/plugins/tree/release-1/pstack");
});
