import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { waitForExit } from "../../server/testing/cleanup.ts";

export function nativeRpc(child: ChildProcessWithoutNullStreams, timeoutMs = 15_000) {
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, { finish(value: any, error?: Error): void }>();
  let serial = 0;
  child.stderr.resume();
  lines.on("line", line => {
    let message: any;
    try { message = JSON.parse(line); } catch { return; }
    pending.get(message.id)?.finish(message.result, message.error ? new Error(JSON.stringify(message.error)) : undefined);
  });
  const fail = (error: Error) => { for (const waiter of pending.values()) waiter.finish(undefined, error); };
  child.on("error", fail);
  child.on("close", () => fail(new Error("Native fixture exited")));
  const notify = (method: string, params: unknown = {}) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  const call = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => pending.get(id)?.finish(undefined, new Error(`Native fixture timeout: ${method}`)), timeoutMs);
    pending.set(id, { finish: (value, error) => { clearTimeout(timer); pending.delete(id); if (error) reject(error); else resolve(value); } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const close = async () => { fail(new Error("Native fixture closed")); lines.close(); await waitForExit(child, { signal: "SIGTERM" }); };
  return { call, notify, close };
}

export function responseStream(response: { output: { id: string; content: { text: string }[] }[]; [key: string]: unknown }): string {
  const item = response.output[0]!, content = item.content[0]!;
  const events = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { ...content, text: "" } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: content.text },
    { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text: content.text },
    { type: "response.content_part.done", item_id: item.id, output_index: 0, content_index: 0, part: content },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ];
  return events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join("");
}
