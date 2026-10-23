import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { userHome } from "./env-path.ts";
import { DATA_DIR } from "./config.ts";
import { codexRuntimeHome } from "../electron/codex-home.mjs";

/** Never inherit a developer shell's or a saved engine's personal Codex home. */
export function codexRuntimeEnvironment<T extends NodeJS.ProcessEnv>(env: T): T & { CODEX_HOME: string; OMB_CODEX_AUTH_HOME: string } {
  const home = codexRuntimeHome(DATA_DIR);
  return { ...env, CODEX_HOME: home, OMB_CODEX_AUTH_HOME: process.env.OMB_CODEX_AUTH_HOME || process.env.CODEX_HOME || join(userHome(process.env), ".codex") };
}

export function initializeCodexRuntime(home = codexRuntimeHome(DATA_DIR)): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  for (const directory of [dirname(home), home]) {
    if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
    const inside = relative(realpathSync(DATA_DIR), realpathSync(directory));
    if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      throw new Error("OpenMausBot's Codex home must stay inside its data directory.");
    }
  }
}

/** Share just the native credential file, including external atomic replacements.
 * Codex 0.162.1 refresh/login writes through this link; config/cache stay local. */
export function linkExternalCodexAuth(home: string, sourceHome: string): void {
  if (!isAbsolute(sourceHome) || resolve(home) === resolve(sourceHome)) throw new Error("External Codex login must use a separate absolute credential directory.");
  let config = "";
  try { config = readFileSync(join(sourceHome, "config.toml"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Could not read the external Codex credential-store setting."); }
  // The native CLI writes this scalar at the document root. Never reuse a
  // stale auth.json when the external CLI has selected a different store.
  const store = /^\s*cli_auth_credentials_store\s*=\s*["']([^"']+)["']/m.exec(config.split(/^\s*\[/m, 1)[0]!)?.[1];
  if (store && store !== "file") throw new Error("External Codex uses a non-file credential store. Sharing its login through auth.json is unavailable; the application's private home will not fall back to personal config.");
  const target = join(home, "auth.json"), source = join(sourceHome, "auth.json");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  try { if (lstatSync(target).isSymbolicLink() && resolve(dirname(target), readlinkSync(target)) === source) return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const staged = join(home, `.auth-link-${randomUUID()}`);
  try { symlinkSync(source, staged, "file"); renameSync(staged, target); }
  catch { throw new Error("Could not link the external Codex login into the application's private home. Check filesystem symlink permissions."); }
  finally { try { unlinkSync(staged); } catch { /* renamed, or creation failed */ } }
}

export function configureCodexRuntime(env: NodeJS.ProcessEnv): void {
  const runtime = codexRuntimeEnvironment(env);
  initializeCodexRuntime(runtime.CODEX_HOME);
  env.CODEX_HOME = runtime.CODEX_HOME;
  env.OMB_CODEX_AUTH_HOME = runtime.OMB_CODEX_AUTH_HOME;
}
