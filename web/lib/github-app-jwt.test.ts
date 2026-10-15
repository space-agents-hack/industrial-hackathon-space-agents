import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";

import { appJwt, decodePrivateKey } from "./github-app-jwt.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

test("the token is signed with the app's key and says which app it is", () => {
  const token = appJwt("123456", pem, 1_800_000_000);
  const [header, payload, signature] = token.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url").toString()), {
    iat: 1_800_000_000 - 60,
    exp: 1_800_000_000 + 540,
    iss: "123456",
  });
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${header}.${payload}`);
  assert.ok(verifier.verify(publicKey, Buffer.from(signature, "base64url")));
});

test("GitHub's ten-minute limit is respected", () => {
  const payload = JSON.parse(Buffer.from(appJwt("1", pem, 1000).split(".")[1], "base64url").toString());
  assert.ok(payload.exp - 1000 < 600);
});

test("the stored key may be base64 or a raw PEM", () => {
  assert.equal(decodePrivateKey(Buffer.from(pem).toString("base64")), pem.trim());
  assert.equal(decodePrivateKey(`  ${pem}`), pem.trim());
  assert.equal(decodePrivateKey(pem.trim().replaceAll("\n", "\\n")), pem.trim());
});
