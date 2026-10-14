// Shared by the two routes of "Connect OpenRouter" and by the Providers page, which turns the
// result code in the URL back into a sentence. Pure.

export const OPENROUTER_AUTH_URL = "https://openrouter.ai/auth";
export const OPENROUTER_KEYS_URL = "https://openrouter.ai/api/v1/auth/keys";
export const OPENROUTER_CALLBACK_PATH = "/api/admin/providers/openrouter/callback";
export const OPENROUTER_PKCE_COOKIE = "openrouter_pkce";
// OpenRouter's code expires after 10 minutes; the cookie lasts as long and no longer.
export const OPENROUTER_PKCE_MAX_AGE_S = 600;

// The callback redirects with one of these in `?openrouter=`. A code, not a message, so nothing
// from OpenRouter's answer (or from a forged URL) is ever printed on the page.
export const OPENROUTER_RESULTS = {
  connected: "OpenRouter is connected. Runs with OpenRouter models now bill the OpenRouter account that approved it.",
  denied: "OpenRouter was not connected: the request was cancelled or denied on OpenRouter.",
  expired: "OpenRouter was not connected: the attempt expired or was started in another browser. Try again.",
  state: "OpenRouter was not connected: the answer did not match the request that was sent. Try again.",
  exchange: "OpenRouter was not connected: OpenRouter did not hand over a key. Try again in a minute.",
  forbidden: "OpenRouter was not connected: only an admin of this organisation can connect providers.",
  store: "OpenRouter approved the connection, but the key could not be stored. Try again.",
} as const;
export type OpenRouterResult = keyof typeof OPENROUTER_RESULTS;

export function openRouterResultMessage(code: unknown): { ok: boolean; message: string } | null {
  // Own keys only: `"toString" in OPENROUTER_RESULTS` is true.
  if (typeof code !== "string" || !Object.hasOwn(OPENROUTER_RESULTS, code)) return null;
  return { ok: code === "connected", message: OPENROUTER_RESULTS[code as OpenRouterResult] };
}

// The origin the browser actually used. `request.nextUrl.origin` is not it: under `next dev
// --hostname 127.0.0.1` it reports http://localhost:3020, and cookies are per host, so the
// callback would arrive without the PKCE cookie or the session. The Host header is what the
// browser sent (Vercel sets x-forwarded-host and x-forwarded-proto to the public ones). A forged
// Host only changes where the forger's own browser is sent back to.
export function requestOrigin(headers: Headers, fallback: URL): string {
  const host = headers.get("x-forwarded-host")?.split(",")[0].trim() || headers.get("host");
  if (!host || !/^[A-Za-z0-9.-]+(:\d+)?$|^\[[0-9a-fA-F:]+\](:\d+)?$/.test(host)) return fallback.origin;
  const proto = headers.get("x-forwarded-proto")?.split(",")[0].trim() || fallback.protocol.replace(/:$/, "");
  return `${proto === "https" ? "https" : "http"}://${host}`;
}

export function openRouterAuthUrl(origin: string, challenge: string, state: string): string {
  const params = new URLSearchParams({
    callback_url: `${origin}${OPENROUTER_CALLBACK_PATH}`,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  return `${OPENROUTER_AUTH_URL}?${params}`;
}
