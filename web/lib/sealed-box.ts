// GitHub accepts a secret only encrypted to the repository's public key with libsodium's
// "sealed box" (docs.github.com, REST API, Actions secrets). A sealed box is a one-off X25519 key
// pair plus NaCl's box, with the nonce derived from both public keys; written out here on top of
// two small audited libraries instead of pulling in libsodium's WebAssembly build.

import { blake2b } from "@noble/hashes/blake2.js";
import nacl from "tweetnacl";

function nonceFor(ephemeralPublicKey: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array {
  const both = new Uint8Array(64);
  both.set(ephemeralPublicKey, 0);
  both.set(recipientPublicKey, 32);
  return blake2b(both, { dkLen: nacl.box.nonceLength });
}

// `publicKey` and the result are base64, as GitHub sends and expects them.
export function sealForGitHub(value: string, publicKey: string): string {
  const recipient = Buffer.from(publicKey, "base64");
  if (recipient.length !== nacl.box.publicKeyLength) throw new Error("Not a repository public key.");
  const ephemeral = nacl.box.keyPair();
  const boxed = nacl.box(
    new TextEncoder().encode(value),
    nonceFor(ephemeral.publicKey, recipient),
    recipient,
    ephemeral.secretKey,
  );
  return Buffer.concat([ephemeral.publicKey, boxed]).toString("base64");
}

// Only for the test: what GitHub does with the private key it keeps.
export function openSealed(sealed: string, publicKey: Uint8Array, secretKey: Uint8Array): string | null {
  const bytes = Buffer.from(sealed, "base64");
  const ephemeralPublicKey = bytes.subarray(0, 32);
  const opened = nacl.box.open(bytes.subarray(32), nonceFor(ephemeralPublicKey, publicKey), ephemeralPublicKey, secretKey);
  return opened ? new TextDecoder().decode(opened) : null;
}
