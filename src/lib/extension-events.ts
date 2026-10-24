import type { ExtensionImportRequest } from "../../shared/extension-import";

export type ExtensionInput = string | ExtensionImportRequest;
export const EXTENSION_IMPORT_EVENT = "omb:extension-import";
export const EXTENSION_EXPORT_EVENT = "omb:extension-export";
export const EXTENSION_INSTALLED_EVENT = "omb:extension-installed";

export function openExtensionImport(input?: ExtensionInput) {
  window.dispatchEvent(new window.CustomEvent(EXTENSION_IMPORT_EVENT, { detail: input }));
}

export function openBotTemplateExport(botId: string) {
  window.dispatchEvent(new window.CustomEvent(EXTENSION_EXPORT_EVENT, { detail: botId }));
}
