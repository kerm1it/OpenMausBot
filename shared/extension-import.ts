import type { BotTemplateProfile, TemplateRequirement } from "./bot-template-format.ts";
import type { ModelSelection, WireBot } from "./wire.ts";

/** A marketplace ID identifies a resource directory; a URL identifies a complete source directory or archive. */
export interface ExtensionImportRequest {
  type?: "bot" | "plugin";
  source?: "openmausbot" | "grok-bot";
  id?: string;
  url?: string;
}

export interface ExtensionFilePreview {
  path: string;
  size: number;
  executable: boolean;
  text?: string;
}

export interface ExtensionSkillPreview {
  name: string;
  description: string;
  path: string;
  files: ExtensionFilePreview[];
}

export interface ExtensionPluginPreview {
  id: string;
  name: string;
  optional: boolean;
  source?: string;
  version?: string;
  installedVersion?: string;
  state: "installed" | "install" | "different" | "unavailable";
  error?: string;
}

/** Confirmation consumes this prepared snapshot, never a fresh download of its source. */
export interface ExtensionImportPreview {
  id: string;
  type: "bot" | "plugin";
  source: string;
  name: string;
  description: string;
  profile?: BotTemplateProfile["profile"];
  requirements: TemplateRequirement[];
  skills: ExtensionSkillPreview[];
  plugins: ExtensionPluginPreview[];
  memory: Array<{ path: string; text: string }>;
  routines: Array<{ name: string; schedule: string }>;
  files: ExtensionFilePreview[];
  warnings: string[];
}

/** Missing required dependencies must be resolved or explicitly omitted before confirmation. */
export interface ExtensionImportOptions {
  name?: string;
  section?: string;
  modelSelection?: ModelSelection;
  includeMemory?: boolean;
  includeRoutines?: boolean;
  omitPlugins?: string[];
  reusePlugins?: string[];
  omitSkills?: string[];
}

export interface ExtensionImportResult {
  bot?: WireBot;
  botId?: string;
  threadId?: string;
  pluginId?: string;
  warnings: string[];
}

export interface BotTemplateExportOptions {
  id?: string;
  name?: string;
  summary?: string;
  publisher?: string;
  includeMemory?: boolean;
  includeRoutines?: boolean;
}
