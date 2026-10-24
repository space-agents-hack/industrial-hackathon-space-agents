"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import {
  ACTIVE_IMPORT,
  type FileCounts,
  IMPORT_STATUS_LABELS,
  type ImportStatus,
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
      <h2 className="text-sm font-semibold">Import</h2>
      <p className="max-w-prose text-muted-foreground">
        Upload an index file in the challenge&apos;s <code>regulations/index.json</code> format. The agent downloads
        every PDF it lists, checks each against its sha256 and stores it in this organisation&apos;s library, where
        everyone in the organisation can read it. Versions already stored with the same file are not downloaded
        again. Nothing is deleted.
      </p>

      {latest ? (
        <div className="grid gap-2 rounded-md border bg-card p-3">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-medium">{latest.sourceName}</span>
            <span className="text-xs text-muted-foreground">
              started <RelativeTime iso={latest.createdAt} />
            </span>
            <span className={latest.status === "failed" ? "text-danger" : "text-muted-foreground"}>
              {IMPORT_STATUS_LABELS[latest.status]}
            </span>
          </div>
          <p>{describeCounts(latest.counts)}</p>
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
              <span className="text-xs text-muted-foreground">
                Keep this page open: the import continues in slices while it is.
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      {active ? null : (
        <div className="grid gap-2">
          <input
            type="file"
            accept="application/json,.json"
            aria-label="Index file"
            className="text-sm file:mr-3 file:rounded-md file:border file:bg-background file:px-2 file:py-1"
            onChange={(event) => void choose(event.target.files?.[0])}
          />
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
