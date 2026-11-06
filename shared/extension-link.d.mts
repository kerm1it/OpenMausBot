import type { ExtensionImportRequest } from "./extension-import.ts";

export function isExtensionImportRequest(value: unknown): value is ExtensionImportRequest & { type: "bot" | "plugin"; source: "openmausbot" | "grok-bot" };
export function extensionImportFromLink(value: unknown): ExtensionImportRequest | null;
