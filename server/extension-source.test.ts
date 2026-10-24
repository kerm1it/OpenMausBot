import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadGithubDirectory, githubSource } from "./extension-source.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots) rmSync(root, {recursive: true, force: true}); });
const blob = (path: string, bytes: Uint8Array, executable = false) => ({ path, type: "blob", mode: executable ? "100755" : "100644", sha: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") });

describe("extension source directories", () => {
  it("downloads only the selected subtree and preserves binary files and scripts", async () => {
    const root = mkdtempSync(join(tmpdir(), "omb-extension-source-")); roots.push(root);
    const binary = Buffer.from([0, 255, 1]), script = Buffer.from("#!/bin/sh\necho proof\n");
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/git/trees/main")) return Response.json({ tree: [{ path: "selected", type: "tree", sha: "selected" }, { path: "huge-other-plugin", type: "tree", sha: "unrelated" }] });
      if (url.endsWith("/git/trees/selected")) return Response.json({ tree: [blob("asset.bin", binary), blob("run.sh", script, true)] });
      if (url.endsWith("/selected/asset.bin")) return new Response(binary);
      if (url.endsWith("/selected/run.sh")) return new Response(script);
      throw new Error(`Unexpected request: ${url}`);
    });
    await downloadGithubDirectory({ repository: "fixture/plugins", ref: "main", path: "selected" }, root, fetcher);
    expect(readFileSync(join(root, "asset.bin"))).toEqual(binary);
    expect(readFileSync(join(root, "run.sh"))).toEqual(script);
    expect(statSync(join(root, "run.sh")).mode & 0o111).not.toBe(0);
    expect(fetcher.mock.calls.every(([url]) => !String(url).includes("unrelated") && !String(url).includes("codeload"))).toBe(true);
  });
  it("rejects source content changed between its directory listing and download", async () => {
    const root = mkdtempSync(join(tmpdir(), "omb-extension-source-")); roots.push(root);
    const fetcher = vi.fn(async (input: string | URL | Request) => String(input).includes("/git/trees/") ? Response.json({tree: [blob("file", Buffer.from("before"))]}) : new Response("after"));
    await expect(downloadGithubDirectory({repository: "fixture/plugins", ref: "main", path: ""}, root, fetcher)).rejects.toThrow("source changed");
  });
  it("resolves raw GitHub entry points to their complete parent directory", () => {
    expect(githubSource("https://raw.githubusercontent.com/org/repo/main/skills/proof/SKILL.md")).toEqual({repository: "org/repo", ref: "main", path: "skills/proof"});
  });
});
