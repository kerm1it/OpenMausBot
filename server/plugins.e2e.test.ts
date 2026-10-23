import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerArgs, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { createPluginSourceServer } from "./testing/plugin-source.ts";
import { waitForExit } from "./testing/cleanup.ts";

it("installs through AI, persists bot choices, guards active turns and uninstalls through AI and control", async () => {
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, { scripted: true });
  const { url, dataDir, logPath } = fixture.info;
  const sources = await createPluginSourceServer();
  const evidence: unknown[] = [{ fixture: fixture.info }];
  let restarted: ChildProcess | undefined;
  const api = async (method: string, path: string, body?: unknown, expected = 200): Promise<any> => {
    const response = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    evidence.push({ method, path, body, status: response.status, result });
    expect(response.status, JSON.stringify(result)).toBe(expected);
    return result;
  };
  const control = async (...args: string[]): Promise<any> => {
    const result = await runControlOmb([...args, "--url", url]);
    evidence.push({ command: args, result });
    return result;
  };
  const restart = async () => {
    await waitForExit(restarted ?? fixture.child, { signal: "SIGTERM" });
    const env = verificationServerEnvironment({ FAKE_CLAUDE_ROOM_PLAN: join(dataDir, "room-plan.json") }, dataDir, Number(new URL(url).port));
    const fd = openSync(logPath, "a");
    restarted = spawn(process.execPath, verificationServerArgs(env), { env, stdio: ["ignore", fd, fd] });
    closeSync(fd);
    await expect.poll(async () => { try { return (await fetch(`${url}/api/health`)).ok; } catch { return false; } }, { timeout: 25_000 }).toBe(true);
  };
  const source = join(dataDir, "prepared-plugin");
  const makePlugin = () => {
    mkdirSync(join(source, ".cursor-plugin"), { recursive: true });
    mkdirSync(join(source, "skills", "proof"), { recursive: true });
    writeFileSync(join(source, ".cursor-plugin/plugin.json"), JSON.stringify({ name: "fixture-plugin", version: "1.0.0", skills: "./skills/" }));
    writeFileSync(join(source, "skills/proof/SKILL.md"), "---\nname: proof\ndescription: Verification proof\n---\nReply OMB_PLUGIN_PROOF.\n");
  };
  try {
    makePlugin();
    expect((await api("POST", "/api/plugins/install", { source }, 400)).error).toContain("local paths are not supported");
    expect((await api("GET", "/api/plugins")).plugins).toEqual([]);
    await expect(runControlOmb(["install-plugin", "--source", source, "--url", url])).rejects.toThrow("local paths are not supported");
    const chief = (await control("new-bot", "--name", "Installer", "--section", "Plugins")).bot;
    expect(chief.plugins).toEqual([]);
    // Full grants are fixture setup only, applied while the disposable server is stopped.
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const saved = JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8"));
    const caller = saved.find((bot: any) => bot.id === chief.id);
    caller.chiefOfStaff = true; caller.approvalMode = "full"; caller.browser = false; caller.computer = "off";
    for (const task of caller.tasks) task.approvalMode = "full";
    writeFileSync(join(dataDir, "bots.json"), JSON.stringify(saved));
    await restart();
    // Restore scripted provider planning only, keeping requests and tools real.
    writeFileSync(join(dataDir, "room-plan.json"), JSON.stringify({ [chief.id]: { turns: [{ steps: [
      { tool: "install_plugin", arguments: { source }, expectError: true },
      { tool: "install_plugin", arguments: { source: sources.urlFor(source) } },
      { tool: "list_plugins", arguments: {} },
      { tool: "create_bot", arguments: { name: "Native worker", role: "Plugin tester", instructions: "Use native skills.", plugins: ["fixture-plugin"] } },
    ], reply: "Plugin installed and worker created." }] } }));
    await control("send", "--bot", chief.id, "--task", chief.activeTaskId, "--text", "Install the prepared plugin and create the native worker.");
    expect((await control("wait", "--bot", chief.id, "--task", chief.activeTaskId, "--timeout", "30")).status).toBe("settled");
    const planning = readFileSync(join(dataDir, "room-plan.json.evidence.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const calls = planning.flatMap(turn => turn.evidence ?? []).filter(item => item.step);
    evidence.push({ aiToolCalls: calls });
    expect(calls).toHaveLength(4);
    expect(calls[0].response.result?.isError).toBe(true);
    expect(JSON.stringify(calls[0].response)).toContain("local paths are not supported");
    expect(calls.slice(1).every(item => !item.response.error && !item.response.result?.isError)).toBe(true);
    const plugins = (await control("plugins")).plugins;
    expect(plugins).toEqual([expect.objectContaining({ id: "fixture-plugin", version: "1.0.0" })]);
    const worker = (await control("bots")).bots.find((bot: any) => bot.name === "Native worker");
    expect(worker.plugins).toEqual(["fixture-plugin"]);
    const plain = (await control("new-bot", "--name", "Plain")).bot;
    const explicit = (await control("new-bot", "--name", "Explicit", "--plugins", "fixture-plugin")).bot;
    expect(explicit.plugins).toEqual(["fixture-plugin"]);
    await api("POST", "/api/bots", { name: "Invalid", plugins: ["missing"] }, 400);
    await api("POST", "/api/bots", { name: "Invalid", plugins: "fixture-plugin" }, 400);
    const turn = async (bot: any) => {
      await api("PATCH", `/api/bots/${bot.id}`, { browser: false, computer: "off" });
      await control("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Reply once for plugin launch verification.");
      expect((await control("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30")).status).toBe("settled");
      const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
      const dirs = dump.argv.flatMap((arg: string, index: number) => arg === "--plugin-dir" ? [dump.argv[index + 1]] : []);
      evidence.push({ bot: bot.id, pluginDirectories: dirs });
      return dirs;
    };
    expect(await turn(worker)).toEqual([plugins[0].path]);
    expect(await turn(plain)).toEqual([]);
    await api("PATCH", `/api/bots/${worker.id}`, { plugins: [] });
    expect(await turn(worker)).toEqual([]);
    await api("PATCH", `/api/bots/${worker.id}`, { plugins: ["fixture-plugin"] });
    await restart();
    expect((await control("bots")).bots.find((bot: any) => bot.id === worker.id).plugins).toEqual(["fixture-plugin"]);
    expect(await turn(worker)).toEqual([plugins[0].path]);
    const release = join(dataDir, "release-plugin-turn");
    writeFileSync(join(dataDir, "room-plan.json"), JSON.stringify({
      [worker.id]: { script: [{ key: "held-plugin-turn", match: ["HOLD_PLUGIN_TURN"], gateFile: release, progress: "Plugin turn held.", reply: "Released." }] },
      [chief.id]: { script: [{ key: "uninstall-plugin", match: ["REMOVE_PLUGIN_NOW"], steps: [
        { tool: "uninstall_plugin", arguments: { plugin_id: "fixture-plugin" } },
        { tool: "list_plugins", arguments: {} },
      ], reply: "Plugin uninstalled." }] },
    }));
    await control("send", "--bot", worker.id, "--task", worker.activeTaskId, "--text", "HOLD_PLUGIN_TURN");
    await expect.poll(() => readFileSync(fixture.fixtureDumpPath, "utf8").includes("HOLD_PLUGIN_TURN"), { timeout: 10_000 }).toBe(true);
    await api("POST", "/api/plugins/install", { source: sources.urlFor(source) }, 409);
    expect((await control("plugins")).plugins[0].version).toBe("1.0.0");
    await api("POST", "/api/plugins/uninstall", { plugin_id: "fixture-plugin" }, 409);
    // Changing the standing selection cannot release a plugin used by this turn.
    await api("PATCH", `/api/bots/${worker.id}`, { plugins: [] });
    await api("POST", "/api/plugins/uninstall", { plugin_id: "fixture-plugin" }, 409);
    expect((await control("plugins")).plugins).toHaveLength(1);
    writeFileSync(release, "release");
    expect((await control("wait", "--bot", worker.id, "--task", worker.activeTaskId, "--timeout", "30")).status).toBe("settled");
    writeFileSync(join(source, ".cursor-plugin/plugin.json"), JSON.stringify({ name: "fixture-plugin", version: "2.0.0", skills: "./skills/" }));
    await control("install-plugin", "--source", sources.urlFor(source));
    expect((await control("plugins")).plugins[0].version).toBe("2.0.0");
    await api("PATCH", `/api/bots/${worker.id}`, { plugins: ["fixture-plugin"] });
    await control("send", "--bot", chief.id, "--task", chief.activeTaskId, "--text", "REMOVE_PLUGIN_NOW");
    expect((await control("wait", "--bot", chief.id, "--task", chief.activeTaskId, "--timeout", "30")).status).toBe("settled");
    const uninstallCalls = readFileSync(join(dataDir, "room-plan.json.evidence.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line))
      .filter(row => row.planKey === "uninstall-plugin").flatMap(row => row.evidence ?? []);
    evidence.push({ aiUninstallCalls: uninstallCalls });
    expect(uninstallCalls.filter(item => item.step)).toHaveLength(2);
    expect(uninstallCalls.filter(item => item.step).every(item => !item.response.error && !item.response.result?.isError)).toBe(true);
    expect((await control("plugins")).plugins).toEqual([]);
    for (const id of [worker.id, explicit.id]) expect((await control("bots")).bots.find((bot: any) => bot.id === id).plugins).toEqual([]);
    expect(await control("uninstall-plugin", "--id", "fixture-plugin")).toMatchObject({ removed: false });
    await control("install-plugin", "--source", sources.urlFor(source));
    expect((await control("plugins")).plugins).toHaveLength(1);
    expect((await control("bots")).bots.find((bot: any) => bot.id === worker.id).plugins).toEqual([]);
  } finally {
    const path = `${logPath}.plugins.json`;
    writeFileSync(path, JSON.stringify(evidence, null, 2));
    console.log(`Plugin workflow evidence: ${path}`);
    await waitForExit(restarted, { signal: "SIGTERM" });
    await sources.close();
    await fixture.close();
  }
}, 120_000);
