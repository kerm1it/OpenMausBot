import { api } from "@/state/store";
import type { ExtensionImportPreview, ExtensionImportOptions, ExtensionImportResult, BotTemplateExportOptions } from "../../shared/extension-import";
import type { ExtensionInput } from "./extension-events";

export function prepareExtension(input: ExtensionInput, signal?: AbortSignal) {
  return api<ExtensionImportPreview>("/api/extensions/prepare", { method: "POST", body: JSON.stringify({ input }), signal, timeoutMs: 120_000 });
}

export async function prepareExtensionFile(file: File, signal?: AbortSignal) {
  if (file.name.toLowerCase().endsWith(".json")) return prepareExtension(await file.text(), signal);
  return api<ExtensionImportPreview>(`/api/extensions/prepare?filename=${encodeURIComponent(file.name)}`, {
    method: "POST", headers: { "content-type": "application/zip" }, body: await file.arrayBuffer(), signal, timeoutMs: 120_000,
  });
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
