// Child-process-only overrides (the standalone Codex install stays untouched). The desktop-app browser is
// not available in Codex CLI, so its tool is off; native web search stays governed by the user's config.
// https://developers.openai.com/codex/browser
export function codexToolSurfaceArgs(): string[] {
  return [
    "-c", "features.browser_use=false",
    "-c", "features.browser_use_external=false",
    "-c", "features.computer_use=false",
    "-c", "features.plugins=true",
    "-c", "features.tool_suggest=false",
    "-c", "features.recommended_plugins=false",
    // codex-cli 0.162.0-alpha.17.2 reads quoted dotted override keys literally.
    "-c", 'plugins={ _default = { enabled = false }, "browser@openai-bundled" = { enabled = false }, "computer-use@openai-bundled" = { enabled = false }, "unified-computer-use@openai-bundled" = { enabled = false } }',
    // Native web search needs no desktop browser connection; keep the user's/provider's mode.
  ];
}
