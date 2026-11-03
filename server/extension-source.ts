import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pluginSourceSchema } from "../shared/plugins.ts";
import { extractResourceArchive, resourcePath } from "./resource-directory.ts";
import { RESOURCE_REQUEST_TIMEOUT_MS } from "./extension-fetch.ts";
import { githubArchiveFetch } from "./github-archive-fetch.ts";

export const EXTENSION_MAX_BYTES = 64 * 1024 * 1024;
export const EXTENSION_MAX_FILES = 10_000;
export const MARKET_REPOSITORY = "kerm1it/grok-bot-exts";
export const MARKET_REF = "main";

export interface ExtensionSource {
  repository: string;
  ref?: string;
  path: string;
}

export interface ResourceFile {
  path: string;
  size: number;
  executable: boolean;
  sha256: string;
}

export function extensionError(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}

export function githubSource(value: string): ExtensionSource | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (url.hostname === "raw.githubusercontent.com") {
    const [owner, repo, ref, ...path] = parts;
    if (!owner || !repo || !ref || !path.length) return null;
    return { repository: `${owner}/${repo}`, ref, path: path.slice(0, -1).join("/") };
  }
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return null;
  const [owner, rawRepo, kind, ref, ...path] = parts;
  if (!owner || !rawRepo) return null;
  const repository = `${owner}/${rawRepo.replace(/\.git$/, "")}`;
  if (!kind) return { repository, path: "" };
  if ((kind !== "tree" && kind !== "blob") || !ref) return null;
  return { repository, ref, path: (kind === "blob" ? path.slice(0, -1) : path).join("/") };
}

export function marketSource(source: "openmausbot" | "grok-bot", type: "bot" | "plugin", id: string): ExtensionSource {
  const valid = source === "openmausbot" ? /^[a-z0-9]+(?:-[a-z0-9]+)*$/ : type === "bot" ? /^[A-Za-z0-9_-]{21}$/ : /^\d{1,19}$/;
  if (!valid.test(id)) extensionError("Invalid marketplace resource ID");
  return { repository: MARKET_REPOSITORY, ref: MARKET_REF, path: `extensions/${source}/${type}s/${id}` };
}

export async function responseBytes(response: Response, max: number): Promise<Buffer> {
  if (Number(response.headers.get("content-length") ?? 0) > max) { await response.body?.cancel(); extensionError("Resource exceeds the download budget", 413); }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > max) { await response.body?.cancel().catch(() => {}); extensionError("Resource exceeds the download budget", 413); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function downloadResource(url: string, fetcher: typeof fetch = githubArchiveFetch, limit = EXTENSION_MAX_BYTES, timeoutMs = RESOURCE_REQUEST_TIMEOUT_MS): Promise<Buffer> {
  for (let attempt = 0; ; attempt++) {
    try { return await downloadResourceOnce(url, fetcher, limit, timeoutMs); }
    catch (error) {
      const retryable = error instanceof TypeError || (error as Error).name === "TimeoutError" || [502, 503, 504].includes((error as {status?:number}).status ?? 0);
      if (attempt > 0 || !retryable) throw error;
    }
  }
}

async function downloadResourceOnce(url: string, fetcher: typeof fetch, limit: number, timeoutMs: number): Promise<Buffer> {
  let current = url;
  const signal = AbortSignal.timeout(timeoutMs);
  for (let redirects = 0; redirects < 6; redirects++) {
    if (!pluginSourceSchema.safeParse(current).success) extensionError("Use an HTTP or HTTPS resource URL without embedded credentials");
    const response = await fetcher(current, { redirect: "manual", signal, headers: { "user-agent": "OpenMausBot-extension-import" } });
    if (response.status >= 300 && response.status < 400 && response.headers.has("location")) {
      await response.body?.cancel();
      const next = new URL(response.headers.get("location")!, current);
      if (current.startsWith("https:") && next.protocol !== "https:") extensionError("HTTPS resources cannot redirect to HTTP");
      current = next.href;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      extensionError(`Resource download failed (HTTP ${response.status})`, response.status);
    }
    return await responseBytes(response, limit);
  }
  return extensionError("Too many resource redirects");
}

export async function downloadGithubDirectory(source: ExtensionSource, target: string, fetcher: typeof fetch = githubArchiveFetch): Promise<void> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(source.repository)) extensionError("Invalid GitHub repository");
  resourcePath(target, source.path || ".");
  let ref = source.ref ?? "HEAD";
  let directoryPath = source.path.replace(/\/$/, "");
  const remaining = directoryPath.split("/").filter(Boolean);
  for (;;) {
    let bytes: Buffer;
    try {
      const url = `https://codeload.github.com/${source.repository}/zip/${encodeURIComponent(ref)}`;
      bytes = await downloadResource(url, fetcher, EXTENSION_MAX_BYTES, 120_000);
    } catch (error) {
      if ((error as {status?:number}).status !== 404 || !source.ref || !remaining.length) throw error;
      ref += `/${remaining.shift()}`;
      directoryPath = remaining.join("/");
      continue;
    }
    try { await extractResourceArchive(bytes, target, `${target}.tar`, directoryPath); return; }
    finally { rmSync(`${target}.tar`, { force: true }); }
  }
}

export function resourceFiles(root: string): ResourceFile[] {
  const out: ResourceFile[] = [];
  let size = 0;
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = prefix ? `${prefix}/${name}` : name;
      const file = resourcePath(root, path), stat = lstatSync(file);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) extensionError(`Resource contains a link or special file: ${path}`);
      if (stat.isDirectory()) walk(file, path);
      else {
        size += stat.size;
        if (size > EXTENSION_MAX_BYTES || out.length >= EXTENSION_MAX_FILES) extensionError("Resource exceeds directory limits", 413);
        out.push({ path, size: stat.size, executable: Boolean(stat.mode & 0o111), sha256: createHash("sha256").update(readFileSync(file)).digest("hex") });
      }
    }
  };
  walk(root, "");
  return out;
}

export function resourceDigest(root: string): string {
  return createHash("sha256").update(JSON.stringify(resourceFiles(root))).digest("hex");
}

export function extensionRoot(root: string): string {
  if (["extension.json", "recipe.json", "template.json", "plugin.json", ".cursor-plugin/plugin.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json"].some(name => existsSync(join(root, name)))) return root;
  const names = readdirSync(root).filter(name => name !== "__MACOSX");
  if (names.length === 1 && lstatSync(join(root, names[0]!)).isDirectory()) return extensionRoot(join(root, names[0]!));
  return extensionError("No extension manifest, recipe or native plugin found at the resource root");
}

export async function fetchExtensionSource(source: string | ExtensionSource, target: string, fetcher: typeof fetch = githubArchiveFetch): Promise<string> {
  const github = typeof source === "string" ? githubSource(source) : source;
  if (github) await downloadGithubDirectory(github, target, fetcher);
  else {
    const bytes = await downloadResource(source as string, fetcher);
    if (bytes.toString("utf8", 0, 1) === "{") {
      let value: Record<string, unknown>;
      try { value = JSON.parse(bytes.toString("utf8")); } catch { return extensionError("The resource contains invalid JSON"); }
      const file = value.gitUrl || value.releaseRepo || value.sourceDownload ? "plugin.json" : "recipe.json";
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, file), bytes);
    } else await extractResourceArchive(bytes, target, `${target}.tar`);
  }
  resourceFiles(target);
  return extensionRoot(target);
}

export { resourcePath };
