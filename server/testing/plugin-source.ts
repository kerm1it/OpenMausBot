// Loopback-only archive sources for verification. Production installation still
// downloads over HTTP; no test-only filesystem bypass exists in PluginLibrary.
import { lstatSync, readFileSync, readlinkSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { zipSync, strToU8, type Zippable } from "fflate";

export function fixturePluginArchive(source: string): Uint8Array {
  if (lstatSync(source).isFile()) return readFileSync(source);
  const entries: Zippable = {};
  function walk(dir: string, prefix = "") {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name), key = prefix + name, stat = lstatSync(path);
      if (stat.isSymbolicLink()) entries[key] = [strToU8(readlinkSync(path)), { os: 3, attrs: 0o120777 << 16 }];
      else if (stat.isDirectory()) { entries[`${key}/`] = new Uint8Array(); walk(path, `${key}/`); }
      else entries[key] = [readFileSync(path), { os: 3, attrs: stat.mode << 16 }];
    }
  }
  walk(source);
  return zipSync(entries);
}

export async function createPluginSourceServer() {
  const sources = new Map<string, string>();
  const server = createServer((req, res) => {
    const source = sources.get(req.url ?? "");
    if (!source) { res.writeHead(404).end(); return; }
    try {
      const bytes = fixturePluginArchive(source);
      res.writeHead(200, { "content-type": "application/zip", "content-length": bytes.length }).end(bytes);
    } catch { res.writeHead(500).end("Fixture archive unavailable"); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as { port: number }).port;
  return {
    urlFor(source: string) {
      const existing = [...sources].find(([, path]) => path === source)?.[0];
      const route = existing ?? `/plugin-${sources.size + 1}.zip`;
      sources.set(route, source);
      return `http://127.0.0.1:${port}${route}`;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
