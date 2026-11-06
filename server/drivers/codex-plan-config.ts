/** The token-sharing Responses bridge carries no hosted tool_search (Codex 0.159.0 sends none), so
 * a plan turn's MCP tools load up front. */
export function chatgptPlanCodexArgs(): string[] {
  return [
    "-c", 'model_provider="openai_chatgpt_plan"',
    "-c", 'model_providers.openai_chatgpt_plan.name="ChatGPT plan"',
    "-c", 'model_providers.openai_chatgpt_plan.base_url="https://api.openai.com/v1"',
    "-c", 'model_providers.openai_chatgpt_plan.env_key="OPENMAUSBOT_CHATGPT_TOKEN"',
    "-c", 'model_providers.openai_chatgpt_plan.wire_api="responses"',
    "-c", "model_providers.openai_chatgpt_plan.requires_openai_auth=false",
    "-c", "model_providers.openai_chatgpt_plan.supports_websockets=false",
    "-c", 'cli_auth_credentials_store="ephemeral"',
    "-c", "features.tool_search=false",
    "-c", "shell_environment_policy.ignore_default_excludes=false",
    // OPENMAUSBOT_CHATGPT_TOKEN is excluded via extendShellExclusions: a `-c exclude` here would replace the lower layers' list.
  ];
}
