export const SKILL_DIRECTORY_PATCH_PROPERTIES = {
  files: {
    type: "array", maxItems: 1000,
    description: "Supporting-file writes. Unmentioned files stay; empty content writes an empty file. Do not combine with legacy references.",
    items: {
      type: "object", additionalProperties: false,
      properties: {
        path: { type: "string", description: "Path relative to the Skill root, such as scripts/run.py or assets/input.docx." },
        content: { type: "string", description: "UTF-8 text, including an empty file; supply this or attachment_id." },
        attachment_id: { type: "string", description: "Filename of an uploaded attachment in this conversation; no host path or base64." },
        executable: { type: "boolean", description: "Whether the reviewed file is executable." },
      },
      required: ["path"],
    },
  },
  remove_files: { type: "array", maxItems: 1000, items: { type: "string" }, description: "Explicit supporting-file removals relative to the Skill root; cannot remove SKILL.md." },
} as const;
