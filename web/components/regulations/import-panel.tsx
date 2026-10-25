"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { FilePickerButton } from "@/components/file-picker-button";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import {
  ACTIVE_IMPORT,
  type FileCounts,
  IMPORT_STATUS_LABELS,
  type ImportStatus,
  type ImportSteps,
  type IndexSummary,
  describeCounts,
  readIndexFile,
  summarizeIndex,
} from "@/lib/regulations";
import { sendJson } from "@/lib/send-json";

export type ImportView = {
  id: string;
  status: ImportStatus;
  sourceName: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  counts: FileCounts;
  steps: ImportSteps;
  failedFiles: { name: string; error: string }[];
};

export type EarlierImport = {
  id: string;
  status: ImportStatus;
  sourceName: string;
  createdAt: string;
  error: string | null;
};

// How often the page re-reads progress while an import is active.
const POLL_MS = 4000;
// A running import heartbeats after every file; after this long without one the agent takes it
// over on the next call (import_stale_after_s in agent/agent_service/settings.py), so Resume shows.
const STALE_MS = 150_000;

export function ImportPanel({
  org,
  latest,
  earlier,
}: {
  org: string;
  latest: ImportView | null;
  earlier: EarlierImport[];
}) {
  const router = useRouter();
  const [chosen, setChosen] = useState<{ name: string; index: unknown; summary: IndexSummary } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const continued = useRef<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const active = latest !== null && ACTIVE_IMPORT.includes(latest.status);

  // While an import is active: re-read the page, and hand a paused import back to the agent for
  // its next slice. Only once per pause (the key includes updated_at), so an agent that refuses
  // does not get called every few seconds; Resume is there for that case.
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      router.refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [active, router]);

  useEffect(() => {
    if (latest?.status !== "paused") return;
    const key = `${latest.id}:${latest.updatedAt}`;
    if (continued.current === key) return;
    continued.current = key;
    void sendJson(`/api/regulations/imports/${latest.id}/advance`, "POST", {}).then((result) => {
      if (!result.ok) setError(result.error);
      router.refresh();
    });
  }, [latest, router]);

  async function choose(file: File | undefined) {
    setChosen(null);
    setFileError(null);
    setMessage(null);
    setError(null);
    if (!file) return;
    const parsed = readIndexFile(await file.text());
    if (!parsed.ok) {
      setFileError(parsed.error);
      return;
    }
    const summary = summarizeIndex(parsed.value);
    if (summary.problems.length > 0) {
      setFileError(summary.problems.join(" "));
      return;
    }
    setChosen({ name: file.name, index: parsed.value, summary });
  }

  async function start() {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    const result = await sendJson<{ id: string; warning?: string }>("/api/regulations/imports", "POST", {
      organization_id: org,
      source_name: chosen.name,
      index: chosen.index,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setChosen(null);
    setMessage(result.body.warning ? `The import is saved but did not start: ${result.body.warning}` : null);
    router.refresh();
  }

  async function act(path: string, method: "POST" | "DELETE") {
    setBusy(true);
    setError(null);
    const result = await sendJson(path, method, {});
    setBusy(false);
    if (!result.ok) setError(result.error);
    router.refresh();
  }

  const stale =
    latest !== null &&
    (latest.status === "queued" || latest.status === "running") &&
    now - new Date(latest.updatedAt).getTime() > (latest.status === "queued" ? POLL_MS * 4 : STALE_MS);

  return (
    <section className="grid gap-3">
      <h2 className="text-base font-semibold">Import</h2>
      <p className="max-w-prose text-muted-foreground">
        Upload an index file in the challenge&apos;s <code>regulations/index.json</code> format. The agent downloads
        every PDF it lists, checks each against its sha256 and stores it in this organisation&apos;s library, where
        everyone in the organisation can read it. Versions already stored with the same file are not downloaded
        again. Nothing is deleted.
      </p>

      {latest ? (
        <div className="grid gap-2 rounded-xl border bg-card p-4">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-medium">{latest.sourceName}</span>
            <span className="text-xs text-muted-foreground">
              started <RelativeTime iso={latest.createdAt} />
            </span>
            <span className={latest.status === "failed" ? "text-danger" : "text-muted-foreground"}>
              {IMPORT_STATUS_LABELS[latest.status]}
            </span>
          </div>
          <ImportProgress counts={latest.counts} active={active} />
          <p>{describeCounts(latest.counts)}</p>
          <StepProgress
            label="Paragraphs"
            step={latest.steps.split}
            unit="versions split"
          />
          <StepProgress
            label="Pictures"
            step={latest.steps.pictures.total > 0 ? latest.steps.pictures : null}
            unit="read"
            model={latest.steps.pictures.model}
            note={
              latest.steps.split && latest.steps.split.done < latest.steps.split.total
                ? "counted in the versions split so far"
                : undefined
            }
          />
          {latest.error ? <p className="text-danger">{latest.error}</p> : null}
          {latest.failedFiles.length > 0 ? (
            <ul className="grid gap-0.5 text-xs">
              {latest.failedFiles.map((file) => (
                <li key={file.name}>
                  <span className="font-medium">{file.name}</span>: {file.error}
                </li>
              ))}
            </ul>
          ) : null}
          {latest.status === "failed" ? (
            <div className="flex flex-wrap gap-2">
              {/* The agent resumes a failed import where it stopped: stored files are skipped and
                  only versions without paragraphs are split (prepare in regulations.py, #57). */}
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void act(`/api/regulations/imports/${latest.id}/advance`, "POST")}
              >
                Resume
              </Button>
            </div>
          ) : null}
          {active ? (
            <div className="flex flex-wrap gap-2">
              {stale ? (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void act(`/api/regulations/imports/${latest.id}/advance`, "POST")}
                >
                  Resume
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void act(`/api/regulations/imports/${latest.id}`, "DELETE")}
              >
                Cancel import
              </Button>
              <span className="text-xs font-medium text-attention">
                Keep this page open: the import continues in slices only while it is.
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      {active ? null : (
        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <FilePickerButton
              label={chosen ? "Choose another index file…" : "Choose index file…"}
              accept="application/json,.json"
              disabled={busy}
              onPick={(list) => void choose(list[0])}
            />
            {chosen ? <span className="font-mono text-sm">{chosen.name}</span> : null}
          </div>
          {fileError ? (
            <p role="alert" className="text-danger">
              {fileError}
            </p>
          ) : null}
          {chosen ? (
            <div className="flex flex-wrap items-center gap-3">
              <span>
                {chosen.summary.regulations} regulations, {chosen.summary.files} PDFs.
              </span>
              <Button disabled={busy} onClick={() => void start()}>
                {busy ? "Starting…" : "Import"}
              </Button>
            </div>
          ) : null}
        </div>
      )}

      {message ? <p className="text-attention">{message}</p> : null}
      {error ? (
        <p role="alert" className="text-danger">
          {error}
        </p>
      ) : null}

      {earlier.length > 0 ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Earlier imports</summary>
          <ul className="mt-1 grid gap-0.5">
            {earlier.map((item) => (
              <li key={item.id}>
                {item.sourceName}, <RelativeTime iso={item.createdAt} />: {IMPORT_STATUS_LABELS[item.status]}
                {item.error ? ` (${item.error})` : ""}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

// A step after the files (#52): a thin bar and one line, "41 of 92 versions split". Nothing when
// there is nothing to count yet (an agent that does not name its reader, no picture found yet).
function StepProgress({
  label,
  step,
  unit,
  model,
  note,
}: {
  label: string;
  step: { done?: number; read?: number; total: number } | null;
  unit: string;
  model?: string | null;
  note?: string;
}) {
  if (step === null) return null;
  const done = step.done ?? step.read ?? 0;
  const percent = step.total === 0 ? 100 : Math.round((done / step.total) * 100);
  return (
    <div className="grid gap-1">
      <span className="text-xs">
        <span className="font-medium">{label}</span>
        {model ? (
          <span className="text-muted-foreground">
            {" "}
            (<span className="font-mono">{model}</span>)
          </span>
        ) : null}
        : {done} of {step.total} {unit} ({percent}%)
        {note ? <span className="text-muted-foreground">, {note}</span> : null}
      </span>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={step.total}
        aria-valuenow={done}
        className="h-1.5 overflow-hidden rounded-sm bg-muted"
      >
        <div className="h-full bg-tint transition-[width] duration-500" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

// Files handled out of files listed, as a bar: stored, already there and failed all count as
// handled. While the agent is still reading the index there is no total yet, so the bar moves
// without a number.
function ImportProgress({ counts, active }: { counts: FileCounts; active: boolean }) {
  const handled = counts.stored + counts.unchanged + counts.failed;
  const percent = counts.total === 0 ? 0 : Math.round((handled / counts.total) * 100);
  return (
    <div className="grid gap-1">
      <div
        role="progressbar"
        aria-label="Import progress"
        aria-valuemin={0}
        aria-valuemax={counts.total || undefined}
        aria-valuenow={counts.total ? handled : undefined}
        className="h-2 overflow-hidden rounded-sm bg-muted"
      >
        <div
          className={`h-full bg-tint transition-[width] duration-500 ${counts.total === 0 && active ? "w-1/4 animate-pulse" : ""}`}
          style={counts.total === 0 ? undefined : { width: `${percent}%` }}
        />
      </div>
      {counts.total > 0 ? (
        <span className="text-xs text-muted-foreground">
          {handled} of {counts.total} files ({percent}%)
        </span>
      ) : null}
    </div>
  );
}
