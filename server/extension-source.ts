import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pluginSourceSchema } from "../shared/plugins.ts";
import { extractResourceArchive, resourcePath } from "./resource-directory.ts";

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
  if (Number(response.headers.get("content-length") ?? 0) > max) extensionError("Resource exceeds the download budget", 413);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > max) { await response.body?.cancel().catch(() => {}); extensionError("Resource exceeds the download budget", 413); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function downloadResource(url: string, fetcher: typeof fetch = fetch, limit = EXTENSION_MAX_BYTES): Promise<Buffer> {
  let current = url;
  for (let redirects = 0; redirects < 6; redirects++) {
    if (!pluginSourceSchema.safeParse(current).success) extensionError("Use an HTTP or HTTPS resource URL without embedded credentials");
    const response = await fetcher(current, { redirect: "manual", signal: AbortSignal.timeout(60_000), headers: { "user-agent": "OpenMausBot-extension-import" } });
    if (response.status >= 300 && response.status < 400 && response.headers.has("location")) {
      await response.body?.cancel();
      const next = new URL(response.headers.get("location")!, current);
      if (current.startsWith("https:") && next.protocol !== "https:") extensionError("HTTPS resources cannot redirect to HTTP");
      current = next.href;
      continue;
    }
    if (!response.ok) extensionError(`Resource download failed (HTTP ${response.status})`, response.status === 404 ? 404 : 502);
    return responseBytes(response, limit);
  }
  return extensionError("Too many resource redirects");
}

interface GitEntry { path: string; type: "blob" | "tree" | "commit"; mode: string; sha: string; size?: number }
interface GitTree { tree: GitEntry[]; truncated?: boolean }

export async function downloadGithubDirectory(source: ExtensionSource, target: string, fetcher: typeof fetch = fetch): Promise<void> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(source.repository)) extensionError("Invalid GitHub repository");
  resourcePath(target, source.path || ".");
  const api = `https://api.github.com/repos/${source.repository}`;
  const getJson = async (url: string) => JSON.parse((await downloadResource(url, fetcher, 8 * 1024 * 1024)).toString("utf8"));
  let ref = source.ref ?? (await getJson(api)).default_branch;
  let directoryPath = source.path;
  if (typeof ref !== "string" || !ref) extensionError("GitHub did not provide a default branch");
  const readTree = async (sha: string, recursive = false): Promise<GitTree> => {
    const tree = await getJson(`${api}/git/trees/${encodeURIComponent(sha)}${recursive ? "?recursive=1" : ""}`);
    if (!Array.isArray(tree.tree)) extensionError("GitHub returned an invalid directory");
    return tree;
  };
  let root: GitTree;
  try { root = await readTree(ref); } catch (error) {
    if ((error as {status?:number}).status !== 404 || !directoryPath) throw error;
    const parts = directoryPath.split("/");
    for (;;) {
      const next = parts.shift();
      if (!next) throw error;
      ref += `/${next}`;
      try { root = await readTree(ref); directoryPath = parts.join("/"); break; }
      catch (candidateError) { if ((candidateError as {status?:number}).status !== 404) throw candidateError; }
    }
  }
  for (const part of directoryPath.split("/").filter(Boolean)) {
    const entry = root.tree.find(item => item.path === part && item.type === "tree");
    if (!entry) extensionError(`GitHub resource directory was not found: ${source.path}`, 404);
    root = await readTree(entry.sha);
  }
  const entries: GitEntry[] = [];
  const walk = async (tree: GitTree, prefix: string): Promise<void> => {
    for (const entry of tree.tree) {
      const path = prefix ? `${prefix}/${entry.path}` : entry.path;
      resourcePath(target, path);
      if (entry.type === "tree") await walk(await readTree(entry.sha), path);
      else {
        if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) extensionError(`Resource contains a link, submodule or special file: ${path}`);
        entries.push({ ...entry, path });
        if (entries.length > EXTENSION_MAX_FILES) extensionError("Resource exceeds the file-count limit", 413);
      }
    }
  };
  await walk(root, "");
  if (!entries.length) extensionError("The resource directory is empty");
  mkdirSync(target, { recursive: true });
  let total = 0;
  for (let offset = 0; offset < entries.length; offset += 6) {
    const results = await Promise.allSettled(entries.slice(offset, offset + 6).map(async entry => {
      const path = [directoryPath, entry.path].filter(Boolean).join("/");
      const url = `https://raw.githubusercontent.com/${source.repository}/${encodeURIComponent(ref)}/${path.split("/").map(encodeURIComponent).join("/")}`;
      const bytes = await downloadResource(url, fetcher);
      total += bytes.length;
      if (total > EXTENSION_MAX_BYTES) extensionError("Resource exceeds the directory-size limit", 413);
      const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
      if (blob !== entry.sha) extensionError("The source changed during download. Prepare it again.", 409);
      const file = resourcePath(target, entry.path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes);
      chmodSync(file, entry.mode === "100755" ? 0o755 : 0o644);
    }));
    const failed = results.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
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

export async function fetchExtensionSource(source: string | ExtensionSource, target: string, fetcher: typeof fetch = fetch): Promise<string> {
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
