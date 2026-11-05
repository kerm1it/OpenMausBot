import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExtensionHost } from "./extension-host.ts";
import { prepareGrokRecipe } from "./extension-grok.ts";
import { createPluginService } from "./plugin-service.ts";
import { PluginLibrary } from "./plugins.ts";
import { createPluginSourceServer } from "./testing/plugin-source.ts";

const auth = {kind: "loopback" as const, scopes: ["admin" as const, "client" as const]};
const manifest = (name: string) => ({schemaVersion: 1, id: "fixture-bot", name: {en: name}, summary: {en: "Fixture"}, publisher: {name: "Fixture"}, category: "general", tags: [], plugins: [], entrypoints: {profile: {path: "bot.json"}, skills: [{path: "skills/proof/SKILL.md"}], memory: [{path: "MEMORY.md"}], routines: []}});
const skill = "---\nname: proof\ndescription: Proof fixture\n---\nUse ./run.sh.\n";

describe("extension prepare and confirmation", () => {
  let root: string, sources: Awaited<ReturnType<typeof createPluginSourceServer>>;
  beforeEach(async () => {root = mkdtempSync(join(tmpdir(), "omb-extension-host-")); sources = await createPluginSourceServer();});
  afterEach(async () => {await sources.close(); rmSync(root, {recursive: true, force: true}); vi.restoreAllMocks();});
  function setup() {
    const plugins = createPluginService({library: new PluginLibrary(join(root, "library")), store: {removePluginReferences: () => []}, inUse: () => false, getDefaults: () => undefined, saveDefaults: () => {}});
    const createBot = vi.fn(async () => ({botId: "created-bot", threadId: "created-thread"}));
    return {plugins, createBot, host: createExtensionHost({dataDir: root, plugins, createBot})};
  }
  it("prepares and imports the official Grok export through the unified host", async () => {
    const {host, createBot} = setup();
    try {
      const preview = await host.prepare(JSON.stringify({format: "grok-bot-export", version: 1, bots: [{
        name: "Official export", instructions: "Keep these instructions", skills: [{name: "Summarize", instructions: "Read the input"}],
      }]}));
      expect(preview.name).toBe("Official export");
      expect(preview.skills[0]?.name).toBe("summarize");
      await host.import(preview.id, {}, auth);
      expect(createBot).toHaveBeenCalledWith(expect.objectContaining({profile: expect.objectContaining({profile: expect.objectContaining({soul: "Keep these instructions"})})}), {}, [], auth);
    } finally { host.close(); }
  });
  it("imports the reviewed archive snapshot once, retaining complete skill files", async () => {
    const {host, createBot} = setup();
    const archive = Buffer.from(zipSync({"extension.json": strToU8(JSON.stringify(manifest("Template"))), "bot.json": strToU8(JSON.stringify({schemaVersion: 1, profile: {name: "Template", soul: "Template instructions"}})), "skills/proof/SKILL.md": strToU8(skill), "skills/proof/run.sh": [strToU8("#!/bin/sh\necho proof"), {os: 3, attrs: 0o100755 << 16}], "skills/proof/asset.bin": new Uint8Array([0, 255, 3]), "MEMORY.md": strToU8("Portable note")}));
    const preview = await host.prepare(undefined, archive);
    expect(preview.skills[0]?.files).toEqual(expect.arrayContaining([expect.objectContaining({path: "skills/proof/run.sh", executable: process.platform !== "win32"}), expect.objectContaining({path: "skills/proof/asset.bin", size: 3})]));
    const bytes = host.file(preview.id, "skills/proof/asset.bin");
    expect(bytes).toEqual(Buffer.from([0, 255, 3]));
    const result = await host.import(preview.id, {}, auth);
    expect(result.botId).toBe("created-bot");
    expect(await host.import(preview.id, {}, auth)).toEqual(result);
    expect(createBot).toHaveBeenCalledTimes(1);
    const [draft, options] = createBot.mock.calls[0]! as unknown as [{skills: Array<{directory:string}>}, object];
    expect(draft.skills[0]!.directory).toContain(join("skills", "proof"));
    expect(options).toEqual({});
    host.close();
  });
  it("installs from its prepared bytes and requires explicit reuse for another source", async () => {
    const {host, plugins} = setup();
    const directory = join(root, "plugin"); mkdirSync(directory);
    writeFileSync(join(directory, "plugin.json"), JSON.stringify({name: "proof", version: "1.0.0"}));
    writeFileSync(join(directory, "run.sh"), "#!/bin/sh\necho original"); chmodSync(join(directory, "run.sh"), 0o755);
    const source = sources.urlFor(directory);
    const preview = await host.prepare(source);
    writeFileSync(join(directory, "run.sh"), "changed after preview");
    expect(await host.import(preview.id, {}, auth)).toMatchObject({pluginId: "proof"});
    expect(readFileSync(join(plugins.list()[0]!.path, "run.sh"), "utf8")).toContain("original");
    const second = await host.prepare(source);
    expect(second.plugins[0]?.state).toBe("different");
    await expect(host.import(second.id, {}, auth)).rejects.toThrow("Explicitly choose");
    expect(await host.import(second.id, {reusePlugins: ["proof"]}, auth)).toMatchObject({pluginId: "proof"});
    expect(readFileSync(join(plugins.list()[0]!.path, "run.sh"), "utf8")).toContain("original");
    host.close();
  });
  it("imports a Grok plugin metadata file through its remote implementation source", async () => {
    const {host} = setup();
    const directory = join(root, "metadata-plugin"); mkdirSync(directory);
    writeFileSync(join(directory, "plugin.json"), JSON.stringify({name: "metadata-proof", version: "1.0.0"}));
    const preview = await host.prepare(JSON.stringify({id: "1234", name: "Metadata plugin", sourceDownload: {url: sources.urlFor(directory)}}));
    expect(preview.type).toBe("plugin");
    expect(await host.import(preview.id, {}, auth)).toMatchObject({pluginId: "metadata-proof"});
    host.close();
  });
  it("explains HTTP source requirements for a local native plugin archive", async () => {
    const {host} = setup();
    await expect(host.prepare(undefined, Buffer.from(zipSync({"plugin.json": strToU8(JSON.stringify({name: "local", version: "1.0.0"}))})))).rejects.toThrow("Use an HTTP or HTTPS plugin source URL");
    host.close();
  });
  it("retains raw Grok plugin IDs and inline binary resources", async () => {
    const draft = await prepareGrokRecipe({profile: {name: "Grok fixture", description: "Do useful work"}, skills: [{name: "proof", content: skill, files: [{path: "asset.bin", content: "AP8D", encoding: "base64"}]}], plugins: [{pluginId: "9717366", name: "pstack"}]}, root, "grok-bot");
    expect(draft.pluginReferences).toEqual([{id: "9717366", name: "pstack", optional: false, source: undefined, ecosystem: "grok-bot"}]);
    expect(draft.skills[0]!.directory).toContain(join("skills", "proof"));
  });
});
