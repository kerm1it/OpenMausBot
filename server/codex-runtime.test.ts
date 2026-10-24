import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { codexRuntimeEnvironment, initializeCodexRuntime, linkExternalCodexAuth } from "./codex-runtime.ts";

afterEach(() => rmSync(join(DATA_DIR, "providers"), { recursive: true, force: true }));

it("sets one application home without inheriting or changing a personal home", () => {
  const personal = join(DATA_DIR, "simulated-personal-codex");
  mkdirSync(personal, { recursive: true });
  writeFileSync(join(personal, "config.toml"), "# personal sentinel\n");
  const env = { CODEX_HOME: personal, LABEL: "kept" };
  expect(codexRuntimeEnvironment({}).CODEX_HOME).toBe(join(DATA_DIR, "providers", "codex"));
  expect(codexRuntimeEnvironment(env)).toMatchObject({ CODEX_HOME: join(DATA_DIR, "providers", "codex"), LABEL: "kept" });
  expect(env.CODEX_HOME).toBe(personal);
  expect(readFileSync(join(personal, "config.toml"), "utf8")).toBe("# personal sentinel\n");
});

it("refuses a provider-directory symlink before creating files outside the workspace", () => {
  const outside = mkdtempSync(join(tmpdir(), "omb-codex-outside-"));
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    symlinkSync(outside, join(DATA_DIR, "providers"), process.platform === "win32" ? "junction" : "dir");
    expect(() => initializeCodexRuntime()).toThrow("inside its data directory");
    expect(existsSync(join(outside, "codex"))).toBe(false);
  } finally { rmSync(outside, { recursive: true, force: true }); }
});

it("continuously follows external login replacement, logout and native refresh through one credential link", () => {
  const source = join(DATA_DIR, "external-login"), runtime = codexRuntimeEnvironment({}).CODEX_HOME;
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "config.toml"), "# external configuration\n");
  const auth = join(source, "auth.json"), linked = join(runtime, "auth.json");
  writeFileSync(auth, "first-login");
  linkExternalCodexAuth(runtime, source);
  expect(lstatSync(linked).isSymbolicLink()).toBe(true);
  writeFileSync(join(source, "replacement"), "second-login");
  renameSync(join(source, "replacement"), auth);
  expect(readFileSync(linked, "utf8")).toBe("second-login");
  writeFileSync(linked, "native-refreshed-login");
  expect(readFileSync(auth, "utf8")).toBe("native-refreshed-login");
  unlinkSync(auth);
  linkExternalCodexAuth(runtime, source);
  expect(existsSync(linked)).toBe(false);
  expect(lstatSync(linked).isSymbolicLink()).toBe(true);
  writeFileSync(auth, "signed-in-again");
  expect(readFileSync(linked, "utf8")).toBe("signed-in-again");
  expect(readFileSync(join(source, "config.toml"), "utf8")).toBe("# external configuration\n");
  expect(() => linkExternalCodexAuth(runtime, runtime)).toThrow("separate absolute");
  writeFileSync(join(source, "config.toml"), 'cli_auth_credentials_store = "keyring"\n');
  expect(() => linkExternalCodexAuth(runtime, source)).toThrow("non-file credential store");
});
