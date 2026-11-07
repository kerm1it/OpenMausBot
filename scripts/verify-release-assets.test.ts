import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { releaseAssetNames, verifyReleaseAssets } from "./verify-release-assets.mjs";

const version = "1.2.3";
const directories: string[] = [];

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "openmausbot-release-assets-"));
  directories.push(directory);
  for (const name of releaseAssetNames(version)) writeFileSync(join(directory, name), name);
  const entry = (name: string) => {
    const bytes = readFileSync(join(directory, name));
    return `  - url: ${name}\n    sha512: ${createHash("sha512").update(bytes).digest("base64")}\n    size: ${bytes.length}\n`;
  };
  writeFileSync(join(directory, "latest.yml"), `files:\n${entry(`OpenMausBot-${version}-setup.exe`)}`);
  writeFileSync(join(directory, "latest-linux.yml"), `files:\n${entry(`OpenMausBot-${version}-x86_64.AppImage`)}${entry(`OpenMausBot-${version}-amd64.deb`)}`);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("release asset verification", () => {
  it("accepts unsigned macOS DMGs with Windows and Linux update feeds", () => {
    expect(verifyReleaseAssets(fixture(), version)).toEqual(releaseAssetNames(version));
  });

  it("rejects a macOS updater feed or any other unexpected artifact", () => {
    const directory = fixture();
    writeFileSync(join(directory, "latest-mac.yml"), "files: []\n");
    expect(() => verifyReleaseAssets(directory, version)).toThrow(/unexpected release asset set/);
  });

  it("rejects feed metadata that does not match the packaged bytes", () => {
    const directory = fixture();
    writeFileSync(join(directory, `OpenMausBot-${version}-setup.exe`), "changed");
    expect(() => verifyReleaseAssets(directory, version)).toThrow(/digest or size mismatch/);
  });
});
