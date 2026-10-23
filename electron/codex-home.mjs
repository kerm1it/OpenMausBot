import path from "node:path";

/** One native Codex home per OpenMausBot workspace, shared by its bots. */
export function codexRuntimeHome(dataDir) {
  return path.resolve(dataDir, "providers", "codex");
}
