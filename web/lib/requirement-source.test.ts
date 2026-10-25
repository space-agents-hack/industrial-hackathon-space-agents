import assert from "node:assert/strict";
import { test } from "node:test";

import { pdfAtPage, pickVersion, readCitation, sourceHref } from "./requirement-source.ts";

const RUN = "8f1c2a4e-1b2c-4d5e-8f90-1234567890ab";

test("links a citation to the run's source route, and reads it back unchanged", () => {
  const href = sourceHref(RUN, { regulation: "UN R48", version: "06 series", page: 37 });
  assert.equal(href, `/runs/${RUN}/source?regulation=UN+R48&page=37&version=06+series`);
  const query = new URL(href ?? "", "https://example.test").searchParams;
  assert.deepEqual(readCitation(query), { regulation: "UN R48", version: "06 series", page: 37 });
});

test("has no link without a regulation or a page", () => {
  assert.equal(sourceHref(RUN, { regulation: "", version: "", page: 3 }), null);
  assert.equal(sourceHref(RUN, { regulation: "UN R7", version: "", page: null }), null);
});

test("leaves the version out when the citation has none", () => {
  assert.equal(sourceHref(RUN, { regulation: "UN R7", version: "", page: 1 }), `/runs/${RUN}/source?regulation=UN+R7&page=1`);
});

test("refuses a citation it cannot open", () => {
  const read = (q: string) => readCitation(new URLSearchParams(q));
  assert.equal(read("page=3"), null);
  assert.equal(read("regulation=UN+R7"), null);
  assert.equal(read("regulation=UN+R7&page=0"), null);
  assert.equal(read("regulation=UN+R7&page=2.5"), null);
  assert.equal(read("regulation=UN+R7&page=100000"), null);
  assert.equal(read(`regulation=${"x".repeat(101)}&page=1`), null);
});

test("picks the cited version, else the base one, else none", () => {
  const versions = [
    { version_label: "05 series", role: "base" },
    { version_label: "06 series", role: "latest" },
  ];
  assert.equal(pickVersion(versions, "06 series")?.version_label, "06 series");
  assert.equal(pickVersion(versions, "")?.version_label, "05 series");
  assert.equal(pickVersion(versions, "99 series")?.version_label, "05 series");
  assert.equal(pickVersion([{ version_label: "06 series", role: "latest" }], "05 series"), null);
});

test("opens the PDF at the page, replacing a fragment the URL already has", () => {
  assert.equal(pdfAtPage("https://s.test/a.pdf?token=t", 12), "https://s.test/a.pdf?token=t#page=12");
  assert.equal(pdfAtPage("https://s.test/a.pdf#page=1", 12), "https://s.test/a.pdf#page=12");
});
