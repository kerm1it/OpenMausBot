export function validateBaseUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid OpenMausBot URL: '${url}'`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("OpenMausBot URL must use http:// or https://");
  }
  if (parsed.username || parsed.password) {
    throw new Error("OpenMausBot URL must not contain credentials; use OPENMAUSBOT_TOKEN instead");
  }
  if ((parsed.pathname !== "/" && parsed.pathname !== "") || parsed.search || parsed.hash) {
    throw new Error("OpenMausBot URL must be an origin without a path, query, or fragment");
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const isLoopback = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  if (parsed.protocol === "http:" && !isLoopback && process.env.ALLOW_INSECURE_HTTP !== "true") {
    throw new Error(
      `Insecure cleartext HTTP origin '${parsed.origin}' is rejected. Use https:// or set ALLOW_INSECURE_HTTP=true.`,
    );
  }
  return parsed.origin;
}
