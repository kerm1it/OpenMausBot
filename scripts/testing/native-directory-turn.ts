import assert from "node:assert/strict";
import type { SendTurnInput, RuntimeEvent } from "../../server/contracts.ts";

export async function runNativeCodexDirectoryTurn(cli: string, environment: Record<string, string>, input: SendTurnInput) {
  const { CodexDriver } = await import("../../server/drivers/codex.ts");
  const instance = await CodexDriver.create({ instanceId: "directory-proof", displayName: "Isolated directory verification",
    enabled: true, config: { cli, fullAuto: true }, environment });
  const events: RuntimeEvent[] = [];
  let timer: ReturnType<typeof setTimeout>;
  const finished = new Promise<void>((done, fail) => {
    timer = setTimeout(() => fail(new Error("Native Codex directory turn timed out")), 180_000);
    instance.adapter.onEvent(event => {
      events.push(event);
      if (event.type === "turn.completed") {
        if (event.ok) done(); else fail(new Error("Native Codex directory turn failed"));
      }
    });
  });
  try {
    await Promise.all([instance.adapter.sendTurn(input), finished]);
    assert.ok(events.some(event => event.type === "turn.completed" && event.ok));
    return events;
  } finally { clearTimeout(timer!); await instance.dispose(); }
}
