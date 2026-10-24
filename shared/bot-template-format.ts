import { z } from "zod";
import { botAvatarCropSchema } from "./bot-avatar.ts";
import { botBodySchema } from "./bot-body.ts";
import { BOT_PROFILE_LIMITS, fitsOnOneLine } from "./bot-profile.ts";
import { pluginIdSchema, pluginSourceSchema } from "./plugins.ts";

/** File references are relative to the extension root, including routine attachments and avatar images. */
export const templatePathSchema = z.string().min(1).max(2048).refine(value =>
  !value.startsWith("/") && !value.includes("\\") && !value.includes("\0") &&
  !/^[a-zA-Z]:/.test(value) && value.split("/").every(part => part !== ".." && part !== "." && Boolean(part)),
"Use a file path relative to the extension directory");

export const templateFileReferenceSchema = z.object({
  path: templatePathSchema,
  mediaType: z.string().min(1).max(200).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  size: z.number().int().nonnegative().optional(),
}).strict();

const localizedText = z.object({ en: z.string(), zh: z.string().optional() }).strict();
const files = z.array(templateFileReferenceSchema).max(500);
const publisher = z.object({ name: z.string().min(1).max(200), url: z.string().url().optional(), logoUrl: z.string().url().optional() }).strict();
const extensionMetadata = {
  schemaVersion: z.literal(1), id: pluginIdSchema,
  name: localizedText, summary: localizedText, description: localizedText.optional(),
  publisher, official: z.literal(false).optional(), category: z.string().min(1).max(100),
  tags: z.array(z.string().max(100)).max(100), license: z.string().max(100).optional(),
  updatedAt: z.string().datetime().optional(), sourceUrl: z.string().url().optional(), repositoryUrl: z.string().url().optional(),
};

export const templatePluginDependencySchema = z.object({
  id: pluginIdSchema, optional: z.boolean(), source: pluginSourceSchema.optional(),
}).strict();

/** Marketplace manifests describe entry points; the complete resource directory carries supporting files. */
export const botExtensionSchema = z.object({
  ...extensionMetadata,
  plugins: z.array(templatePluginDependencySchema).max(100),
  entrypoints: z.object({
    profile: templateFileReferenceSchema, skills: files, memory: files, routines: files, assets: files.optional(),
  }).strict(),
}).strict();

export const pluginExtensionSchema = z.object({
  ...extensionMetadata,
  entrypoints: z.object({ skills: files, commands: files.optional(), hooks: files.optional(), tools: files.optional(), assets: files.optional() }).strict(),
}).strict();

export const templateRequirementSchema = z.object({
  kind: z.enum(["app", "mcp-server"]), name: z.string().trim().min(1).max(200), description: z.string().max(4000).optional(),
}).strict();

/** Portable profile fields never include account IDs, model instances, execution grants or host paths. */
export const botTemplateProfileSchema = z.object({
  schemaVersion: z.literal(1),
  profile: z.object({
    name: z.string().trim().min(1).max(BOT_PROFILE_LIMITS.name).refine(fitsOnOneLine),
    title: z.string().max(BOT_PROFILE_LIMITS.title).refine(fitsOnOneLine).optional(),
    description: z.string().max(BOT_PROFILE_LIMITS.description).optional(),
    soul: z.string().refine(value => new TextEncoder().encode(value).length <= BOT_PROFILE_LIMITS.soul, "Standing instructions exceed 24,000 bytes").optional(),
    color: z.string().max(60).optional(), mascotBody: botBodySchema.optional(), mascotExpression: z.string().max(60).optional(),
    avatar: templateFileReferenceSchema.optional(), avatarCrop: botAvatarCropSchema.optional(),
    avatarZoom: z.number().min(1).max(3).optional(), avatarFocusX: z.number().min(0).max(1).optional(), avatarFocusY: z.number().min(0).max(1).optional(),
  }).strict(),
  requirements: z.array(templateRequirementSchema).max(100).optional(),
}).strict();

const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const weekdays = z.array(z.number().int().min(0).max(6)).min(1).max(7);
const timestamp = z.number().int().nonnegative().max(8_640_000_000_000_000);

/** Cron carries its IANA timezone. Daily and interval windows use the importing workspace's local timezone. */
export const templateRoutineScheduleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("once"), at: timestamp }).strict(),
  z.object({ type: z.literal("daily"), time: clock, weekdays }).strict(),
  z.object({
    type: z.literal("interval"), everyMinutes: z.number().int().min(5).max(1440), anchorAt: timestamp,
    weekdays: weekdays.optional(), window: z.object({ start: clock, end: clock }).strict().optional(), endsAt: timestamp.optional(),
  }).strict(),
  z.object({ type: z.literal("cron"), expression: z.string().min(1).max(256), timeZone: z.string().min(1).max(128) }).strict(),
]);

/** Routine templates contain no live IDs or enablement; import always creates a paused bot-owned routine. */
export const botTemplateRoutineSchema = z.object({
  schemaVersion: z.literal(1), name: z.string().trim().min(1).max(80), prompt: z.string().trim().min(1).max(20_000),
  schedule: templateRoutineScheduleSchema,
  durationMinutes: z.number().int().min(5).max(240).optional(), timeoutMinutes: z.number().min(1).max(1440).optional(),
  overlap: z.enum(["skip", "queue"]).optional(),
  attachments: z.array(templateFileReferenceSchema.extend({ name: z.string().min(1).max(255), kind: z.enum(["file", "image"]) }).strict()).max(50).optional(),
}).strict();

export type BotExtension = z.infer<typeof botExtensionSchema>;
export type PluginExtension = z.infer<typeof pluginExtensionSchema>;
export type BotTemplateProfile = z.infer<typeof botTemplateProfileSchema>;
export type BotTemplateRoutine = z.infer<typeof botTemplateRoutineSchema>;
export type TemplatePluginDependency = z.infer<typeof templatePluginDependencySchema>;
export type TemplateFileReference = z.infer<typeof templateFileReferenceSchema>;
export type TemplateRequirement = z.infer<typeof templateRequirementSchema>;
