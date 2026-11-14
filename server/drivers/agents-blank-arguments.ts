import type { Json } from "./agents-client.ts";

function jsonRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const BLANK_MEANS_LEFT_OUT: Readonly<Record<string, readonly string[]>> = {
  coordinate_bots: ["group_id", "reason", "thread", "title", "reply", "done_when", "answers"],
  session_search: ["thread_id", "message_id", "query", "since", "until", "scope"],
  show_html: ["html", "jsx", "path"],
  memory_update: ["until"],
};

const blankText = (value: unknown) => typeof value === "string" && !value.trim();
const blankOrNull = (value: unknown) => value === null || blankText(value);

function withoutBlank(record: Json, keys: readonly string[], blank: (value: unknown) => boolean = blankOrNull): Json {
  const out: Json = { ...record };
  for (const key of keys) if (blank(out[key])) delete out[key];
  return out;
}

function withoutBlankModelChoice(selection: unknown): unknown {
  return jsonRecord(selection) ? withoutBlank(selection, ["effort", "variant"]) : selection;
}

function withoutBlankTeamSetupFields(input: Json): Json {
  if (!Array.isArray(input.operations)) return input;
  return {
    ...input,
    operations: input.operations.map((operation) => {
      if (!jsonRecord(operation)) return operation;
      const out = withoutBlank(operation, operation.action === "create" ? ["botId"] : operation.action === "update" ? ["key"] : []);
      if (jsonRecord(out.fields)) {
        const fields = withoutBlank(out.fields, Object.keys(out.fields), (value) => value === null);
        if (fields.modelSelection !== undefined) fields.modelSelection = withoutBlankModelChoice(fields.modelSelection);
        out.fields = fields;
      }
      return out;
    }),
  };
}

const MODEL_CHOICE_ARGUMENT: Readonly<Record<string, string>> = { create_bot: "modelSelection", propose_model: "model_selection", start_thread: "model_selection" };

export function dropBlankArguments(name: string, input: Json): Json {
  if (!jsonRecord(input)) return input;
  if (name === "propose_team_setup") return withoutBlankTeamSetupFields(input);
  const selectionKey = Object.hasOwn(MODEL_CHOICE_ARGUMENT, name) ? MODEL_CHOICE_ARGUMENT[name] : undefined;
  if (selectionKey && input[selectionKey] !== undefined) return { ...input, [selectionKey]: withoutBlankModelChoice(input[selectionKey]) };
  const keys = Object.hasOwn(BLANK_MEANS_LEFT_OUT, name) ? BLANK_MEANS_LEFT_OUT[name] : undefined;
  return keys ? withoutBlank(input, keys, blankText) : input;
}
