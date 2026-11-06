export const EXTENSION_PREPARE_TIMEOUT_MS = 180_000;
export const EXTENSION_DEPENDENCY_TIMEOUT_MS = 150_000;
export const RESOURCE_REQUEST_TIMEOUT_MS = 15_000;

export function extensionFetch(fetcher: typeof fetch, signal: AbortSignal, progress?: (bytes: { receivedBytes: number; totalBytes?: number; attempt: number }) => void): typeof fetch {
  const attempts = new Map<string, number>();
  return async (input, init) => {
    signal.throwIfAborted();
    const attempt = (attempts.get(String(input)) ?? 0) + 1;
    if (progress) { attempts.set(String(input), attempt); progress({ receivedBytes: 0, attempt }); }
    const response = await fetcher(input, { ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal });
    if (!progress || !response.ok || !response.body) return response;
    const encoding = response.headers.get("content-encoding");
    const totalBytes = encoding && encoding !== "identity" ? undefined : Number(response.headers.get("content-length")) || undefined;
    let receivedBytes = 0, last = 0;
    const report = () => { last = Date.now(); progress({ receivedBytes, totalBytes, attempt }); };
    report();
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) { receivedBytes += chunk.length; if (Date.now() - last >= 150) report(); controller.enqueue(chunk); },
      flush() { report(); },
    }));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
