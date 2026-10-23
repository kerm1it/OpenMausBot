import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as procs from "../procs.ts";
import { assertCodexPluginSelection, prepareCodexPlugins } from "./codex-plugins.ts";
import type { InstalledPlugin } from "../../shared/plugins.ts";


describe("Codex native plugins in a shared home", () => {
  let root: string;
  let installed: InstalledPlugin[];
  const prepare = (env: NodeJS.ProcessEnv, selected: InstalledPlugin[]) => prepareCodexPlugins("fixture-codex", env, selected, { root: join(root, "library"), installed });
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "omb-codex-plugins-"));
    installed = ["alpha", "beta"].map(id => ({ id, version: "1.0.0", source: "fixture", installedAt: 1, path: join(root, "library", id, "package") }));
    vi.spyOn(procs, "execCli").mockImplementation((_cli, _args, _options, callback) => {
      queueMicrotask(() => callback(null, "", ""));
    });
  });
  afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

  it("shares installation and credentials while concurrent selections stay in launch arguments", async () => {
    const home = join(root, "native"); mkdirSync(home);
    writeFileSync(join(home, "auth.json"), "synthetic-auth");
    writeFileSync(join(home, "config.toml"), "# existing provider config\n");
    const env = { HOME: root, CODEX_HOME: home };
    const before = { ...env };
    const [a, b] = await Promise.all([
      prepare(env, [installed[0]!]),
      prepare(env, [installed[1]!]),
    ]);
    expect(a.expected).toEqual({ "alpha@openmausbot": true, "beta@openmausbot": false });
    expect(b.expected).toEqual({ "alpha@openmausbot": false, "beta@openmausbot": true });
    expect(a.args).toContain("plugins.beta@openmausbot.enabled=false");
    expect(b.args).toContain("plugins.alpha@openmausbot.enabled=false");
    expect(procs.execCli).toHaveBeenCalledTimes(3);
    for (const call of vi.mocked(procs.execCli).mock.calls) expect(call[2].env).toBe(env);
    expect(env).toEqual(before);
    expect(readFileSync(join(home, "auth.json"), "utf8")).toBe("synthetic-auth");
    expect(readFileSync(join(home, "config.toml"), "utf8")).toBe("# existing provider config\n");
    expect(existsSync(join(home, "bots"))).toBe(false);
    const empty = await prepare(env, []);
    expect(Object.values(empty.expected)).toEqual([false, false]);
    expect(procs.execCli).toHaveBeenCalledTimes(3);
  });

  it("refuses an implicit personal home and refreshes changed packages in the explicit home", async () => {
    await expect(prepare({ HOME: root }, installed)).rejects.toThrow("explicit absolute CODEX_HOME");
    expect(procs.execCli).not.toHaveBeenCalled();
    const env = { HOME: root, CODEX_HOME: join(root, "application-codex") };
    await prepare(env, installed);
    expect(existsSync(join(env.CODEX_HOME, "plugins/omb-installed.json"))).toBe(true);
    expect(existsSync(join(root, ".codex"))).toBe(false);
    installed = [{ ...installed[0]!, installedAt: 2 }, installed[1]!];
    await prepare(env, installed);
    expect(vi.mocked(procs.execCli).mock.calls.filter(call => call[1][1] === "remove").map(call => call[1][2])).toEqual(["alpha@openmausbot"]);
  });

  it("adds and updates only changed packages", async () => {
    const env = { HOME: root, CODEX_HOME: join(root, "native") };
    const second = installed[1]!; installed = [installed[0]!];
    await prepare(env, installed);
    vi.mocked(procs.execCli).mockClear();
    installed = [...installed, second];
    await prepare(env, []);
    expect(vi.mocked(procs.execCli).mock.calls.map(call => call[1])).toEqual([
      ["plugin", "marketplace", "add", join(root, "library")], ["plugin", "add", "beta@openmausbot"],
    ]);
    vi.mocked(procs.execCli).mockClear();
    installed = [installed[0]!, { ...second, version: "2.0.0" }];
    await prepare(env, []);
    expect(vi.mocked(procs.execCli).mock.calls.map(call => call[1])).toEqual([
      ["plugin", "marketplace", "add", join(root, "library")], ["plugin", "remove", "beta@openmausbot"], ["plugin", "add", "beta@openmausbot"],
    ]);
  });

  it("does nothing without installed plugins and retries failed native installation", async () => {
    const plugins = installed; installed = [];
    expect(await prepare({ HOME: root }, [])).toEqual({ args: [], expected: {} });
    expect(procs.execCli).not.toHaveBeenCalled();
    installed = plugins;
    vi.mocked(procs.execCli).mockImplementationOnce((_cli, _args, _options, callback) => {
      queueMicrotask(() => callback(new Error("native install failed"), "", "fixture failure"));
    });
    const env = { HOME: root, CODEX_HOME: join(root, "application-codex") };
    await expect(prepare(env, [])).rejects.toThrow("fixture failure");
    expect(existsSync(join(env.CODEX_HOME, "plugins/omb-installed.json"))).toBe(false);
    await expect(prepare(env, [])).resolves.toMatchObject({ expected: { "alpha@openmausbot": false } });
  });

  it("removes stale native installations even after the library becomes empty", async () => {
    const env = { HOME: root, CODEX_HOME: join(root, ".codex") };
    await prepare(env, installed);
    vi.mocked(procs.execCli).mockClear();
    installed = [installed[1]!];
    await prepare(env, []);
    expect(vi.mocked(procs.execCli).mock.calls.filter(call => call[1][1] === "remove").map(call => call[1][2])).toEqual(["alpha@openmausbot"]);
    vi.mocked(procs.execCli).mockClear();
    installed = [];
    expect(await prepare(env, [])).toEqual({ args: [], expected: {} });
    expect(vi.mocked(procs.execCli).mock.calls.map(call => call[1])).toEqual([["plugin", "remove", "beta@openmausbot"]]);
    expect(JSON.parse(readFileSync(join(root, ".codex/plugins/omb-installed.json"), "utf8"))).toEqual([]);
  });

  it("refuses ignored overrides, missing installations and malformed native discovery", () => {
    const expected = { "alpha@openmausbot": false, "beta@openmausbot": true };
    const result = { marketplaces: [{ name: "openmausbot", plugins: [
      { id: "alpha@openmausbot", installed: true, enabled: false },
      { id: "beta@openmausbot", installed: true, enabled: true },
    ] }] };
    expect(() => assertCodexPluginSelection(result, expected)).not.toThrow();
    const extra = structuredClone(result);
    extra.marketplaces[0]!.plugins.push({ id: "extra@openmausbot", installed: true, enabled: true });
    expect(() => assertCodexPluginSelection(extra, expected)).toThrow("extra enabled");
    result.marketplaces[0]!.plugins[0]!.enabled = true;
    expect(() => assertCodexPluginSelection(result, expected)).toThrow("No prompt was sent");
    for (const malformed of [null, {}, { marketplaces: [] }, { marketplaces: {} }]) {
      expect(() => assertCodexPluginSelection(malformed, expected)).toThrow("shared CODEX_HOME");
    }
  });
});
