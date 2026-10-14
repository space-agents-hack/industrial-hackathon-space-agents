// OAuth PKCE (RFC 7636) for "Connect OpenRouter". Web Crypto only, so the same code runs in a
// route handler and in `node --test`.

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// 32 random bytes give a 43-character verifier, the minimum RFC 7636 allows and the length its
// own example uses. Also used for `state`, which only has to be unguessable.
export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

// S256: BASE64URL(SHA256(ASCII(code_verifier))). "plain" is never used: it would hand the
// verifier itself to anyone who reads the redirect URL.
export async function challengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

// What the start route keeps in a short-lived cookie for the callback to check.
export type PkcePending = { verifier: string; state: string; org: string };

export function encodePending(pending: PkcePending): string {
  return base64url(new TextEncoder().encode(JSON.stringify(pending)));
}

export function decodePending(value: string | undefined): PkcePending | null {
  if (!value) return null;
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as PkcePending).verifier === "string" &&
      typeof (parsed as PkcePending).state === "string" &&
      typeof (parsed as PkcePending).org === "string"
    ) {
      const { verifier, state, org } = parsed as PkcePending;
      return { verifier, state, org };
    }
  } catch {
    // A cookie that does not decode is treated like no cookie.
  }
  return null;
}

// Compared in constant time, so the check does not leak how much of a guessed state matched.
export function sameState(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
