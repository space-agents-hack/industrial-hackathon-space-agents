import assert from "node:assert/strict";
import { test } from "node:test";

import nacl from "tweetnacl";

import { openSealed, sealForGitHub } from "./sealed-box.ts";

test("a sealed value opens only with the repository's private key", () => {
  const repo = nacl.box.keyPair();
  const sealed = sealForGitHub("pässwörd with spaces", Buffer.from(repo.publicKey).toString("base64"));
  assert.equal(openSealed(sealed, repo.publicKey, repo.secretKey), "pässwörd with spaces");

  const other = nacl.box.keyPair();
  assert.equal(openSealed(sealed, other.publicKey, other.secretKey), null);
});

test("each sealing is different, so equal values cannot be spotted", () => {
  const repo = nacl.box.keyPair();
  const key = Buffer.from(repo.publicKey).toString("base64");
  assert.notEqual(sealForGitHub("same", key), sealForGitHub("same", key));
});

test("a key that is not 32 bytes is refused", () => {
  assert.throws(() => sealForGitHub("x", Buffer.from("short").toString("base64")));
});
