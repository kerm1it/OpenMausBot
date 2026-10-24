import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPluginSourceServer } from "../server/testing/plugin-source.ts";
import { nativeRpc } from "./testing/native-plugin-protocol.ts";
import { runNativeCodexDirectoryTurn } from "./testing/native-directory-turn.ts";

const personalHome = homedir(), fixture = mkdtempSync(join(tmpdir(), "omb-skill-directories-"));
const supplemental = process.argv.includes("--supplemental");
const evidence = resolve(`.omb-scratch/verify-evidence/skill-directories${supplemental ? "-supplemental" : ""}`);
mkdirSync(evidence, { recursive: true });
process.env.OMB_DATA_DIR = join(fixture, "data");
const { PluginLibrary } = await import("../server/plugins.ts");
const { prepareCodexPlugins } = await import("../server/drivers/codex-plugins.ts");
const { installSkillDirectory, setSkillEnabled } = await import("../server/skills.ts");
const { installLibrarySkill } = await import("../server/skill-library.ts");
const { createSkillsLibraryHost } = await import("../server/host/skills-library.ts");
const { ensureTaskWorkspaceWithSkills } = await import("../server/skill-task-links.ts");
const { Store } = await import("../server/store.ts");
const { redactSecretsInText } = await import("../server/redact.ts");
const clis = {
  claude: execFileSync("/usr/bin/which", ["claude"], { encoding: "utf8" }).trim(),
  cursor: execFileSync("/usr/bin/which", ["cursor-agent"], { encoding: "utf8" }).trim(),
  codex: execFileSync("/usr/bin/which", ["codex"], { encoding: "utf8" }).trim(),
};
const baseEnv = (home: string): NodeJS.ProcessEnv => ({ HOME: home, USERPROFILE: home, PATH: process.env.PATH,
  TMPDIR: fixture, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local/share"),
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(?:https?|all|no)_proxy$/i.test(name))), NO_OPEN_BROWSER: "1" });
const payload = randomBytes(37), input = randomBytes(29).toString("hex");
const expected = createHash("sha256").update(input).update(payload).digest("hex");
const script = `#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
test -f "$root/assets/empty"
test ! -s "$root/assets/empty"
test -x "$root/scripts/proof.sh"
{ /bin/cat "$1"; /bin/cat "$root/assets/payload.bin"; } | /usr/bin/shasum -a 256 | /usr/bin/awk '{print $1}' > "$2"
`;
function skillSource(name: string) {
  const root = join(fixture, "sources", name);
  mkdirSync(join(root, "scripts"), { recursive: true }); mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "SKILL.md"), `---\nname: ${name}\ndescription: Execute the complete-directory verification on explicit request.\n---\nRun scripts/proof.sh from this skill's directory with the input-file and output-file arguments given in the request. The script reads assets/payload.bin and assets/empty. Execute the script directly so its executable bit is tested. Do not reimplement it.\n`);
  writeFileSync(join(root, "scripts/proof.sh"), script, { mode: 0o755 });
  writeFileSync(join(root, "assets/payload.bin"), payload); writeFileSync(join(root, "assets/empty"), "");
  return root;
}
async function run(label: string, cli: string, args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  const child = spawn(cli, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", timedOut = false;
  child.stdout.on("data", data => stdout += data); child.stderr.on("data", data => stderr += data);
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, 240_000);
  const status = await new Promise<number | null>((done, fail) => { child.on("error", fail); child.on("close", done); });
  clearTimeout(timer);
  const receipt = { label, cli, args, cwd, status, timedOut, stdout: redactSecretsInText(stdout), stderr: redactSecretsInText(stderr) };
  writeFileSync(join(evidence, `${label}.json`), JSON.stringify(receipt, null, 2));
  assert.equal(timedOut, false, `${label} timed out`); assert.equal(status, 0, `${label} failed; see evidence`);
  return receipt;
}
const sourceServer = await createPluginSourceServer();
const summaries: unknown[] = [];
try {
  const privateSource = skillSource("private-proof"), sharedSource = skillSource("shared-proof");
  const pluginRoot = join(fixture, "plugin");
  mkdirSync(join(pluginRoot, ".cursor-plugin"), { recursive: true });
  mkdirSync(join(pluginRoot, "skills"));
  const pluginSkill = skillSource("plugin-proof");
  const { cpSync } = await import("node:fs"); cpSync(pluginSkill, join(pluginRoot, "skills/plugin-proof"), { recursive: true });
  writeFileSync(join(pluginRoot, ".cursor-plugin/plugin.json"), JSON.stringify({ name: "directory-proof", version: "1.0.0", skills: "./skills/" }));
  const library = new PluginLibrary(), plugin = await library.install(sourceServer.urlFor(pluginRoot));
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const shared = installLibrarySkill({ name: "shared-proof", instructions: readFileSync(join(sharedSource, "SKILL.md"), "utf8"), directory: sharedSource, source: "fixture", reviewState: "approved" });
  assert.ok(!("error" in shared), JSON.stringify(shared));
  const host = createSkillsLibraryHost({ store, cfg: { features: { skillsLibrary: true } }, appendSkillRequestCard: () => { throw new Error("Verification never auto-applies a proposal"); } });
  for (const [engine, cli] of Object.entries(clis)) {
    const bot = store.createBot({ name: `Directory ${engine}` });
    store.patchBot(bot.id, { assignedSkills: ["shared-proof"] });
    const installed = installSkillDirectory(bot.id, "fixture", privateSource); assert.ok(!("error" in installed));
    assert.ok(!("error" in setSkillEnabled(bot.id, "private-proof", true)));
    host.beginTurnSkills(bot, bot.threadId);
    const taskWorkspace = ensureTaskWorkspaceWithSkills(bot.id, bot.threadId);
    const cwd = supplemental ? join(fixture, "custom-workspaces", engine) : taskWorkspace;
    mkdirSync(cwd, { recursive: true });
    const additional = supplemental ? ["--add-dir", taskWorkspace] : [];
    writeFileSync(join(cwd, "proof-input"), input);
    const home = join(fixture, `${engine}-home`); mkdirSync(home, { recursive: true });
    const env = baseEnv(home);
    const version = execFileSync(cli, ["--version"], { encoding: "utf8", env }).trim();
    const prompt = `Use the native private-proof, shared-proof, and directory-proof:plugin-proof Skills. For each, read its SKILL.md and directly execute its scripts/proof.sh with the absolute input ${join(cwd, "proof-input")} and output ${join(cwd, "RESULT-KIND")} replacing KIND with private, shared, or plugin respectively. Execute all three; do not calculate the result yourself. Only write these fixture result files. Report the commands you executed.`;
    console.log(JSON.stringify({ engine, version, state: "started" }));
    if (engine === "claude") {
      const settings = join(personalHome, ".claude/settings.json");
      if (existsSync(settings)) for (const [key, value] of Object.entries(JSON.parse(readFileSync(settings, "utf8")).env ?? {})) if (key.startsWith("ANTHROPIC_") && typeof value === "string") env[key] = value;
      const credentials = join(personalHome, ".claude/.credentials.json");
      if (existsSync(credentials)) { mkdirSync(join(home, ".claude")); copyFileSync(credentials, join(home, ".claude/.credentials.json")); }
      const execution = await run(engine, cli, ["-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--setting-sources", "project", "--strict-mcp-config", "--tools", "Skill,Read,Bash", "--dangerously-skip-permissions", "--allowedTools", "Skill,Read,Bash", ...additional, "--plugin-dir", plugin.path, prompt], env, cwd);
      const initial = execution.stdout.split("\n").filter(Boolean).map(line => JSON.parse(line)).find(row => row.subtype === "init");
      for (const skill of ["private-proof", "shared-proof", "directory-proof:plugin-proof"]) assert.ok(initial?.skills?.includes(skill), `Claude native discovery missed ${skill}`);
    } else if (engine === "cursor") {
      mkdirSync(join(home, ".cursor"));
      const config = join(personalHome, ".cursor/cli-config.json");
      if (existsSync(config)) { const original = JSON.parse(readFileSync(config, "utf8")); writeFileSync(join(home, ".cursor/cli-config.json"), JSON.stringify({ version: original.version, authInfo: original.authInfo }), { mode: 0o600 }); }
      env.AGENT_CLI_CREDENTIAL_STORE = "memory";
      if (process.platform === "darwin") try { env.CURSOR_AUTH_TOKEN = execFileSync("/usr/bin/security", ["find-generic-password", "-s", "cursor-access-token", "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* The CLI reports unavailable authentication. */ }
      await run(engine, cli, ["--print", "--output-format", "stream-json", "--force", "--trust", "--workspace", cwd, ...additional, "--plugin-dir", plugin.path, prompt], env, cwd);
    } else {
      const runtime = join(process.env.OMB_DATA_DIR!, "providers/codex"); mkdirSync(runtime, { recursive: true });
      const auth = join(personalHome, ".codex/auth.json"); if (existsSync(auth)) copyFileSync(auth, join(runtime, "auth.json"));
      env.CODEX_HOME = runtime;
      const selection = await prepareCodexPlugins(cli, env, [plugin], { root: library.root, installed: library.list() });
      const rpc = nativeRpc(spawn(cli, ["app-server", ...selection.args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] }));
      try {
        await rpc.call("initialize", { clientInfo: { name: "directory-proof", version: "1" } }); rpc.notify("initialized");
        if (supplemental) await rpc.call("skills/extraRoots/set", { extraRoots: [join(taskWorkspace, ".agents/skills")] });
        const skills = await rpc.call("skills/list", { cwds: [cwd], forceReload: true });
        writeFileSync(join(evidence, "codex-native-discovery.json"), JSON.stringify(skills, null, 2));
        const names = skills.data.flatMap((row: {skills: Array<{name: string}>}) => row.skills.map(skill => skill.name));
        for (const name of ["private-proof", "shared-proof", "directory-proof:plugin-proof"]) assert.ok(names.includes(name), `Codex native discovery missed ${name}`);
      } finally { await rpc.close(); }
      if (supplemental) {
        const external = join(fixture, "external-codex"); mkdirSync(external);
        if (existsSync(auth)) copyFileSync(auth, join(external, "auth.json"));
        process.env.OMB_CODEX_AUTH_HOME = external;
        const events = await runNativeCodexDirectoryTurn(cli, Object.fromEntries(Object.entries(env).filter((row): row is [string, string] => typeof row[1] === "string")), {
          botId: bot.id, threadId: bot.threadId, cwd, taskSkillsDir: taskWorkspace, text: prompt, approvalMode: "full",
          plugins: [plugin], pluginLibrary: { root: library.root, installed: library.list() },
        });
        writeFileSync(join(evidence, "codex.json"), redactSecretsInText(JSON.stringify(events, null, 2)));
      } else await run(engine, cli, ["-a", "never", "exec", "--json", "--skip-git-repo-check", "--sandbox", "workspace-write", ...selection.args, prompt], env, cwd);
    }
    const outputs = ["private", "shared", "plugin"].map(kind => ({ kind, digest: readFileSync(join(cwd, `RESULT-${kind}`), "utf8").trim() }));
    for (const output of outputs) assert.equal(output.digest, expected, `${engine}/${output.kind} did not execute the retained script/assets`);
    summaries.push({ engine, cli, version, outputs, expected, verified: true });
    writeFileSync(join(evidence, "results.json"), JSON.stringify(summaries, null, 2));
    console.log(JSON.stringify({ engine, version, verified: true, outputs: outputs.length }));
    host.releaseTurnSkills(bot.threadId);
  }
} finally {
  await sourceServer.close(); rmSync(fixture, { recursive: true, force: true });
  console.log(`Evidence: ${evidence}`);
}
