import { nativeRpc } from "./testing/native-plugin-protocol.ts";
import { createPluginSourceServer } from "../server/testing/plugin-source.ts";
import { spawn, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const customManifests = process.argv.includes("--custom-manifests");
const originalHome = homedir();
const fixture = mkdtempSync(join(tmpdir(), "omb-native-plugins-"));
const evidenceDir = resolve(`.omb-scratch/verify-evidence/native-plugins${customManifests ? "-custom-manifests" : ""}`);
mkdirSync(evidenceDir, { recursive: true });
process.env.OMB_DATA_DIR = join(fixture, "data");
const { PluginLibrary } = await import("../server/plugins.ts");
const { assertCodexPluginSelection, prepareCodexPlugins } = await import("../server/drivers/codex-plugins.ts");
const { redactSecretsInText } = await import("../server/redact.ts");
const library = new PluginLibrary();
const evidence: unknown[] = [];
const find = (name: string) => execFileSync("/usr/bin/which", [name], { encoding: "utf8" }).trim();
const clis = { claude: find("claude"), cursor: find("cursor-agent"), codex: process.env.OMB_VERIFY_CODEX_CLI ?? find("codex") };
const baseEnv = (home: string): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, HOME: home, USERPROFILE: home,
  XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local/share"),
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:https?|all|no)_proxy$/i.test(key))),
  TMPDIR: fixture, LANG: process.env.LANG ?? "en_US.UTF-8", NO_OPEN_BROWSER: "1" });

async function run(label: string, cli: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, timeout = 60_000) {
  const child = spawn(cli, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "", timedOut = false;
  child.stdout.on("data", chunk => out += chunk);
  child.stderr.on("data", chunk => err += chunk);
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeout);
  const status = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  clearTimeout(timer);
  const item = { label, cli, args, cwd, status, timedOut, stdout: redactSecretsInText(out), stderr: redactSecretsInText(err) };
  evidence.push(item);
  writeFileSync(join(evidenceDir, `${label}.json`), JSON.stringify(item, null, 2));
  console.log(JSON.stringify({ label, status, timedOut, marker: out.includes("OMB_NATIVE_PLUGIN_381") }));
  return item;
}

async function rpcSkills(env: NodeJS.ProcessEnv, cwd: string, launch: Awaited<ReturnType<typeof prepareCodexPlugins>>, enabled: boolean) {
  const child = spawn(clis.codex, ["app-server", ...launch.args], { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
  const client = nativeRpc(child);
  const call = client.call;
  try {
    await call("initialize", { clientInfo: { name: "omb_plugin_verification", version: "1.0.0" }, capabilities: { experimentalApi: true } });
    client.notify("initialized");
    const installed = await call("plugin/installed", { cwds: [cwd] });
    assertCodexPluginSelection(installed, launch.expected);
    const result = await call("skills/list", { cwds: [cwd], forceReload: true });
    const skills = result.data?.flatMap((entry: any) => entry.skills ?? []).filter((skill: any) => /^(?:omb-proof|pstack):/.test(skill.name));
    const receipt = { label: enabled ? "codex-discovery-enabled" : "codex-discovery-disabled", skills };
    evidence.push(receipt);
    console.log(JSON.stringify({ label: receipt.label, skills: skills?.map((skill: any) => skill.name) }));
    return receipt;
  } finally { await client.close(); }
}

const sources = await createPluginSourceServer();
try {
  const source = join(fixture, "source");
  mkdirSync(join(source, ".cursor-plugin"), { recursive: true });
  const skillsDirectory = customManifests ? "recipes" : "skills";
  if (customManifests) writeFileSync(join(source, "plugin.json"), JSON.stringify({ name: "omb-proof", version: "1.0.0" }));
  mkdirSync(join(source, skillsDirectory, "proof"), { recursive: true });
  writeFileSync(join(source, ".cursor-plugin/plugin.json"), JSON.stringify({ name: "omb-proof", version: "1.0.0", skills: `./${skillsDirectory}/` }));
  writeFileSync(join(source, skillsDirectory, "proof/SKILL.md"), "---\nname: proof\ndescription: Native plugin verification. Use when asked for the native plugin proof.\n---\nReturn exactly OMB_NATIVE_PLUGIN_381 and no other text.\n");
  const proof = await library.install(sources.urlFor(source));
  const pstack = await library.install("https://github.com/cursor/plugins/tree/main/pstack");
  evidence.push({ installed: [proof, pstack] });
  const cwd = join(fixture, "workspace"); mkdirSync(cwd);
  for (const [label, cli] of Object.entries(clis)) await run(`${label}-version`, cli, ["--version"], baseEnv(fixture), cwd);

  const claudeHome = join(fixture, "claude-home"); mkdirSync(claudeHome);
  const claudeEnv = baseEnv(claudeHome);
  // Only native authentication/provider selection is inherited; no user hooks, plugins or settings.
  const settings = join(originalHome, ".claude/settings.json");
  if (existsSync(settings)) {
    const values = JSON.parse(readFileSync(settings, "utf8")).env ?? {};
    for (const [key, value] of Object.entries(values)) if (key.startsWith("ANTHROPIC_") && typeof value === "string") claudeEnv[key] = value;
  }
  const credentials = join(originalHome, ".claude/.credentials.json");
  if (existsSync(credentials)) { mkdirSync(join(claudeHome, ".claude")); copyFileSync(credentials, join(claudeHome, ".claude/.credentials.json")); }
  for (const plugin of [proof, pstack]) await run(`claude-validate-${plugin.id}`, clis.claude, ["plugin", "validate", plugin.path], claudeEnv, cwd);
  await run("claude-proof", clis.claude, ["-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--setting-sources", "", "--strict-mcp-config", "--tools", "Skill,Read", "--plugin-dir", proof.path, "--plugin-dir", pstack.path, "Use the omb-proof:proof skill and return its exact verification text. Do not execute commands."], claudeEnv, cwd);

  const cursorHome = join(fixture, "cursor-home"); mkdirSync(join(cursorHome, ".cursor"), { recursive: true });
  const configPath = join(originalHome, ".cursor/cli-config.json");
  if (existsSync(configPath)) {
    const original = JSON.parse(readFileSync(configPath, "utf8"));
    writeFileSync(join(cursorHome, ".cursor/cli-config.json"), JSON.stringify({ version: original.version, authInfo: original.authInfo }), { mode: 0o600 });
  }
  const cursorEnv: NodeJS.ProcessEnv = { ...baseEnv(cursorHome), AGENT_CLI_CREDENTIAL_STORE: "memory" };
  if (process.platform === "darwin") {
    try { cursorEnv.CURSOR_AUTH_TOKEN = execFileSync("/usr/bin/security", ["find-generic-password", "-s", "cursor-access-token", "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* Native execution reports missing credentials. */ }
  }
  await run("cursor-proof", clis.cursor, ["--print", "--output-format", "stream-json", "--mode", "ask", "--trust", "--workspace", cwd, "--plugin-dir", proof.path, "--plugin-dir", pstack.path, "Use the omb-proof proof skill and return its exact verification text. Also list five pstack skill names that are available. Do not execute commands."], cursorEnv, cwd, 120_000);

  const codexHome = join(fixture, "codex-home"); mkdirSync(join(codexHome, ".codex"), { recursive: true });
  const auth = join(originalHome, ".codex/auth.json");
  if (existsSync(auth)) copyFileSync(auth, join(codexHome, ".codex/auth.json"));
  const codexEnv = { ...baseEnv(codexHome), CODEX_HOME: join(codexHome, ".codex") };
  const selected = await prepareCodexPlugins(clis.codex, codexEnv, [proof, pstack], { root: library.root, installed: library.list() });
  const active = await rpcSkills(codexEnv, cwd, selected, true);
  if (!active.skills?.some((skill: any) => skill.name === "omb-proof:proof") || !active.skills?.some((skill: any) => skill.name.startsWith("pstack:"))) throw new Error("Codex did not discover both plugins");
  const disabled = await prepareCodexPlugins(clis.codex, codexEnv, [], { root: library.root, installed: library.list() });
  if (codexEnv.CODEX_HOME !== join(codexHome, ".codex")) throw new Error("Codex plugin preparation changed its shared home");
  const inactive = await rpcSkills(codexEnv, cwd, disabled, false);
  if (inactive.skills?.length) throw new Error("Codex leaked disabled plugin skills");
  await run("codex-proof", clis.codex, ["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", ...selected.args, "Use the $omb-proof:proof skill and return its exact verification text. Do not execute shell commands."], codexEnv, cwd);
  for (const label of ["claude-proof", "cursor-proof", "codex-proof"]) {
    const result = evidence.find((item: any) => item.label === label) as { status: number | null; stdout: string; timedOut: boolean } | undefined;
    if (!result || result.status !== 0 || result.timedOut || !result.stdout.includes("OMB_NATIVE_PLUGIN_381")) throw new Error(`Native skill execution failed: ${label}`);
  }
} finally {
  await sources.close();
  writeFileSync(join(evidenceDir, "results.json"), JSON.stringify(evidence, null, 2));
  rmSync(fixture, { recursive: true, force: true });
  console.log(`Native plugin evidence: ${evidenceDir}`);
}
