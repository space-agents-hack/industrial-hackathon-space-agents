"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { type IndexSlice, type LibraryIndex, describeSearch, indexComplete, shouldContinue } from "@/lib/regulation-index";
import { sendJson } from "@/lib/send-json";

// The library's search index (#37; SYS-28): what searches can do with it now, and for admins the
// indexer, one slice per request while the page is open, as imports run. It starts by itself when
// an import has added paragraphs the indexer has not seen (`autoStart`), which is what "after each
// import" means without a queue: production went hours with 48,487 paragraphs and no vector
// because nothing started it.
export function IndexPanel({
  org,
  index,
  model,
  canManage,
  autoStart,
}: {
  org: string;
  index: LibraryIndex;
  model: string;
  canManage: boolean;
  autoStart: boolean;
}) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [slices, setSlices] = useState(0);
  const [written, setWritten] = useState({ embedded: 0, summarized: 0 });
  const [notes, setNotes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const started = useRef(false);

  const run = useCallback(async () => {
    if (started.current) return;
    started.current = true;
    setRunning(true);
    setError(null);
    setNotes([]);
    setFinished(false);
    try {
      for (;;) {
        const result = await sendJson<IndexSlice>("/api/regulations/index", "POST", { organization_id: org });
        if (!result.ok) {
          setError(result.error);
          break;
        }
        const slice = result.body;
        setSlices((n) => n + 1);
        if (slice.status === "failed") {
          setError(slice.error);
          break;
        }
        setWritten((w) => ({ embedded: w.embedded + slice.embedded, summarized: w.summarized + slice.summarized }));
        setNotes(slice.notes);
        router.refresh();
        if (slice.status === "finished") {
          setFinished(true);
          break;
        }
        if (!shouldContinue(slice)) break;
      }
    } finally {
      setRunning(false);
      started.current = false;
      router.refresh();
    }
  }, [org, router]);

  useEffect(() => {
    if (autoStart && canManage) void run();
    // Once per page load where an import left new paragraphs; the loop itself continues.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, canManage]);

  const search = describeSearch(index);
  const complete = indexComplete(index);
  const percent = index.paragraphs === 0 ? 0 : Math.floor((index.embedded / index.paragraphs) * 100);

  return (
    <section className="grid gap-2" aria-labelledby="search-index-heading">
      <h2 id="search-index-heading" className="text-sm font-semibold">
        Search index
      </h2>
      <div className="grid gap-2 rounded-md border bg-card p-3">
        <p className={search.tone === "ok" ? "" : "font-medium text-attention"}>{search.text}</p>
        <div
          role="progressbar"
          aria-label="Paragraphs with a vector"
          aria-valuemin={0}
          aria-valuemax={index.paragraphs}
          aria-valuenow={index.embedded}
          className="h-2 overflow-hidden rounded-sm bg-muted"
        >
          <div className="h-full bg-primary transition-[width] duration-500" style={{ width: `${percent}%` }} />
        </div>
        <dl className="grid gap-x-4 gap-y-0.5 text-xs sm:grid-cols-[max-content_1fr]">
          <dt className="text-muted-foreground">Vectors</dt>
          <dd>
            {index.embedded.toLocaleString("en-US")} of {index.paragraphs.toLocaleString("en-US")} paragraphs
            ({percent}%), <span className="font-mono">{model}</span>
          </dd>
          <dt className="text-muted-foreground">Scope summaries</dt>
          <dd>
            {index.summarized} of {index.versions} versions. The agent reads them to choose which regulations to open.
          </dd>
          {index.unkeyed > 0 ? (
            <>
              <dt className="text-muted-foreground">Not yet seen</dt>
              <dd>{index.unkeyed.toLocaleString("en-US")} paragraphs added since the indexer last ran</dd>
            </>
          ) : null}
        </dl>

        {running ? (
          <p className="text-xs">
            <span className="font-medium">Indexing</span>, slice {slices + 1}: {written.embedded.toLocaleString("en-US")}{" "}
            vectors and {written.summarized} summaries written so far.{" "}
            <span className="font-medium text-attention">Keep this page open: indexing continues only while it is.</span>
          </p>
        ) : slices > 0 ? (
          <p className="text-xs">
            {finished ? "Indexing finished" : "Indexing stopped"} after {slices} slice{slices === 1 ? "" : "s"}:{" "}
            {written.embedded.toLocaleString("en-US")} vectors and {written.summarized} summaries written.
          </p>
        ) : null}
        {notes.length > 0 ? (
          <ul className="grid gap-0.5 text-xs text-attention">
            {notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        ) : null}
        {error ? (
          <p role="alert" className="text-danger">
            {error}
          </p>
        ) : null}

        {canManage && !complete ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={running} onClick={() => void run()}>
              {running ? "Indexing…" : "Index library"}
            </Button>
            <span className="text-xs text-muted-foreground">
              Uses the organisation&apos;s embedding and summary models (Admin, Models). What it spends is in Admin, Usage.
            </span>
          </div>
        ) : null}
      </div>
    </section>
  );
}
