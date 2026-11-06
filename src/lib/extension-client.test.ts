import { afterEach, expect, it, vi } from "vitest";
import type { ExtensionImportPreview } from "../../shared/extension-import";
vi.mock("@/state/store", () => ({ api: vi.fn() }));
import { prepareExtension } from "./extension-client";

afterEach(() => vi.unstubAllGlobals());
it("delivers progress while the final preview is still downloading", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ start(controller) { stream = controller; } }), { headers: { "content-type": "application/x-ndjson" } })));
  let progressed!: () => void;
  const received = new Promise<void>(resolve => { progressed = resolve; });
  const progress = vi.fn(() => progressed());
  const pending = prepareExtension("https://fixture.test/bot.json", undefined, progress);
  await Promise.resolve();
  const line = `${JSON.stringify({ type: "progress", progress: { stage: "plugin", name: "pstack", receivedBytes: 2048 } })}\n`;
  stream.enqueue(encoder.encode(line.slice(0, 13)));
  stream.enqueue(encoder.encode(line.slice(13)));
  await received;
  expect(progress).toHaveBeenCalledWith({ stage: "plugin", name: "pstack", receivedBytes: 2048 });
  const preview = { id: "ready" } as ExtensionImportPreview;
  stream.enqueue(encoder.encode(`${JSON.stringify({ type: "ready", preview })}\n`));
  stream.close();
  expect(await pending).toEqual(preview);
});

it("preserves a streamed timeout status for the dialog's retry feedback", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(`${JSON.stringify({ type: "error", status: 504, message: "Template timed out" })}\n`)));
  await expect(prepareExtension("https://fixture.test/bot.json", undefined, vi.fn())).rejects.toMatchObject({ message: "Template timed out", status: 504 });
});
