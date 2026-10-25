"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { type RequirementRow, countByRegulation, requirementRows } from "@/lib/requirement-rows";
import { sourceHref } from "@/lib/requirement-source";
import { describeResult } from "@/lib/trace";

// A long submission is thousands of rows; the first ones say what the run did, and the whole list
// is one click away (and always in the download).
const FIRST_ROWS = 50;

// A run's result, collapsed by default: a submission is thousands of lines and pushed the trace
// off the screen (first experiments, 2026-10-24). Copy and Download give it whole, pretty-printed
// when it is JSON, so nobody selects text by hand to upload it.
export function RunResult({ output, runId, title = "Result" }: { output: string; runId: string; title?: string }) {
  const result = describeResult(output);
  const rows = requirementRows(output);
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(result.text);
      setCopied("yes");
    } catch {
      setCopied("failed");
    }
    setTimeout(() => setCopied(null), 2500);
  }

  function download() {
    const blob = new Blob([result.text], { type: result.json ? "application/json" : "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `run-${runId.slice(0, 8)}.${result.json ? "json" : "txt"}`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="grid gap-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold tracking-tight">{rows ? "Requirements" : title}</h2>
        <span className="text-xs text-muted-foreground">{result.summary}</span>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" onClick={() => void copy()}>
            {copied === "yes" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy"}
          </Button>
          <Button size="sm" variant="outline" onClick={download}>
            Download {result.json ? ".json" : ".txt"}
          </Button>
        </div>
      </div>
      {rows && rows.length > 0 ? <Requirements rows={rows} runId={runId} /> : null}
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground select-none hover:text-foreground">
          {rows ? "Show the file" : "Show the result"}
        </summary>
        <pre className="mt-1 max-h-[32rem] overflow-auto rounded-md border bg-muted/60 px-2 py-1.5 font-mono text-xs break-words whitespace-pre-wrap">
          {result.text}
        </pre>
      </details>
    </section>
  );
}

// The submission as an engineer reads it: each requirement next to the regulation, page and
// paragraph it cites, the citation opening the regulation's PDF at that page (SYS-12), and above
// them how many each regulation gave, which is where a missing regulation shows first.
function Requirements({ rows, runId }: { rows: RequirementRow[]; runId: string }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, FIRST_ROWS);
  return (
    <div className="grid gap-3">
      <ul aria-label="Requirements per regulation" className="flex flex-wrap gap-1.5">
        {countByRegulation(rows).map(({ regulation, count }) => (
          <li key={regulation} className="rounded-full bg-secondary px-2.5 py-0.5 text-xs">
            <span className="font-medium">{regulation || "No regulation"}</span>
            <span className="text-muted-foreground tabular-nums"> · {count}</span>
          </li>
        ))}
      </ul>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                ID
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Requirement
              </th>
              <th scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
                Source
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {shown.map((row, index) => (
              <tr key={`${index}-${row.id}`} className="align-top">
                <td className="px-3 py-2.5 font-mono text-xs whitespace-nowrap text-muted-foreground">{row.id}</td>
                <td className="min-w-64 px-3 py-2.5 leading-relaxed">{row.text}</td>
                <td className="px-3 py-2.5 whitespace-nowrap">
                  <Source row={row} runId={runId} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > FIRST_ROWS ? (
        <Button variant="ghost" size="sm" className="w-fit" onClick={() => setAll(!all)}>
          {all ? `Show the first ${FIRST_ROWS}` : `Show all ${rows.length.toLocaleString("en-US")}`}
        </Button>
      ) : null}
    </div>
  );
}

// One link for the whole citation, so the target is easy to hit; without a page there is nothing
// to open and it stays text.
function Source({ row, runId }: { row: RequirementRow; runId: string }) {
  const href = sourceHref(runId, row);
  const body = (
    <>
      <span className={`block font-medium ${href ? "text-tint underline-offset-4 group-hover:underline" : ""}`}>
        {row.regulation}
        {row.version ? <span className="font-normal text-muted-foreground"> {row.version}</span> : null}
      </span>
      <span className="block text-xs text-muted-foreground tabular-nums">
        {[row.page ? `p. ${row.page}` : null, row.paragraph ? `§ ${row.paragraph}` : null].filter(Boolean).join(" · ")}
      </span>
    </>
  );
  if (!href) return body;
  return (
    <a href={href} target="_blank" rel="noreferrer" title={`Open ${row.regulation} at page ${row.page}`} className="group block">
      {body}
    </a>
  );
}
