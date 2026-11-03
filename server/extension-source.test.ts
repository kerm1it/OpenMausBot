import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { downloadGithubDirectory, githubSource } from "./extension-source.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots) rmSync(root, {recursive: true, force: true}); });

describe("extension source directories", () => {
  it("downloads only the selected subtree and preserves binary files and scripts", async () => {
    const root = mkdtempSync(join(tmpdir(), "omb-extension-source-")); roots.push(root);
    const binary = Buffer.from([0, 255, 1]), script = Buffer.from("#!/bin/sh\necho proof\n");
    const archive = zipSync({ "repo-main/selected/asset.bin": binary,
      "repo-main/selected/run.sh": [script, {os: 3, attrs: 0o100755 << 16}],
      "repo-main/other/unused": strToU8("not selected") });
    const fetcher = vi.fn(async () => new Response(archive));
    await downloadGithubDirectory({ repository: "fixture/plugins", ref: "main", path: "selected" }, root, fetcher);
    expect(readFileSync(join(root, "asset.bin"))).toEqual(binary);
    expect(readFileSync(join(root, "run.sh"))).toEqual(script);
    expect(statSync(join(root, "run.sh")).mode & 0o111).not.toBe(0);
    expect(existsSync(join(root, "other"))).toBe(false);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("https://codeload.github.com/fixture/plugins/zip/main", expect.any(Object));
  });
  it("downloads the requested ref directly without GitHub API or default-branch discovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "omb-extension-ref-")); roots.push(root);
    const archive = zipSync({"repo-sha/file": strToU8("snapshot")});
    const fetcher = vi.fn(async () => new Response(archive));
    await downloadGithubDirectory({repository: "fixture/plugins", path: ""}, root, fetcher);
    expect(readFileSync(join(root, "file"), "utf8")).toBe("snapshot");
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("https://codeload.github.com/fixture/plugins/zip/HEAD", expect.any(Object));
  });
  it("resolves raw GitHub entry points to their complete parent directory", () => {
    expect(githubSource("https://raw.githubusercontent.com/org/repo/main/skills/proof/SKILL.md")).toEqual({repository: "org/repo", ref: "main", path: "skills/proof"});
  });
  it("reports a missing directory without downloading other branch candidates", async () => {
    const root = mkdtempSync(join(tmpdir(), "omb-extension-missing-")); roots.push(root);
    const fetcher = vi.fn(async () => new Response(zipSync({ "repo-main/other/data": strToU8("unrelated") })));
    await expect(downloadGithubDirectory({ repository: "fixture/plugins", ref: "main", path: "missing" }, root, fetcher)).rejects.toMatchObject({ status: 404 });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("resolves a slash-containing branch without GitHub API requests", async () => {
    const root = mkdtempSync(join(tmpdir(), "omb-extension-branch-")); roots.push(root);
    const fetcher = vi.fn<typeof fetch>(async input => String(input).endsWith("release%2Fnext")
      ? new Response(zipSync({ "repo-ref/selected/data": strToU8("branch contents") })) : new Response(null, { status: 404 }));
    await downloadGithubDirectory({ repository: "fixture/plugins", ref: "release", path: "next/selected" }, root, fetcher);
    expect(readFileSync(join(root, "data"), "utf8")).toBe("branch contents");
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual(["https://codeload.github.com/fixture/plugins/zip/release", "https://codeload.github.com/fixture/plugins/zip/release%2Fnext"]);
  });
  it("rejects links inside the selected directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "omb-extension-link-")); roots.push(root);
    const archive = zipSync({ "repo-main/selected/link": [strToU8("/etc/passwd"), { os: 3, attrs: 0o120777 << 16 }] });
    await expect(downloadGithubDirectory({ repository: "fixture/plugins", ref: "main", path: "selected" }, root, async () => new Response(archive))).rejects.toThrow("cannot contain links");
  });
});
