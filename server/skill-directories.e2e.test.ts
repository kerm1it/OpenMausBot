import { basename, join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import type { WireBot, WireMessage } from "../shared/wire.ts";

it("uses the real agent tool to preserve a binary attachment, patch scripts, download reviewed files and Undo", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-directory-e2e-"));
  const calls = join(scratch, "calls.json");
  writeFileSync(calls, "[]");
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_TOOL_CALLS_FILE: calls, FAKE_CLAUDE_RUN_BASH: "1" });
  const url = fixture.info.url;
  const api = async <T = any>(path: string, method = "GET", body?: unknown, status = 200): Promise<T> => {
    const response = await fetch(url + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json();
    expect(response.status, JSON.stringify(value)).toBe(status);
    return value as T;
  };
  const turn = async (bot: WireBot, text: string) => {
    await runControlOmb(["send", "--bot", bot.id, "--task", bot.threadId, "--text", text, "--url", url]);
    expect(await runControlOmb(["wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "30", "--url", url])).toMatchObject({ status: "settled" });
  };
  const messages = async (bot: WireBot) => (await api<{ messages: WireMessage[] }>(`/api/threads/${bot.threadId}/messages`)).messages;
  try {
    await api("/api/config", "PATCH", { features: { skillReview: false, skillsLibrary: false } });
    const { bot } = await api<{ bot: WireBot }>("/api/bots", "POST", { name: "Skill Fixture" }, 201);
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2Hf8AAAAASUVORK5CYII=", "base64");
    const upload = await fetch(url + "/api/attachments", { method: "POST", headers: { "content-type": "image/png" }, body: bytes });
    expect(upload.status).toBe(201);
    const attachment = await upload.json() as { path: string; mime: string; bytes: number };
    await api(`/api/bots/${bot.id}/messages`, "POST", { text: `Keep this fixture attachment for the Skill.\n\n<attached-image path="${attachment.path}" name="pixel.png" />` }, 202);
    expect(await runControlOmb(["wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "30", "--url", url])).toMatchObject({ status: "settled" });
    const name = "directory-fixture";
    writeFileSync(calls, JSON.stringify([{ server: "agents", name: "skill_manage", input: { action: "create", source: "conversation", skill_md: `---\nname: ${name}\ndescription: Uses the complete fixture directory.\n---\n\nRun scripts/run.sh and read assets/pixel.png.\n`, files: [
      { path: "scripts/run.sh", content: "#!/bin/sh\nprintf fixture\n", executable: true },
      { path: "assets/pixel.png", attachment_id: basename(attachment.path) },
      { path: "assets/empty", content: "" },
    ] } }]));
    await turn(bot, "Create the directory-fixture Skill using the supplied files.");
    const created = (await messages(bot)).findLast(message => message.card?.skillRequest?.name === name)?.card;
    expect(created, JSON.stringify(await messages(bot))).toMatchObject({ autoApplied: true, answered: "allow", skillRequest: { directorySha256: expect.stringMatching(/^[a-f0-9]{64}$/), files: expect.arrayContaining([expect.objectContaining({ path: "assets/pixel.png", binary: true, size: bytes.length })]) } });
    const reviewed = await api(`/api/bots/${bot.id}/skills/${name}`);
    const binary = reviewed.files.find((file: { path: string }) => file.path === "assets/pixel.png");
    expect(Buffer.from(await (await fetch(url + binary.download)).arrayBuffer())).toEqual(bytes);
    expect(readFileSync(join(fixture.info.dataDir, "workspaces", bot.id, "skills", name, "assets", "empty"))).toHaveLength(0);
    writeFileSync(calls, JSON.stringify([{ server: "agents", name: "skill_manage", input: { action: "update", source: "conversation", skill_name: name,
      files: [{ path: "scripts/run.sh", content: "", executable: true }], remove_files: ["assets/pixel.png"] } }]));
    await turn(bot, "Revise directory-fixture: empty the script and remove the pixel attachment.");
    const updated = (await messages(bot)).findLast(message => message.card?.skillRequest?.name === name)?.card;
    expect(updated).toMatchObject({ autoApplied: true, skillRequest: { action: "update", previous: { directoryRevision: expect.stringMatching(/^[a-f0-9]{64}$/) } } });
    const after = await api(`/api/bots/${bot.id}/skills/${name}`);
    expect(after.files.find((file: { path: string }) => file.path === "scripts/run.sh").size).toBe(0);
    expect(after.files.some((file: { path: string }) => file.path === "assets/pixel.png")).toBe(false);
    await api(`/api/threads/${bot.threadId}/undo`, "POST", { requestId: updated!.requestId });
    const restored = await api(`/api/bots/${bot.id}/skills/${name}`);
    expect(restored.directorySha256).toBe(reviewed.directorySha256);
    expect(Buffer.from(await (await fetch(url + restored.files.find((file: { path: string }) => file.path === "assets/pixel.png").download)).arrayBuffer())).toEqual(bytes);
    const stale = await fetch(url + `/api/bots/${bot.id}/skills/${name}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true, directorySha256: "0".repeat(64) }) });
    expect(stale.status).toBe(409);

    await api("/api/config", "PATCH", { threads: { maxConcurrentPerBot: 2 } });
    const { task } = await api<{ task: { threadId: string } }>(`/api/bots/${bot.id}/tasks`, "POST", { title: "Concurrent Skill editor" }, 201);
    const other = { ...bot, threadId: task.threadId };
    const ready = join(scratch, "paused"), release = join(scratch, "release");
    const program = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))process.exit(0)},20);setTimeout(()=>process.exit(2),15000)`;
    const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    const change = (content: string) => ({ server: "agents", name: "skill_manage", input: { action: "update", source: "conversation", skill_name: name,
      files: [{ path: "scripts/run.sh", content, executable: true }] } });
    writeFileSync(calls, JSON.stringify([{ name: "Bash", input: { command: `${quote(process.execPath)} -e ${quote(program)}` } }, change("stale-task-a")]));
    await runControlOmb(["send", "--bot", bot.id, "--task", bot.threadId, "--text", "Read then pause before revising the fixture Skill.", "--url", url]);
    await expect.poll(() => existsSync(ready), { timeout: 10_000 }).toBe(true);
    writeFileSync(calls, JSON.stringify([change("new-task-b")]));
    await turn(other, "Revise the directory-fixture script from the second task.");
    writeFileSync(release, "continue");
    expect(await runControlOmb(["wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "30", "--url", url])).toMatchObject({ status: "settled" });
    const staleCall = (await messages(bot)).filter(message => message.kind === "activity" && message.tool?.name === "skill_manage").at(-1);
    expect(staleCall?.tool).toMatchObject({ ok: false, output: expect.stringContaining("changed since this turn began") });
    const afterConcurrent = await api(`/api/bots/${bot.id}/skills/${name}`);
    expect(afterConcurrent.files.find((file: { path: string }) => file.path === "scripts/run.sh").content).toBe("new-task-b");
    writeFileSync(calls, JSON.stringify([change("fresh-task-a")]));
    await turn(bot, "Read the latest version in this new turn, then revise its script.");
    const fresh = await api(`/api/bots/${bot.id}/skills/${name}`);
    expect(fresh.files.find((file: { path: string }) => file.path === "scripts/run.sh").content).toBe("fresh-task-a");

  } finally { await fixture.close(); rmSync(scratch, { recursive: true, force: true }); }
}, 120_000);
