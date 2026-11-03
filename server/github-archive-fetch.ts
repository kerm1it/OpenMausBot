import { spawn } from "node:child_process";

export const githubArchiveFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== "https://codeload.github.com" || (init?.method && init.method !== "GET")) return fetch(input, init);
  init?.signal?.throwIfAborted();
  const child = spawn("curl", ["--disable", "--fail", "--silent", "--show-error", "--location", "--max-redirs", "5", "--proto", "=https", "--proto-redir", "=https", "--connect-timeout", "8", "--max-time", "120", "--speed-limit", "1024", "--speed-time", "15", "--max-filesize", String(64 * 1024 * 1024), "--user-agent", "OpenMausBot-extension-import", "--", url.href], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  try {
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fetch(input, init);
    throw error;
  }
  let stderr = "", closed = false;
  const stop = () => { child.kill(); child.stdout.destroy(); child.stderr.destroy(); };
  child.stderr.on("data", chunk => { if (stderr.length < 2048) stderr += String(chunk); });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const finish = (error?: unknown) => {
        if (closed) return;
        closed = true;
        init?.signal?.removeEventListener("abort", abort);
        if (error) controller.error(error); else controller.close();
      };
      const abort = () => { stop(); finish(init?.signal?.reason); };
      child.stdout.on("data", chunk => { if (!closed) { controller.enqueue(chunk); if ((controller.desiredSize ?? 0) <= 0) child.stdout.pause(); } });
      child.stdout.on("error", error => finish(error));
      child.once("close", code => {
        if (code === 0) return finish();
        if (init?.signal?.aborted) return finish(init.signal.reason);
        if (code === 28) return finish(new DOMException("GitHub archive download timed out", "TimeoutError"));
        if (code === 63) return finish(Object.assign(new Error("GitHub archive exceeds the download budget"), { status: 413 }));
        const status = code === 22 ? Number(stderr.match(/error:\s*(\d{3})/)?.[1]) || 502 : 502;
        finish(Object.assign(new Error(`GitHub archive download failed${status ? ` (HTTP ${status})` : ""}`), { status }));
      });
      init?.signal?.addEventListener("abort", abort, { once: true });
      if (init?.signal?.aborted) abort();
    },
    pull() { child.stdout.resume(); },
    cancel() { closed = true; stop(); },
  });
  return new Response(body);
};
