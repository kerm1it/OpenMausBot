import { z } from "zod";

export const pluginIdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100);
export const botPluginsSchema = z.array(pluginIdSchema).max(100).transform(ids => [...new Set(ids)]);
export const PLUGIN_SOURCE_ERROR = "source must be an HTTP or HTTPS URL without embedded credentials; local paths are not supported";
export const pluginSourceSchema = z.string().trim().min(1).max(4096).refine(value => {
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return Boolean(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}, PLUGIN_SOURCE_ERROR);

export interface InstalledPlugin {
  id: string;
  version: string;
  description?: string;
  source: string;
  installedAt: number;
  path: string;
}

export interface PluginLibrarySnapshot {
  root: string;
  installed: InstalledPlugin[];
}

export interface UninstalledPlugin {
  id: string;
  status: "uninstalled";
  removed: boolean;
  affectedBotIds: string[];
}
