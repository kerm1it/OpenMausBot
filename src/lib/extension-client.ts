import { api } from "@/state/store";
import type { ExtensionImportPreview, ExtensionImportOptions, ExtensionImportResult, BotTemplateExportOptions, ExtensionPreparationEvent, ExtensionPreparationProgress } from "../../shared/extension-import";
import type { ExtensionInput } from "./extension-events";

async function prepareRequest(init: RequestInit, signal?: AbortSignal, onProgress?: (progress: ExtensionPreparationProgress) => void): Promise<ExtensionImportPreview> {
  if (!onProgress) return api<ExtensionImportPreview>("/api/extensions/prepare", { ...init, signal, timeoutMs: 210_000 });
  const headers = new Headers(init.headers);
  headers.set("accept", "application/x-ndjson");
  const response = await fetch("/api/extensions/prepare", { ...init, headers, signal: AbortSignal.any([AbortSignal.timeout(210_000), ...signal ? [signal] : []]) });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw Object.assign(new Error(body.error ?? `Import preparation failed (${response.status})`), { status: response.status });
  }
  if (!response.body) throw new Error("The import preview response was empty");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "", preview: ExtensionImportPreview | undefined;
  const consume = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as ExtensionPreparationEvent;
    if (event.type === "progress") onProgress(event.progress);
    else if (event.type === "ready") preview = event.preview;
    else if (event.type === "error") throw Object.assign(new Error(event.message), { status: event.status });
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffered.indexOf("\n")) >= 0) { consume(buffered.slice(0, end)); buffered = buffered.slice(end + 1); }
    }
    consume(buffered + decoder.decode());
    if (!preview) throw new Error("The import preview ended before it was ready");
    return preview;
  } finally { await reader.cancel().catch(() => {}); }
}

export function prepareExtension(input: ExtensionInput, signal?: AbortSignal, onProgress?: (progress: ExtensionPreparationProgress) => void) {
  return prepareRequest({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input }) }, signal, onProgress);
}

export async function prepareExtensionFile(file: File, signal?: AbortSignal, onProgress?: (progress: ExtensionPreparationProgress) => void) {
  if (file.name.toLowerCase().endsWith(".json")) return prepareExtension(await file.text(), signal, onProgress);
  return prepareRequest({ method: "POST", headers: { "content-type": "application/zip" }, body: await file.arrayBuffer() }, signal, onProgress);
}

export function discardExtension(id: string) {
  return api(`/api/extensions/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
}

export function importExtension(id: string, options: ExtensionImportOptions) {
  return api<ExtensionImportResult>(`/api/extensions/${encodeURIComponent(id)}/import`, {
    method: "POST", body: JSON.stringify(options), timeoutMs: 120_000,
  });
}

export async function exportBotTemplate(botId: string, options: BotTemplateExportOptions) {
  const response = await fetch(`/api/bots/${encodeURIComponent(botId)}/template`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(options),
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    throw new Error(body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : `Export failed (${response.status})`);
  }
  return response.blob();
}

export function saveExtensionArchive(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename;
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
