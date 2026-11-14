export const SELECT_COMPUTER_SURFACE = {
  type: "string",
  enum: ["auto", "cloud", "vm", "local", "browser"],
  description: "auto = suitable configured computer, cloud = the bot's cloud computer or self-hosted VPS, vm = isolated Local VM, local = user's own desktop, browser = built-in browser. Omit to list.",
} as const;

export const CLOUD_HOME_COMPUTER_SURFACE = {
  type: "string",
  enum: ["auto", "cloud", "browser"],
  description: "auto = suitable configured computer, cloud = the bot's cloud computer, browser = built-in browser. Omit to list. This server runs in the cloud: the user's own computer and a Local VM are not places here.",
} as const;
