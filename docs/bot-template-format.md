# Bot extension interchange

OpenMausBot imports one bot or native plugin from a complete resource directory or ZIP/TAR archive. The marketplace stores resources under `extensions/<source>/bots|plugins/<id>/`. The built-in source is `kerm1it/grok-bot-exts`, default branch `main`.

Native plugin installation requires an HTTP(S) source. Local archive selection imports bot templates; a local Grok plugin metadata JSON may identify a remote implementation to download.

## Manifest and resource roots

OpenMausBot resources use the marketplace's `extension.json`, `schemaVersion: 1`. Entry points are paths relative to the extension root. There is no required `files` index. Import preserves the complete target directory, including hidden directories and supporting Skill files.

GitHub directory sources download a repository ZIP snapshot directly from `codeload.github.com`, using the supplied branch, tag or commit, or `HEAD` when no ref is supplied. Only the selected directory is extracted. Network traffic includes the repository archive, with a 64 MiB download limit; unrelated directories are not installed. This path does not use the GitHub REST API. Grok marketplace IDs download their self-contained `recipe.json` or plugin metadata directly from `raw.githubusercontent.com`, then resolve any external implementation sources.

Preparing a preview has a three-minute overall budget, and each plugin dependency has a 150-second budget. GitHub ZIP downloads use system `curl` when available, streaming received bytes into the progress response; systems without `curl` use fetch against the same direct URL. Curl ignores personal configuration, stops stalled transfers, and allows up to two minutes for an active archive download. Transient download failures are retried once within the overall budgets. An unavailable dependency is shown in the preview and requires explicit omission before creating the bot. Closing the dialog cancels its downloads and removes temporary preparation files.

The desktop opts into newline-delimited JSON progress on the preparation endpoint. Events identify template download, Skill processing, the active plugin, received bytes and retry attempts, followed by the prepared preview or an error. Clients without the streaming Accept header retain the ordinary JSON response.

`entrypoints.skills` identifies each `SKILL.md`; its parent directory is the Skill root. References, scripts, assets, empty files, nested paths and executable bits belong to that Skill. Import creates a bot-private copy without copying approval or modifying a same-named shared library item.

Bot plugin dependencies are `{ "id": "native-plugin-name", "optional": false, "source": "https://..." }`. `source` is optional. Without it the ID resolves through the OpenMausBot marketplace plugin directory. With it the actual native plugin name must still match `id`. Descriptive `sourceUrl` and `repositoryUrl` are not installation instructions. Marketplace publication additionally requires the referenced plugin entry, including optional dependencies.

A native plugin contains at least one of `plugin.json`, `.codex-plugin/plugin.json`, `.claude-plugin/plugin.json`, `.cursor-plugin/plugin.json`. Multiple host manifests are valid when every `name` equals the marketplace ID; preserve their host-specific declarations. The entire extension directory is the installation root. A Grok marketplace plugin record is source metadata, not a native plugin package.

## Profile

`entrypoints.profile` references a UTF-8 JSON document:

```json
{
  "schemaVersion": 1,
  "profile": {
    "name": "Research Assistant",
    "description": "Research and prepare reports.",
    "soul": "Read the research skill before starting."
  },
  "requirements": [
    { "kind": "app", "name": "GitHub", "description": "Connect an account after import." }
  ]
}
```

Portable profile fields are `name`, `title`, `description`, `soul`, `color`, `mascotBody`, `mascotExpression`, `avatar`, `avatarCrop`, `avatarZoom`, `avatarFocusX`, `avatarFocusY`. `avatar` is a marketplace file reference, never a host attachment path. `avatarCrop` is `mascot`, `circle`, `rounded` or `square`; zoom is 1–3 and focus coordinates are 0–1. Requirement kinds are `app` and `mcp-server`, with a name and optional description. Requirements do not carry credentials, grants or executable configuration.

The name is required, single-line, at most 100 characters. Title is single-line, at most 200 characters; description at most 4,000 characters; soul at most 24,000 UTF-8 bytes. Runtime validation enforces the byte limit in addition to JSON Schema validation.

Model instances, accounts, approval levels, bot/room IDs, working directories and runtime homes are not portable fields. The importing workspace supplies them through its ordinary creation policy.

## Memory

Memory entry points identify optional UTF-8 seed files. Import is a new bot copy, not a merge into an existing bot. The user chooses whether to include memory; conversation logs, daily history and credential stores are not template memory.

## Routines

Each `entrypoints.routines` file is a UTF-8 JSON document with `schemaVersion: 1`, `name`, `prompt`, `schedule`, and optional `durationMinutes`, `timeoutMinutes`, `overlap`, `attachments`. There are no runtime IDs or `enabled` fields. Import creates a new bot-owned routine, always paused.

Schedule variants match the application's portable schedules:

- `{ "type": "cron", "expression": "0 9 * * 1-5", "timeZone": "Asia/Shanghai" }` uses five-field cron and an explicit IANA timezone.
- `{ "type": "daily", "time": "09:00", "weekdays": [1,2,3,4,5] }` uses the importing workspace's local timezone.
- `{ "type": "interval", "everyMinutes": 60, "anchorAt": 1792800000000 }` may include local `weekdays`, `window: { "start": "09:00", "end": "18:00" }`, and epoch-millisecond `endsAt`.
- `{ "type": "once", "at": 1792800000000 }` carries epoch milliseconds. A paused imported schedule may need editing before enablement.

Daily weekday values are Sunday=0 through Saturday=6. Intervals are 5–1,440 minutes. Application schedule validation still applies before creation; an engine-specific limit-reset schedule needs configuration in the importing workspace rather than replaying an external instance ID.

Routine attachments are `{ "path": "assets/routines/input.csv", "name": "input.csv", "kind": "file" }`, with optional `size`, `sha256`, `mediaType`. All paths are extension-root relative. Import copies bytes into new attachment records and never reuses the original machine's path or ID. Names are at most 80 characters, prompts at most 20,000; each routine has at most 50 attachments. Duration is 5–240 minutes, timeout 1–1,440, overlap `skip` or `queue`.

The executable schemas and runtime types are defined by `shared/bot-template-format.ts`; exported JSON Schemas are generated from that source for marketplace validation.

## Import links

```text
openmausbot://app/v1/import?type=bot&source=openmausbot&id=research-assistant
openmausbot://app/v1/import?type=plugin&source=grok-bot&id=9717366
openmausbot://app/v1/import?type=plugin&source=openmausbot&url=<encoded-https-source>
```

`type` is `bot` or `plugin`; `source` is `openmausbot` or `grok-bot`. Supply exactly one of `id` and `url`. ID is the native resource directory ID, not a normalized catalog display ID. URL input accepts recognized GitHub repository/directory/manifest addresses and HTTP(S) resource archives. Grok share URLs and original Grok deep links are handled by the Grok adapter. An arbitrary web page is not a package.

Users do not enter a marketplace URL, branch or commit. The application resolves a market ID automatically. Explicit refs in manually supplied addresses or upstream metadata are honored; there is no mandatory commit-locking step. Preview and confirmation use the same downloaded snapshot. Receiving a link never executes code or enables routines.

The legacy `openmausbot://install?url=...` remains supported. OpenMausBot does not register itself as the operating system's `grokbot://` handler; original Grok links can be pasted into the import dialog or wrapped in an OpenMausBot link.

The Grok adapter converts human-readable Skill names to portable names and expands YAML multiline descriptions before local validation. It preserves Skill bodies, other frontmatter metadata and supporting files; already portable `SKILL.md` files remain unchanged.

## Native Skill directories

Private and shared Skills retain the complete reviewed directory, including binary assets and executable modes. Updates and Undo select whole-directory revisions. Old single-file approvals do not authorize newly discovered scripts or attachments; those files remain available for a fresh directory review.

Each active conversation captures its Skill revisions and publishes native links in its task workspace. App-managed native links in the bot's root workspace are removed so they cannot compete with a conversation's captured revision. Read and export APIs use the selected source directory directly. Claude and Cursor load a task workspace through their native additional-directory option when the working directory differs; Codex uses its per-process native extra Skill roots. The person's working directory is preserved.
