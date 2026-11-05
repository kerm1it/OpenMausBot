import { expect, it } from "vitest";
import { grokBotRecipe, grokExportBots } from "./grok-export-input.ts";

it("keeps each bot selectable instead of silently taking the first", () => {
  const bots = grokExportBots({ format: "grok-bot-export", version: 1, bots: [
    { name: "Alpha", instructions: "First" }, { name: "Beta", instructions: "Second" },
  ] });
  expect(bots?.map(bot => grokBotRecipe(bot).persona.instructions)).toEqual(["First", "Second"]);
});

it("keeps textual skills, user facts and event instructions without treating apps as native plugins", () => {
  const [bot] = grokExportBots(JSON.stringify({ format: "grok-bot-export", version: 1, bots: [{
    name: "Fixture", instructions: "Help", user_facts: ["Uses UTC"],
    skills: [{ name: "Summarize", instructions: "Read the input" }],
    routines: [{ name: "On push", instruction: "Review the patch", trigger: "github", trigger_details: "Repository push" }],
    apps: [{ name: "Notes", mcp_url: "https://example.test/mcp", headers: { Authorization: "" } }],
  }] }))!;
  const recipe = grokBotRecipe(bot!);
  expect(recipe.skills[0]?.content).toBe("Read the input");
  expect(recipe.memories).toContain("Uses UTC");
  expect(recipe.memories.join("\n")).toContain("Review the patch");
  expect(recipe.apps[0]?.mcpUrl).toBe("https://example.test/mcp");
  expect(recipe.routines).toEqual([]);
  expect(recipe).not.toHaveProperty("plugins");
});

it("leaves recipe and market inputs to the existing resolver", () => {
  expect(grokExportBots({ name: "Recipe", instructions: "Help" })).toBeNull();
  expect(grokExportBots("https://x.ai/bot/_jOdbfkB16zxu7MRcmReE")).toBeNull();
});
