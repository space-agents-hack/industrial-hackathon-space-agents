import assert from "node:assert/strict";
import { test } from "node:test";

import { type RequestFacts, refuseUnlessLocal, refuseUnlessLocalReturn } from "./local-request.ts";

const ok: RequestFacts = {
  onVercel: false,
  nodeEnv: "development",
  loopbackOnly: true,
  method: "POST",
  host: "localhost:3000",
  origin: "http://localhost:3000",
  contentType: "application/json",
  fetchSite: "same-origin",
};

test("a POST from the local page is allowed, on either loopback name", () => {
  assert.equal(refuseUnlessLocal(ok), null);
  assert.equal(
    refuseUnlessLocal({ ...ok, host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" }),
    null,
  );
});

test("the endpoints do not exist in a build or on Vercel", () => {
  assert.equal(refuseUnlessLocal({ ...ok, onVercel: true }), 404);
  assert.equal(refuseUnlessLocal({ ...ok, nodeEnv: "production" }), 404);
  assert.equal(refuseUnlessLocal({ ...ok, nodeEnv: undefined }), 404);
});

test("a dev server that may listen on the network does not offer them at all", () => {
  // Started without the package.json script (for example `npx next dev`): a machine on the same
  // network could send a forged Host and Origin, so no header check is trusted.
  assert.equal(refuseUnlessLocal({ ...ok, loopbackOnly: false }), 404);
});

test("another machine or a rebinding domain is refused by the Host header", () => {
  assert.equal(refuseUnlessLocal({ ...ok, host: "192.168.1.20:3000" }), 403);
  assert.equal(refuseUnlessLocal({ ...ok, host: "attacker.example:3000" }), 403);
  assert.equal(refuseUnlessLocal({ ...ok, host: "localhost.attacker.example" }), 403);
  assert.equal(refuseUnlessLocal({ ...ok, host: null }), 403);
});

test("a website in another tab cannot submit: origin and JSON are required", () => {
  assert.equal(refuseUnlessLocal({ ...ok, origin: "https://evil.example" }), 403);
  assert.equal(refuseUnlessLocal({ ...ok, origin: null }), 403);
  assert.equal(refuseUnlessLocal({ ...ok, contentType: "text/plain" }), 415);
  assert.equal(refuseUnlessLocal({ ...ok, contentType: null }), 415);
});

test("reading the CLI status needs only the local Host", () => {
  assert.equal(refuseUnlessLocal({ ...ok, method: "GET", origin: null, contentType: null }), null);
  assert.equal(
    refuseUnlessLocal({ ...ok, method: "GET", origin: null, contentType: null, host: "10.0.0.5:3000" }),
    403,
  );
});

test("a page on another site cannot even trigger a read", () => {
  // An <img> or fetch from another tab carries Sec-Fetch-Site: cross-site. Each read would start
  // CLI processes on the developer's machine.
  const read = { ...ok, method: "GET", origin: null, contentType: null };
  assert.equal(refuseUnlessLocal({ ...read, fetchSite: "cross-site" }), 403);
  assert.equal(refuseUnlessLocal({ ...read, fetchSite: "same-site" }), 403);
  assert.equal(refuseUnlessLocal({ ...read, fetchSite: "same-origin" }), null);
  // Typed in the address bar, or curl with no header at all.
  assert.equal(refuseUnlessLocal({ ...read, fetchSite: "none" }), null);
  assert.equal(refuseUnlessLocal({ ...read, fetchSite: null }), null);
});

test("GitHub's return to this machine is let through only as a GET to the local dev server", () => {
  const back: RequestFacts = { ...ok, method: "GET", origin: null, contentType: null, fetchSite: "cross-site" };
  // The ordinary rule refuses a navigation that comes from github.com...
  assert.equal(refuseUnlessLocal(back), 403);
  // ...the return rule allows it, and nothing else.
  assert.equal(refuseUnlessLocalReturn(back), null);
  assert.equal(refuseUnlessLocalReturn({ ...back, method: "POST" }), 405);
  assert.equal(refuseUnlessLocalReturn({ ...back, host: "evil.example" }), 403);
  assert.equal(refuseUnlessLocalReturn({ ...back, onVercel: true }), 404);
  assert.equal(refuseUnlessLocalReturn({ ...back, loopbackOnly: false }), 404);
});
