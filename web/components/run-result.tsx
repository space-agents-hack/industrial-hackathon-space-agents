"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { describeResult } from "@/lib/trace";

// A run's result, collapsed by default: a submission is thousands of lines and pushed the trace
// off the screen (first experiments, 2026-10-24). Copy and Download give it whole, pretty-printed
// when it is JSON, so nobody selects text by hand to upload it.
export function RunResult({ output, runId }: { output: string; runId: string }) {
  const result = describeResult(output);
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
    <section className="grid gap-1.5 rounded-md border border-success-border bg-card px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium">Result</h2>
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
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground select-none hover:text-foreground">
          Show the result
        </summary>
        <pre className="mt-1 max-h-[32rem] overflow-auto rounded-sm border bg-muted/60 px-2 py-1.5 font-mono text-xs break-words whitespace-pre-wrap">
          {result.text}
        </pre>
      </details>
    </section>
  );
}
