// The GitHub App's proof of identity: a JSON Web Token signed with its private key (RS256), valid
// for minutes, which GitHub exchanges for a one-hour installation token (lib/github.ts). Pure
// apart from node:crypto, so `node --test` covers it.

import { createSign } from "node:crypto";

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

// iat a minute in the past absorbs clock drift between this server and GitHub; GitHub refuses an
// exp more than ten minutes ahead, so nine leaves room.
export function appJwt(appId: string, privateKeyPem: string, nowSeconds: number): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss: appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${base64url(signer.sign(privateKeyPem))}`;
}

// The key is stored base64-encoded (one line) so that no environment-variable tooling has to keep
// a PEM's line breaks intact. A raw PEM is accepted too, including one whose line breaks a
// dashboard or an env file turned into a literal "\n".
export function decodePrivateKey(stored: string): string {
  const trimmed = stored.trim();
  if (trimmed.startsWith("-----BEGIN")) return trimmed.replaceAll("\\n", "\n");
  return Buffer.from(trimmed, "base64").toString("utf8").trim();
}
