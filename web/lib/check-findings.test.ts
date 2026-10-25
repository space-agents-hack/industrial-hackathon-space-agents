import assert from "node:assert/strict";
import { test } from "node:test";

import { flagged, parseFindings } from "./check-findings.ts";

test("only requirements with findings are listed, rejected first", () => {
  const base = { regulation: "UN R1", version_label: "00", page: 4, paragraph: null, text: "x" };
  const rows = flagged([
    {
      ...base,
      ext_id: "R-002",
      status: "draft",
      findings: [{ by: "check-agent", problem: "Wording.", action: "keep" }],
    },
    { ...base, ext_id: "R-001", status: "draft", findings: [] },
    {
      ...base,
      ext_id: "R-003",
      status: "rejected",
      findings: [{ by: "code", problem: "Duplicate.", action: "reject" }],
    },
  ]);
  assert.deepEqual(
    rows.map((r) => r.extId),
    ["R-003", "R-002"],
  );
  assert.equal(rows[1].paragraph, "");
  assert.equal(rows[1].page, 4);
  assert.equal(rows[1].version, "00");
});

test("a malformed findings value is read as none", () => {
  assert.deepEqual(parseFindings("nope"), []);
  assert.deepEqual(parseFindings([{ problem: 1 }]), [
    { by: "", problem: "", action: "" },
  ]);
});
