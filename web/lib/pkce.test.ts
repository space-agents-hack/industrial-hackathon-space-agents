import assert from "node:assert/strict";
import { test } from "node:test";

import { base64url, challengeS256, decodePending, encodePending, randomToken, sameState } from "./pkce.ts";

test("S256 matches RFC 7636 Appendix B", async () => {
  // The verifier is the base64url of the 32 octets listed in Appendix B.
  const octets = new Uint8Array([
    116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77,
    105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121,
  ]);
  const verifier = base64url(octets);
  assert.equal(verifier, "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
  assert.equal(await challengeS256(verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("a fresh verifier is 43 URL-safe characters and never repeats", () => {
  const a = randomToken(32);
  const b = randomToken(32);
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
});

test("the pending cookie round-trips and rejects anything else", () => {
  const pending = { verifier: randomToken(), state: randomToken(), org: "11111111-1111-4111-8111-111111111111" };
  assert.deepEqual(decodePending(encodePending(pending)), pending);
  assert.equal(decodePending(undefined), null);
  assert.equal(decodePending("not base64 json"), null);
  assert.equal(decodePending(base64url(new TextEncoder().encode(JSON.stringify({ verifier: "v" })))), null);
});

test("states compare exactly", () => {
  assert.equal(sameState("abc", "abc"), true);
  assert.equal(sameState("abc", "abd"), false);
  assert.equal(sameState("abc", "abcd"), false);
  assert.equal(sameState("", ""), false, "an empty state never matches");
});
