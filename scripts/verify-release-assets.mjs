import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function releaseAssetNames(version) {
  return [
    "latest-linux.yml",
    "latest.yml",
    `OpenMausBot-${version}-amd64.deb`,
    `OpenMausBot-${version}-arm64.dmg`,
    `OpenMausBot-${version}-setup.exe`,
    `OpenMausBot-${version}-setup.exe.blockmap`,
    `OpenMausBot-${version}-x64.dmg`,
    `OpenMausBot-${version}-x86_64.AppImage`,
    "OpenMausBot-amd64.deb",
    "OpenMausBot-intel.dmg",
    "OpenMausBot-setup.exe",
    "OpenMausBot.AppImage",
    "OpenMausBot.dmg",
    "SHA256SUMS-ubuntu-x64.txt",
  ].sort();
}

export function verifyReleaseAssets(directory, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`release version must be X.Y.Z, got: ${version}`);
  const expectedNames = releaseAssetNames(version);
  const actualNames = readdirSync(directory).filter((name) => statSync(resolve(directory, name)).isFile()).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(`unexpected release asset set\nexpected: ${expectedNames.join(", ")}\nactual: ${actualNames.join(", ")}`);
  }
  for (const name of expectedNames) {
    if (statSync(resolve(directory, name)).size === 0) throw new Error(`empty release asset: ${name}`);
  }

  const sha512 = (name) => createHash("sha512").update(readFileSync(resolve(directory, name))).digest("base64");
  const feeds = new Map([
    ["latest.yml", [`OpenMausBot-${version}-setup.exe`]],
    ["latest-linux.yml", [
      `OpenMausBot-${version}-x86_64.AppImage`,
      `OpenMausBot-${version}-amd64.deb`,
    ]],
  ]);
  for (const [feed, expectedUrls] of feeds) {
    const text = readFileSync(resolve(directory, feed), "utf8");
    const entries = [...text.matchAll(/url:\s+(\S+)[\s\S]*?sha512:\s+(\S+)\n\s+size:\s+(\d+)/g)];
    const urls = entries.map(([, url]) => url).sort();
    if (JSON.stringify(urls) !== JSON.stringify([...expectedUrls].sort())) {
      throw new Error(`wrong paths in ${feed}: ${urls.join(", ") || "none"}`);
    }
    for (const [, url, hash, size] of entries) {
      if (sha512(url) !== hash || statSync(resolve(directory, url)).size !== Number(size)) {
        throw new Error(`digest or size mismatch for ${url} in ${feed}`);
      }
    }
  }
  return expectedNames;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , directory, version] = process.argv;
  if (!directory || !version) throw new Error("usage: verify-release-assets.mjs <directory> <version>");
  const names = verifyReleaseAssets(resolve(directory), version);
  console.log(`verified ${names.length} release assets`);
}
