"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { isSettled } from "@/lib/case-files";
import { parseCase, startCaseRun } from "@/lib/case-upload";
import { type CaseFileView, type CaseOption, fetchCaseFiles } from "@/lib/cases";
import { createClient } from "@/lib/supabase/client";
import { TASK_MAX_LENGTH } from "@/lib/validation";

// The run's task is what the engineer types, with nothing added. What the agent does with it
// (find the UN Regulation requirements, cite regulation, version, page and paragraph) belongs in
// agent/agent_service/domain/prompt.md, so the instruction lives in one place.
//
// This form only launches a run on a case that already exists (ADR-0006). Creating cases and
// adding or removing their files happen on the case page (Ramón, 2026-10-24, #46): with a second
// upload path here, the two drifted, and a file removed on the case page could still be shown or
// re-added from Runs.

export function NewRunForm({
  organizationId,
  projectId,
  cases,
  blockers = [],
}: {
  organizationId: string;
  projectId: string;
  cases: CaseOption[];
  // Why no run can start here whatever the form holds (lib/run-readiness.ts), e.g. no regulation.
  blockers?: string[];
}) {
  const router = useRouter();
  const [caseId, setCaseId] = useState(cases[0]?.id ?? "");
  // Tagged with the case they belong to, so a switch shows "reading" instead of the last case's.
  const [loaded, setLoaded] = useState<{ caseId: string; rows: CaseFileView[] } | null>(null);
  const [spec, setSpec] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  // The chosen case's files, read only to say whether the run has something to read.
  useEffect(() => {
    if (!caseId) return;
    let live = true;
    fetchCaseFiles(createClient(), caseId)
      .then((rows) => live && setLoaded({ caseId, rows }))
      .catch((caught: unknown) => live && setError(caught instanceof Error ? caught.message : String(caught)));
    return () => {
      live = false;
    };
  }, [caseId]);
  const caseFiles = loaded?.caseId === caseId ? loaded.rows : null;

  const casePage = `/projects/${projectId}/cases/${caseId}`;
  const files = caseFiles ?? [];
  const parsed = files.filter((f) => f.status === "parsed").length;
  const failed = files.filter((f) => f.status === "failed").length;
  const unsettled = files.some((f) => !isSettled(f.status));
  // As on the case page: a run needs at least one file that was read, or one still to be read
  // (lib/run-readiness.ts, SYS-38). A case whose every file failed has nothing to run on.
  const hasContent = parsed > 0 || unsettled;
  const canStart = caseId !== "" && caseFiles !== null && hasContent && blockers.length === 0 && pending === null;

  async function startRun() {
    if (!canStart) return;
    setError(null);
    try {
      // A file whose reading was cut short (closed tab, dead request) is read now, not skipped.
      if (unsettled) {
        const rows = await parseCase(createClient(), caseId, (rows) => setLoaded({ caseId, rows }), setPending);
        if (!rows.some((f) => f.status === "parsed")) {
          setError("No file of this part could be read, so there is nothing to run on. Open the part to see why.");
          return;
        }
      }
      setPending("Starting…");
      const path = await startCaseRun(organizationId, caseId, spec.trim(), null);
      setSpec("");
      router.push(path);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The draft could not be started: the server did not answer.");
    } finally {
      setPending(null);
    }
  }

  if (cases.length === 0) {
    return (
      <div className="grid gap-1 rounded-xl border bg-card p-4">
        <h2 className="text-base font-semibold">Draft the requirements for a part</h2>
        <p className="text-sm text-muted-foreground">
          This project has no part yet. Create one and add its files under{" "}
          <Link href={`/projects/${projectId}`} className="underline underline-offset-4">
            Parts
          </Link>
          , then start the draft here.
        </p>
      </div>
    );
  }

  const busy = pending !== null;

  return (
    <form
      className="grid gap-3 rounded-xl border bg-card p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void startRun();
      }}
    >
      <div className="grid gap-1">
        <h2 className="text-base font-semibold">Draft the requirements for a part</h2>
        <p className="text-xs text-muted-foreground">
          The agent reads the part&apos;s files and lists the requirements the product must fulfil under the UN
          Regulations, each with its regulation, page and paragraph. Files are added and removed on the
          part&apos;s own page, under Parts.
        </p>
      </div>

      <div className="grid gap-1.5 sm:max-w-md">
        <Label htmlFor="case">Part</Label>
        <select
          id="case"
          className="h-8 rounded-md border bg-background px-2 text-sm"
          value={caseId}
          disabled={busy}
          onChange={(event) => setCaseId(event.target.value)}
        >
          {cases.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          {caseFiles === null ? "Reading the part's files… " : `${describeFiles(files.length, parsed, failed, unsettled)} `}
          <Link href={casePage} className="underline underline-offset-4">
            {files.length === 0 && caseFiles !== null ? "Add files to the part" : "Open the part"}
          </Link>
        </p>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="spec">Notes for this draft (optional)</Label>
        <Textarea
          id="spec"
          name="spec"
          rows={4}
          maxLength={TASK_MAX_LENGTH}
          placeholder="Anything the files do not say."
          className="max-h-96 font-mono text-xs"
          value={spec}
          disabled={busy}
          onChange={(event) => setSpec(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void startRun();
            }
          }}
        />
      </div>

      {blockers.map((b) => (
        <p key={b} className="text-sm text-attention">
          {b}
        </p>
      ))}
      <div className="flex items-center gap-2">
        {pending ? <span className="text-xs text-muted-foreground">{pending}</span> : null}
        {caseFiles !== null && !hasContent && blockers.length === 0 ? (
          <span className="text-xs text-muted-foreground">The part needs at least one readable file to start.</span>
        ) : null}
        <Button type="submit" className="ml-auto" disabled={!canStart}>
          {pending ? "Working…" : "Draft requirements"}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function describeFiles(total: number, parsed: number, failed: number, unsettled: boolean): string {
  if (total === 0) return "No files yet.";
  const parts = [`${total} ${total === 1 ? "file" : "files"}`, `${parsed} read`];
  if (failed > 0) parts.push(`${failed} could not be read`);
  if (unsettled) parts.push("the rest are read before the draft starts");
  return `${parts.join(", ")}.`;
}
