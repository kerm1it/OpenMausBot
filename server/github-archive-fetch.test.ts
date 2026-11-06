import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
import { githubArchiveFetch } from "./github-archive-fetch.ts";

afterEach(() => { spawn.mockReset(); vi.unstubAllGlobals(); });
function processFixture() {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });
  spawn.mockImplementation(() => { queueMicrotask(() => child.emit("spawn")); return child; });
  return child;
}

it("streams archive bytes without waiting for the complete download", async () => {
  const child = processFixture();
  const response = await githubArchiveFetch("https://codeload.github.com/example/plugins/zip/main");
  const reader = response.body!.getReader();
  child.stdout.write(Buffer.from([0, 255, 3]));
  expect(await reader.read()).toMatchObject({ done: false, value: Buffer.from([0, 255, 3]) });
  child.stdout.end();
  child.emit("close", 0);
  expect((await reader.read()).done).toBe(true);
});

it("stops the download process when preparation is cancelled", async () => {
  const child = processFixture();
  const controller = new AbortController();
  const response = await githubArchiveFetch("https://codeload.github.com/example/plugins/zip/main", { signal: controller.signal });
  const pending = expect(response.arrayBuffer()).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  await pending;
  expect(child.kill).toHaveBeenCalledOnce();
  expect(child.stdout.destroyed).toBe(true);
});

it("uses the same direct URL with fetch if curl is unavailable", async () => {
  const child = processFixture();
  spawn.mockImplementation(() => { queueMicrotask(() => child.emit("error", Object.assign(new Error("missing"), { code: "ENOENT" }))); return child; });
  const fetcher = vi.fn<typeof fetch>(async () => new Response("fallback archive"));
  vi.stubGlobal("fetch", fetcher);
  const url = "https://codeload.github.com/example/plugins/zip/main";
  expect(await (await githubArchiveFetch(url)).text()).toBe("fallback archive");
  expect(fetcher).toHaveBeenCalledWith(url, undefined);
});
