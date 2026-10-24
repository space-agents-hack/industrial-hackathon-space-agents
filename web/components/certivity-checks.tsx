"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  type CheckResult,
  type Level,
  downloadName,
  formatRatio,
  parseCheckResult,
  submissionPart,
} from "@/lib/certivity";

// Each answer remembers the text it is about, so a new text shows "Checking…" until its own
// answer arrives, without resetting state inside the effect.
type Answer = { text: string } & ({ phase: "done"; result: CheckResult } | { phase: "failed"; error: string });

// Certivity's validate.py and score_local.py on `text`, through the agent. A failed validation is
// a warning on the run, not a failed run: the requirements are still worth reading and fixing.
// `organizationId` picks the regulation library the citations are checked against (ADR-0006).
export function CertivityChecks({ text, organizationId }: { text: string; organizationId: string | null }) {
  const [answer, setAnswer] = useState<Answer | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/checks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text, organization_id: organizationId }),
          signal: controller.signal,
        });
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          const error =
            typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string"
              ? (body as { error: string }).error
              : `The checks could not run (${response.status}).`;
          setAnswer({ text, phase: "failed", error });
          return;
        }
        const result = parseCheckResult(body);
        setAnswer(
          result
            ? { text, phase: "done", result }
            : { text, phase: "failed", error: "The checks answered in an unexpected form." },
        );
      } catch {
        if (!controller.signal.aborted) setAnswer({ text, phase: "failed", error: "The server did not answer." });
      }
    })();
    return () => controller.abort();
  }, [text, organizationId]);

  const state = answer?.text === text ? answer : null;
  return (
    <section className="grid gap-1" aria-live="polite">
      <h2 className="text-xs font-medium text-muted-foreground">Certivity checks</h2>
      <div className="grid gap-3 rounded-md border bg-card px-3 py-2 text-sm">
        {state === null ? <p className="text-muted-foreground">Checking…</p> : null}
        {state?.phase === "failed" ? <p className="text-danger">{state.error}</p> : null}
        {state?.phase === "done" ? <Result text={text} result={state.result} /> : null}
      </div>
    </section>
  );
}

function Result({ text, result }: { text: string; result: CheckResult }) {
  const what = result.kind === "subgoal" ? "changes" : "requirements";
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {result.valid ? (
          <p className="font-medium text-success">Valid: the platform accepts this file.</p>
        ) : (
          <p className="font-medium text-danger">
            Not valid: {result.problemCount} {result.problemCount === 1 ? "problem" : "problems"}. The platform
            would reject this file.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {result.caseId ? `Case ${result.caseId}` : "No case id"}
          {result.items !== null ? ` · ${result.items} ${what}` : ""}
        </p>
        {result.jsonSpan ? <DownloadButton text={text} result={result} /> : null}
      </div>

      {result.problems.length > 0 ? (
        <ul className="grid max-h-72 gap-1 overflow-y-auto font-mono text-xs">
          {result.problems.map((problem, i) => (
            <li key={`${problem.path}-${i}`} className="break-words">
              <span className="text-danger">{problem.path}</span> {problem.message}
            </li>
          ))}
          {result.problemCount > result.problems.length ? (
            <li className="text-muted-foreground">
              …and {result.problemCount - result.problems.length} more.
            </li>
          ) : null}
        </ul>
      ) : null}

      {result.score ? (
        <table className="w-fit text-xs tabular-nums">
          <thead className="text-muted-foreground">
            <tr>
              <th className="pr-4 text-left font-normal">Level</th>
              <th className="pr-4 text-right font-normal">Precision</th>
              <th className="pr-4 text-right font-normal">Recall</th>
              <th className="pr-4 text-right font-normal">F1</th>
              <th className="text-right font-normal">Cited / expected / matched</th>
            </tr>
          </thead>
          <tbody>
            <ScoreRow label="Regulations" level={result.score.regulation} />
            <ScoreRow label="Pages" level={result.score.page} />
          </tbody>
        </table>
      ) : null}

      {result.notes.length > 0 ? (
        <ul className="grid gap-0.5 text-xs text-muted-foreground">
          {result.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Certivity&apos;s validate.py and score_local.py, package commit {result.certivityCommit}.
      </p>
    </>
  );
}

function ScoreRow({ label, level }: { label: string; level: Level }) {
  return (
    <tr>
      <td className="pr-4">{label}</td>
      <td className="pr-4 text-right">{formatRatio(level.precision)}</td>
      <td className="pr-4 text-right">{formatRatio(level.recall)}</td>
      <td className="pr-4 text-right">{formatRatio(level.f1)}</td>
      <td className="text-right">
        {level.n_submitted} / {level.n_expected} / {level.n_matched}
      </td>
    </tr>
  );
}

function DownloadButton({ text, result }: { text: string; result: CheckResult }) {
  function download() {
    const blob = new Blob([submissionPart(text, result)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = downloadName(result);
    link.click();
    URL.revokeObjectURL(url);
  }
  return (
    <Button variant="outline" size="sm" className="ml-auto" onClick={download}>
      Download .json
    </Button>
  );
}
