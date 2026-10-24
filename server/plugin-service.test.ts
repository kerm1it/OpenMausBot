import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PluginLibrary } from "./plugins.ts";
import { createPluginService } from "./plugin-service.ts";
import { newBotDefaultsSchema } from "./new-bot-defaults.ts";

let root: string;
let library: PluginLibrary;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omb-plugin-uninstall-"));
  library = new PluginLibrary(join(root, "library"));
  mkdirSync(join(library.root, "proof", "package"), { recursive: true });
  writeFileSync(join(library.root, "proof", "package", "proof.txt"), "proof");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function setup() {
  let defaults = newBotDefaultsSchema.parse({ profile: { plugins: ["proof", "other"] } });
  const store = { removePluginReferences: vi.fn().mockReturnValue([{ id: "one" }, { id: "two" }]) };
  const inUse = vi.fn().mockReturnValue(false);
  const saveDefaults = vi.fn(value => { defaults = value; });
  const { uninstall } = createPluginService({ library, store, inUse, getDefaults: () => defaults, saveDefaults });
  return { uninstall, store, inUse, saveDefaults, defaults: () => defaults };
}

it("prunes defaults and bot references, including stale references on repeated removal", async () => {
  const fixture = setup();
  expect(await fixture.uninstall("proof")).toEqual({ id: "proof", status: "uninstalled", removed: true, affectedBotIds: ["one", "two"] });
  expect(fixture.defaults().profile.plugins).toEqual(["other"]);
  expect(existsSync(join(library.root, "proof"))).toBe(false);
  expect(await fixture.uninstall("proof")).toMatchObject({ removed: false });
  expect(fixture.store.removePluginReferences).toHaveBeenCalledTimes(2);
});

it("refuses active turns and expired capabilities without changing disk or selections", async () => {
  const fixture = setup();
  fixture.inUse.mockReturnValue(true);
  await expect(fixture.uninstall("proof")).rejects.toMatchObject({ status: 409 });
  fixture.inUse.mockReturnValue(false);
  await expect(fixture.uninstall("proof", () => { throw new Error("expired"); })).rejects.toThrow("expired");
  expect(existsSync(join(library.root, "proof", "package", "proof.txt"))).toBe(true);
  expect(fixture.defaults().profile.plugins).toEqual(["proof", "other"]);
  expect(fixture.store.removePluginReferences).not.toHaveBeenCalled();
});

it("rolls defaults and package back if bot persistence fails", async () => {
  const fixture = setup();
  fixture.store.removePluginReferences.mockImplementationOnce(() => { throw new Error("disk full"); });
  await expect(fixture.uninstall("proof")).rejects.toThrow("disk full");
  expect(fixture.defaults().profile.plugins).toEqual(["proof", "other"]);
  expect(existsSync(join(library.root, "proof", "package", "proof.txt"))).toBe(true);
  await expect(fixture.uninstall("proof")).resolves.toMatchObject({ removed: true });
});
