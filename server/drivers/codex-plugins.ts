import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { execCli } from "../procs.ts";
import { codexHome } from "./codex-identity.ts";
import type { InstalledPlugin, PluginLibrarySnapshot } from "../../shared/plugins.ts";
import { redactSecretsInText } from "../redact.ts";
import { writeFileAtomic, writeFileAtomicIfChanged } from "../atomic.ts";

const queues = new Map<string, Promise<unknown>>();

export type CodexPluginLaunch = { args: string[]; expected: Record<string, boolean> };

/** Install once in the provider's existing native home; selection is process-local. */
export async function prepareCodexPlugins(cli: string, env: NodeJS.ProcessEnv, selected: InstalledPlugin[], library?: PluginLibrarySnapshot): Promise<CodexPluginLaunch> {
  if (!library) {
    if (selected.length) throw new Error("Codex plugins require an application library snapshot.");
    return { args: [], expected: {} };
  }
  const installed = library.installed;
  const home = codexHome(env);
  if (!installed.length && (!home || !existsSync(join(home, "plugins", "omb-installed.json")))) return { args: [], expected: {} };
  if (!env.CODEX_HOME || !home) throw new Error("Codex plugins require an explicit absolute CODEX_HOME; the personal default must not be used.");
  const marketplace = library.root;
  const run = (args: string[]) => new Promise<void>((resolve, reject) => {
    execCli(cli, args, { env, timeout: 30_000 }, (error, _stdout, stderr) => {
      if (error) reject(new Error(`Codex native plugin installation failed: ${redactSecretsInText(String(stderr)).slice(0, 1000) || "Check the installed Codex version and plugin manifest."}`));
      else resolve();
    });
  });
  const work = (queues.get(home) ?? Promise.resolve()).catch(() => {}).then(async () => {
    mkdirSync(join(marketplace, ".agents", "plugins"), { recursive: true });
    const entries = installed.map(plugin => ({ name: plugin.id, source: { source: "local", path: `./${relative(marketplace, plugin.path).split("\\").join("/")}` },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" }));
    writeFileAtomicIfChanged(join(marketplace, ".agents", "plugins", "marketplace.json"), JSON.stringify({ name: "openmausbot", interface: { displayName: "OpenMausBot" }, plugins: entries }));
    const fingerprint = JSON.stringify(installed);
    const stamp = join(home, "plugins", "omb-installed.json");
    if (!existsSync(stamp) || readFileSync(stamp, "utf8") !== fingerprint) {
      const previous: InstalledPlugin[] = existsSync(stamp) ? JSON.parse(readFileSync(stamp, "utf8")) : [];
      for (const old of previous) if (!installed.some(plugin => plugin.id === old.id)) await run(["plugin", "remove", `${old.id}@openmausbot`]);
      const changed = installed.filter(plugin => JSON.stringify(previous.find(item => item.id === plugin.id)) !== JSON.stringify(plugin));
      if (changed.length) await run(["plugin", "marketplace", "add", marketplace]);
      for (const plugin of changed) {
        if (previous.some(item => item.id === plugin.id)) await run(["plugin", "remove", `${plugin.id}@openmausbot`]);
        await run(["plugin", "add", `${plugin.id}@openmausbot`]);
      }
      mkdirSync(join(home, "plugins"), { recursive: true });
      writeFileAtomic(stamp, fingerprint);
    }
  });
  queues.set(home, work);
  try { await work; } finally { if (queues.get(home) === work) queues.delete(home); }
  const selectedIds = new Set(selected.map(plugin => plugin.id));
  const expected = Object.fromEntries(installed.map(plugin => [`${plugin.id}@openmausbot`, selectedIds.has(plugin.id)]));
  // Native overrides belong to this invocation. Never rewrite shared enablement
  // between bot turns, copy credentials, or replace CODEX_HOME.
  return { args: Object.entries(expected).flatMap(([id, enabled]) => ["-c", `plugins.${id}.enabled=${enabled}`]), expected };
}

/** Check native plugin discovery, not config/read: older Codex ignores overrides here. */
export function assertCodexPluginSelection(result: unknown, expected: Record<string, boolean>): void {
  const marketplaces = (result as { marketplaces?: { name?: string; plugins?: { id?: string; installed?: boolean; enabled?: boolean }[] }[] } | null)?.marketplaces;
  const actual = new Map(Array.isArray(marketplaces) ? marketplaces.flatMap(market =>
    market.name === "openmausbot" && Array.isArray(market.plugins) ? market.plugins.map(plugin => [plugin.id, plugin] as const) : []) : []);
  for (const [id, plugin] of actual) {
    if (plugin.installed === true && plugin.enabled === true && (typeof id !== "string" || expected[id] !== true)) {
      throw new Error("Codex discovered an extra enabled OpenMausBot plugin in the shared CODEX_HOME. No prompt was sent; retry after plugin installation finishes.");
    }
  }
  for (const [id, enabled] of Object.entries(expected)) {
    const plugin = actual.get(id);
    if (plugin?.installed !== true || plugin.enabled !== enabled) {
      throw new Error("Codex could not apply this bot's native plugin selection with the shared CODEX_HOME. No prompt was sent. Use a Codex CLI that supports plugin configuration overrides (verified with 0.162.0-alpha.17.2; 0.146.1 ignores them).");
    }
  }
}
