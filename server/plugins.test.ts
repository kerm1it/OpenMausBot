import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginSourceServer } from "./testing/plugin-source.ts";
import { PluginLibrary } from "./plugins.ts";

describe("shared native plugin library", () => {
  let root: string;
  let library: PluginLibrary;
  let sources: Awaited<ReturnType<typeof createPluginSourceServer>>;
  const installSource = (path: string, beforeCommit?: () => void) => library.install(sources.urlFor(path), beforeCommit);
  const skill = "---\nname: proof\ndescription: A proof skill\n---\nReturn OMB_PLUGIN_PROOF.\n";
  beforeEach(async () => { sources = await createPluginSourceServer(); root = mkdtempSync(join(tmpdir(), "omb-plugins-")); library = new PluginLibrary(join(root, "library")); });
  afterEach(async () => { vi.unstubAllGlobals(); await sources.close(); rmSync(root, { recursive: true, force: true }); });
  function source(name = "proof", manifest: object = { name, version: "1.0.0", skills: "./skills/", agents: "./agents/" }) {
    const dir = join(root, `source-${name}`);
    mkdirSync(join(dir, ".cursor-plugin"), { recursive: true });
    mkdirSync(join(dir, "skills", "proof"), { recursive: true });
    mkdirSync(join(dir, "agents"));
    writeFileSync(join(dir, ".cursor-plugin", "plugin.json"), JSON.stringify(manifest));
    writeFileSync(join(dir, "skills", "proof", "SKILL.md"), skill);
    writeFileSync(join(dir, "agents", "proof.md"), "---\nname: proof\ndescription: Proof\nis_background: true\n---\nKeep this exact content.\n");
    return dir;
  }
  it.each(["/tmp/plugin", "./plugin", "~/plugin", "C:\\plugins\\proof", "file:///tmp/plugin", "ftp://example.test/plugin.zip", "https://user:secret@example.test/plugin.zip", "https://", ""]) ("rejects non-HTTP sources before touching the library: %s", async value => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(library.install(value)).rejects.toThrow("HTTP or HTTPS");
    expect(fetcher).not.toHaveBeenCalled();
    expect(readdirSync(root)).toEqual([]);
  });
  it("preserves components and supplied manifests, generates host entries, and resolves references", async () => {
    const dir = source();
    const original = readFileSync(join(dir, ".cursor-plugin/plugin.json"), "utf8");
    const plugin = await installSource(dir);
    expect(plugin).toMatchObject({ id: "proof", version: "1.0.0", status: "installed" });
    for (const manifest of ["plugin.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]) expect(JSON.parse(readFileSync(join(plugin.path, manifest), "utf8")).name).toBe("proof");
    expect(readFileSync(join(plugin.path, ".cursor-plugin/plugin.json"), "utf8")).toBe(original);
    expect(readFileSync(join(plugin.path, "skills/proof/SKILL.md"), "utf8")).toBe(skill);
    expect(readFileSync(join(plugin.path, "agents/proof.md"), "utf8")).toBe(readFileSync(join(dir, "agents/proof.md"), "utf8"));
    expect(JSON.parse(readFileSync(join(plugin.path, ".claude-plugin/plugin.json"), "utf8"))).not.toHaveProperty("agents");
    expect(library.selection(["proof", "proof"])).toEqual(["proof"]);
    expect(library.resolve([])).toEqual([]);
    expect(library.resolve([], "grok")).toEqual([]);
    expect(() => library.resolve(["proof"], "grok")).toThrow("require a Claude Code");
    expect(library.resolve(["proof"])[0]?.path).toBe(plugin.path);
    expect(() => library.selection(["missing"])).toThrow("not installed");
    expect(() => library.selection("proof")).toThrow("array");
    expect(() => library.selection(["../proof"])).toThrow("array");
    expect(readdirSync(library.root)).toEqual(["proof"]);
  });
  it("combines component declarations from supplied manifests when generating missing entries", async () => {
    const dir = source("custom", { name: "custom", version: "1.0.0" });
    mkdirSync(join(dir, ".claude-plugin"));
    mkdirSync(join(dir, "custom-skills", "proof"), { recursive: true });
    writeFileSync(join(dir, "custom-skills", "proof", "SKILL.md"), skill);
    const claude = JSON.stringify({ name: "custom", version: "1.0.0", skills: "./custom-skills/" });
    writeFileSync(join(dir, ".claude-plugin/plugin.json"), claude);
    const plugin = await installSource(dir);
    expect(readFileSync(join(plugin.path, ".claude-plugin/plugin.json"), "utf8")).toBe(claude);
    expect(JSON.parse(readFileSync(join(plugin.path, ".codex-plugin/plugin.json"), "utf8")).skills).toBe("./custom-skills/");
    expect(JSON.parse(readFileSync(join(plugin.path, "plugin.json"), "utf8")).name).toBe("custom");
  });
  it("preserves complete native manifests with different host component paths", async () => {
    const dir = source("native", { name: "native", version: "1.0.0", skills: "./cursor-skills/" });
    const supplied = new Map<string, string>();
    for (const host of ["cursor", "claude", "codex"]) {
      mkdirSync(join(dir, `${host}-skills`, "proof"), { recursive: true });
      writeFileSync(join(dir, `${host}-skills`, "proof", "SKILL.md"), skill);
      mkdirSync(join(dir, `.${host}-plugin`), { recursive: true });
      const manifest = JSON.stringify({ name: "native", version: "1.0.0", skills: `./${host}-skills/` });
      const path = `.${host}-plugin/plugin.json`;
      writeFileSync(join(dir, path), manifest); supplied.set(path, manifest);
    }
    const plugin = await installSource(dir);
    for (const [path, manifest] of supplied) expect(readFileSync(join(plugin.path, path), "utf8")).toBe(manifest);
    expect(JSON.parse(readFileSync(join(plugin.path, "plugin.json"), "utf8")).name).toBe("native");
  });
  it("does not damage the installed version after an invalid update", async () => {
    const dir = source();
    const installed = await installSource(dir);
    writeFileSync(join(dir, ".cursor-plugin/plugin.json"), "{");
    await expect(installSource(dir)).rejects.toThrow("Invalid JSON");
    expect(library.list()).toEqual([expect.objectContaining({ id: "proof", installedAt: installed.installedAt })]);
    expect(readdirSync(library.root)).toEqual(["proof"]);
  });
  it("rejects links, missing references, and paths escaping manifests", async () => {
    const dir = source("escape", { name: "escape", version: "1.0.0", skills: "../outside" });
    await expect(installSource(dir)).rejects.toThrow("escapes");
    const missing = source("missing", { name: "missing", skills: "./absent" });
    await expect(installSource(missing)).rejects.toThrow("missing path");
    const linked = source("linked");
    symlinkSync(join(root, "outside"), join(linked, "escape"));
    await expect(installSource(linked)).rejects.toThrow("links");
    expect(library.list()).toEqual([]);
  });
  it("installs zip archives and refuses traversal entries", async () => {
    const archive = join(root, "plugin.zip");
    writeFileSync(archive, zipSync({ "wrapped/.claude-plugin/plugin.json": strToU8(JSON.stringify({ name: "archive", version: "1.2.3" })), "wrapped/skills/proof/SKILL.md": strToU8(skill) }));
    expect(await installSource(archive)).toMatchObject({ id: "archive", version: "1.2.3" });
    writeFileSync(archive, zipSync({ "../escape": strToU8("bad") }));
    await expect(installSource(archive)).rejects.toThrow("escapes");
    expect(library.list()).toHaveLength(1);
  });
  it("fetches HTTPS archives and GitHub subdirectories without following insecure redirects", async () => {
    const bytes = zipSync({ "repo-main/pstack/.cursor-plugin/plugin.json": strToU8(JSON.stringify({ name: "pstack", version: "1.0.0" })), "repo-main/pstack/skills/proof/SKILL.md": strToU8(skill) });
    const fetcher = vi.fn().mockImplementation(async () => new Response(bytes));
    vi.stubGlobal("fetch", fetcher);
    expect(await library.install("https://github.com/cursor/plugins/tree/main/pstack")).toMatchObject({ id: "pstack" });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://codeload.github.com/cursor/plugins/tar.gz/main");
    fetcher.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "http://example.test/plugin.zip" } }));
    await expect(library.install("https://example.test/plugin.zip")).rejects.toThrow("HTTPS");
    fetcher.mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(library.install("https://example.test/missing.zip")).rejects.toThrow("404");
    expect(await library.install("http://example.test/plugin.zip")).toMatchObject({ id: "pstack" });
    expect(readdirSync(library.root)).toEqual(["pstack"]);
  });
  it("serializes installations and publishes complete replacements", async () => {
    const first = source("one"); const second = source("two");
    const results = await Promise.all([installSource(first), installSource(second)]);
    expect(results.map(value => value.id)).toEqual(["one", "two"]);
    expect(library.list().map(value => value.id)).toEqual(["one", "two"]);
    const before = library.resolve(["one"]);
    writeFileSync(join(first, ".cursor-plugin/plugin.json"), JSON.stringify({ name: "one", version: "2.0.0" }));
    await installSource(first);
    expect(library.resolve(["one"])).not.toEqual(before);
    expect(library.list()).toHaveLength(2);
  });
  it("serializes removal with installation, restores a refused removal, and permits reinstall", async () => {
    const dir = source();
    const [installed, removed] = await Promise.all([installSource(dir), library.uninstall("proof")]);
    expect(removed).toEqual({ id: "proof", status: "uninstalled", removed: true });
    expect(library.list()).toEqual([]);
    expect(readdirSync(library.root)).toEqual([]);
    expect(await library.uninstall("proof")).toMatchObject({ removed: false });
    await installSource(dir);
    const before = readFileSync(join(installed.path, "skills/proof/SKILL.md"), "utf8");
    await expect(library.uninstall("proof", () => { throw new Error("turn expired"); })).rejects.toThrow("turn expired");
    expect(library.list()).toHaveLength(1);
    expect(readFileSync(join(installed.path, "skills/proof/SKILL.md"), "utf8")).toBe(before);
    for (const id of ["../proof", "", "/tmp/proof"]) await expect(library.uninstall(id)).rejects.toThrow("plugin_id");
    expect(readdirSync(library.root)).toEqual(["proof"]);
  });
  it("cancels publication when the requesting turn expires and cleans up a failed download", async () => {
    await expect(installSource(source(), () => { throw new Error("turn expired"); })).rejects.toThrow("turn expired");
    expect(library.list()).toEqual([]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({ start(controller) { controller.error(new Error("connection lost")); } }))));
    await expect(library.install("https://example.test/interrupted.zip")).rejects.toThrow("connection lost");
    expect(readdirSync(library.root)).toEqual([]);
  });
  it("preserves ZIP scripts and Unix executable bits, and rejects ZIP links", async () => {
    const archive = join(root, "executable.zip");
    const manifest = strToU8(JSON.stringify({ name: "executable", version: "1.0.0" }));
    writeFileSync(archive, zipSync({ ".claude-plugin/plugin.json": manifest, "scripts/proof.sh": [strToU8("#!/bin/sh\nexit 0\n"), { os: 3, attrs: 0o100755 << 16 }] }));
    const plugin = await installSource(archive);
    expect(readFileSync(join(plugin.path, "scripts/proof.sh"), "utf8")).toBe("#!/bin/sh\nexit 0\n");
    if (process.platform !== "win32") expect(statSync(join(plugin.path, "scripts/proof.sh")).mode & 0o111).toBe(0o111);
    writeFileSync(archive, zipSync({ ".claude-plugin/plugin.json": manifest, "link": [strToU8("/outside"), { os: 3, attrs: 0o120777 << 16 }] }));
    await expect(installSource(archive)).rejects.toThrow("links");
    expect(library.list()).toHaveLength(1);
  });
});
