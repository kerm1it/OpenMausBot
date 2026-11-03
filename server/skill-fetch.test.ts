import { zipSync, type Zippable } from "fflate";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { fetchSkillFromSource, parseSkillSource } from "./skill-fetch.ts";
import { skillFileBytes } from "./skill-files.ts";

type FixtureFile = { content: string | Buffer; executable?: boolean; mode?: string };
function repository(files: Record<string, FixtureFile>) {
  const treeSha = (path: string) => createHash("sha1").update(path || "root").digest("hex");
  const blobSha = (file: FixtureFile) => { const bytes = Buffer.from(file.content); return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"); };
  const folders = new Set([""]);
  for (const path of Object.keys(files)) {
    const parts = path.split("/"); parts.pop();
    while (parts.length) { folders.add(parts.join("/")); parts.pop(); }
  }
  const listing = (folder: string) => {
    const prefix = folder ? `${folder}/` : "";
    const entries: Array<Record<string, unknown>> = [];
    for (const child of folders) if (child.startsWith(prefix) && child !== folder && !child.slice(prefix.length).includes("/")) {
      entries.push({ path: child, name: child.slice(prefix.length), type: "dir", sha: treeSha(child) });
    }
    for (const [path, file] of Object.entries(files)) if (path.startsWith(prefix) && !path.slice(prefix.length).includes("/")) {
      entries.push({ path, name: path.slice(prefix.length), type: "file", sha: blobSha(file), mode: file.mode ?? (file.executable ? "100755" : "100644"), download_url: `https://raw.githubusercontent.com/a/b/main/${path}` });
    }
    return entries;
  };
  let active = 0, peak = 0;
  const fetcher = vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input));
    if (url.hostname === "api.github.com") {
      if (url.pathname === "/repos/a/b") return Response.json({ default_branch: "main" });
      if (url.pathname.startsWith("/repos/a/b/contents/")) return Response.json(listing(decodeURIComponent(url.pathname.slice("/repos/a/b/contents/".length))));
      if (url.pathname.startsWith("/repos/a/b/git/trees/")) {
        const sha = decodeURIComponent(url.pathname.slice("/repos/a/b/git/trees/".length));
        const folder = sha === "main" ? "" : [...folders].find(path => treeSha(path) === sha);
        if (folder === undefined) return new Response("missing", { status: 404 });
        return Response.json({ tree: listing(folder).map(entry => ({ ...entry, path: entry.name, type: entry.type === "dir" ? "tree" : "blob", mode: entry.type === "dir" ? "040000" : entry.mode })) });
      }
    }
    if (url.hostname === "codeload.github.com") {
      const entries: Zippable = {};
      for (const [path, file] of Object.entries(files)) entries[`repo-main/${path}`] = [Buffer.from(file.content), { os: 3, attrs: parseInt(file.mode ?? (file.executable ? "100755" : "100644"), 8) << 16 }];
      return new Response(zipSync(entries));
    }
    if (url.hostname === "raw.githubusercontent.com") {
      const file = files[decodeURIComponent(url.pathname.slice("/a/b/main/".length))];
      if (!file) return new Response("missing", { status: 404 });
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, 1));
      active--;
      return new Response(Buffer.from(file.content));
    }
    throw new Error(`Unexpected fixture URL: ${url}`);
  }) as typeof fetch;
  return { fetcher, peak: () => peak };
}
const text = (name: string) => `---\nname: ${name}\ndescription: Fixture skill.\n---\n\nRead references/help.txt.\n`;

describe("complete GitHub Skill downloads", () => {
  it.each([
    "https://github.com/a/b/tree/main/skills/complete",
    "https://github.com/a/b/blob/main/skills/complete/SKILL.md",
    "https://raw.githubusercontent.com/a/b/main/skills/complete/SKILL.md",
  ])("downloads the target's entire subtree from %s", async source => {
    const binary = Buffer.from([0, 255, 128]);
    const fixture = repository({
      "skills/complete/SKILL.md": { content: text("complete") },
      "skills/complete/scripts/run.sh": { content: "#!/bin/sh\nprintf fixture\n", executable: true },
      "skills/complete/assets/logo.png": { content: binary },
      "skills/complete/assets/empty": { content: "" },
      "skills/other/SKILL.md": { content: text("other") },
    });
    const result = await fetchSkillFromSource(source, fixture.fetcher);
    if ("error" in result) throw new Error(result.error);
    expect(result.skills).toHaveLength(1);
    const files = result.skills[0].files;
    expect(files.map(file => file.path).sort()).toEqual(["SKILL.md", "assets/empty", "assets/logo.png", "scripts/run.sh"]);
    expect(skillFileBytes(files.find(file => file.path === "assets/logo.png")!)).toEqual(binary);
    expect(files.find(file => file.path === "scripts/run.sh")?.executable).toBe(true);
    expect(files.find(file => file.path === "assets/empty")?.content).toBe("");
    expect(vi.mocked(fixture.fetcher).mock.calls.some(([input]) => String(input).includes("raw.githubusercontent.com/a/b/main/skills/other/"))).toBe(false);
  });

  it("imports 30 complete skills with bounded concurrency and a shared request budget", async () => {
    const fixture = repository(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [
      [`skills/skill-${i}/SKILL.md`, { content: text(`skill-${i}`) }],
      [`skills/skill-${i}/references/help.txt`, { content: "Reference" }],
    ]).flat()));
    const result = await fetchSkillFromSource("a/b", fixture.fetcher);
    expect("skills" in result && result.skills).toHaveLength(30);
    expect(fixture.peak()).toBeLessThanOrEqual(6);
    expect(vi.mocked(fixture.fetcher).mock.calls.length).toBeLessThanOrEqual(512);
    expect(vi.mocked(fixture.fetcher).mock.calls.filter(([input]) => String(input).includes("codeload.github.com"))).toHaveLength(1);
  });

  it("discovers a skills.sh named skill by frontmatter and keeps its complete directory", async () => {
    const fixture = repository({ "skills/unrelated/SKILL.md": { content: text("unrelated") },
      "skills/folder-name/SKILL.md": { content: text("Human_Name") }, "skills/folder-name/data.txt": { content: "attachment" } });
    const result = await fetchSkillFromSource("https://skills.sh/a/b/human-name", fixture.fetcher);
    if ("error" in result) throw new Error(result.error);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].files.map(file => file.path)).toEqual(["SKILL.md", "data.txt"]);
  });

  it("rejects symlinks instead of copying their target into the Skill", async () => {
    const fixture = repository({ "SKILL.md": { content: text("linked") }, "data": { content: "/etc/passwd", mode: "120000" } });
    expect(await fetchSkillFromSource("https://github.com/a/b/tree/main", fixture.fetcher)).toEqual({ error: expect.stringContaining("cannot contain links or special files") });
  });
});

describe("Skill fetch boundaries", () => {
  it("caps the entire discovery walk", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const path = String(input).split("/contents/")[1] ?? "";
      return Response.json(Array.from({ length: 60 }, (_, i) => ({ type: "dir", name: `folder-${i}`, path: `${path ? `${path}/` : ""}folder-${i}` })));
    }) as typeof fetch;
    expect(await fetchSkillFromSource("a/b", fetcher)).toEqual({ error: expect.stringContaining("request limit") });
    expect(fetcher).toHaveBeenCalledTimes(512);
  });

  it("cancels an oversized API response while streaming", async () => {
    const cancelled = vi.fn();
    const fetcher = vi.fn(async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(128 * 1024)); }, cancel: cancelled,
    }))) as typeof fetch;
    expect(await fetchSkillFromSource("https://raw.githubusercontent.com/a/b/main/SKILL.md", fetcher)).toEqual({ error: expect.stringContaining("size limit") });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it.each(["http://raw.githubusercontent.com/a/b/main/SKILL.md", "https://raw.githubusercontent.com:8443/a/b/main/SKILL.md", "https://user:pass@raw.githubusercontent.com/a/b/main/SKILL.md", "https://evil.example.com/a/b/main/SKILL.md"])("refuses an untrusted source %s without fetching", async source => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    expect(await fetchSkillFromSource(source, fetcher)).toHaveProperty("error");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses a redirected GitHub download that leaves the pinned hosts", async () => {
    const fixture = repository({ "SKILL.md": { content: text("redirect") } });
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => String(input).includes("codeload.github.com")
      ? new Response(null, { status: 302, headers: { location: "https://evil.example.com/skill" } }) : fixture.fetcher(input, init)) as typeof fetch;
    expect(await fetchSkillFromSource("https://raw.githubusercontent.com/a/b/main/SKILL.md", fetcher)).toEqual({ error: expect.stringContaining("must stay") });
    expect(vi.mocked(fetcher).mock.calls.some(([input]) => String(input).includes("evil.example.com"))).toBe(false);
  });

  it.each(["https://skills.sh/a/b/...", "https://skills.sh/a/b/---", "https://skills.sh/../b/skill", "https://github.com/a/b/blob/main/README-SKILL.md"])("refuses an invalid Skill source %s", source => {
    expect(parseSkillSource(source)).toHaveProperty("error");
  });
});
