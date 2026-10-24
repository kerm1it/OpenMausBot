import { pluginLibrary, type PluginLibrary } from "./plugins.ts";
import type { Store } from "./store.ts";
import type { NewBotDefaults } from "./new-bot-defaults.ts";
import type { UninstalledPlugin } from "../shared/plugins.ts";

export function createPluginService(deps: {
  library?: PluginLibrary;
  store: Pick<Store, "removePluginReferences">;
  inUse: (id: string) => boolean;
  getDefaults: () => NewBotDefaults | undefined;
  saveDefaults: (defaults: NewBotDefaults) => void;
}) {
  const library = deps.library ?? pluginLibrary;
  const requireIdle = (id: string, requireActive?: () => void) => {
    requireActive?.();
    if (deps.inUse(id)) throw Object.assign(new Error("Plugin is in use by a running turn. Retry when it finishes."), { status: 409 });
  };
  const uninstall = async (id: string, requireActive?: () => void): Promise<UninstalledPlugin> => {
    let affectedBotIds: string[] = [];
    const result = await library.uninstall(id, () => {
      requireIdle(id, requireActive);
      const defaults = deps.getDefaults();
      const nextDefaults = defaults && defaults.profile.plugins?.includes(id)
        ? { ...defaults, profile: { ...defaults.profile, plugins: defaults.profile.plugins.filter(plugin => plugin !== id) } }
        : undefined;
      if (nextDefaults) deps.saveDefaults(nextDefaults);
      try { affectedBotIds = deps.store.removePluginReferences(id).map(bot => bot.id); }
      catch (error) { if (nextDefaults && defaults) deps.saveDefaults(defaults); throw error; }
    });
    return { ...result, affectedBotIds };
  };
  return {
    list: () => library.list(),
    install: (source: string, requireActive?: () => void) => library.install(source, (plugin, replacing) => {
      if (replacing) requireIdle(plugin.id, requireActive);
      else requireActive?.();
    }),
    uninstall,
  };
}
