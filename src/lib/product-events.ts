
import {
  type KeyProvider, type KeyResult,
} from "@/lib/analytics-allowlist";

const CHECKED_BEFORE_SAVE = new Set<string>(["boat", "composio", "elevenlabs", "fish_audio"]);

/** The server saves these keys only after their provider accepted them; every other key is unverified until tested. */
export function savedKeyResult(provider: KeyProvider | "other"): KeyResult {
  return CHECKED_BEFORE_SAVE.has(provider) ? "ok" : "unverified";
}

// Electron 43 rejects ipcRenderer.invoke with "Error invoking remote method '<channel>': " and the toString() of what main threw.
const IPC_KEY_REJECTED = /^Error invoking remote method '[^']*': KeyRejected: /;

export function keySaveFailure(cause: unknown): "rejected" | "error" {
  if ((cause as { body?: { code?: unknown } } | null | undefined)?.body?.code === "key_rejected") return "rejected";
  return cause instanceof Error && IPC_KEY_REJECTED.test(cause.message) ? "rejected" : "error";
}

/** `answer` is what POST /api/keys/test returned, or null when that request failed. */
export function keyTestResult(answer: { ok?: unknown; reason?: unknown } | null | undefined): KeyResult {
  if (answer?.ok === true) return "ok";
  return answer?.reason === "rejected" ? "rejected" : "unverified";
}
