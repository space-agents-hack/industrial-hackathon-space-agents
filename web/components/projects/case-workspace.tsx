"use client";

import { useRouter } from "next/navigation";
import { type DragEvent, useEffect, useState } from "react";

import { FileText } from "lucide-react";

import { FilePickerButton } from "@/components/file-picker-button";
import { UploadedFile } from "@/components/projects/uploaded-file";
import { ToneBadge } from "@/components/status-badge";
import { runBlockers } from "@/lib/run-readiness";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ACCEPT, CASE_FILES_BUCKET, MAX_FILES, describeSize, isSettled, refusal } from "@/lib/case-files";
import { parseCase, removeCaseFile, startCaseRun, uploadCaseFiles } from "@/lib/case-upload";
import { type CaseBlockView, type CaseFileView, describeParser, fetchCaseBlocks } from "@/lib/cases";
import { type CaseKind, type EntryLike, SUBGOAL_ACCEPT, filesInEntries, screenSubgoalFiles } from "@/lib/subgoal";
import { createClient } from "@/lib/supabase/client";
import { MODEL_PATTERN, TASK_MAX_LENGTH } from "@/lib/validation";

// The case page's working part (SYS-31): the files, adding and removing them without starting a
// run, each file as uploaded and what the parser or model read from it, and Find requirements. Adding files and running
// are separate on purpose: a case is put together once and run many times (another model, a new
// prompt), and before this page every upload cost a run.
//
// A sub-goal case (#42) is the same page with another job: its files are Certivity's subgoal
// folder, dropped or chosen whole, and its run writes the changes file.
export function CaseWorkspace({
  organizationId,
  caseId,
  kind,
  initialFiles,
  canEdit,
  writerModel,
  regulationBlockers,
}: {
  organizationId: string;
  caseId: string;
  kind: CaseKind;
  initialFiles: CaseFileView[];
  canEdit: boolean;
  // What a run uses when no other model is asked for: the organisation's, else the deployment's.
  writerModel: string;
  // The project has no regulation to cite (lib/run-readiness.ts); the button stays off with why.
  regulationBlockers: string[];
}) {
  const router = useRouter();
  const [files, setFiles] = useState(initialFiles);
  // One file is open at a time, either as uploaded or as read: both can be long (#45).
  const [open, setOpen] = useState<{ id: string; show: "file" | "read" } | null>(null);
  const [notes, setNotes] = useState("");
  const [model, setModel] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  // Answer keys held back from a sub-goal upload: said apart from errors, since nothing went wrong.
  const [heldBack, setHeldBack] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const busy = pending !== null;
  const subgoal = kind === "subgoal";

  // Picking is adding: the files go up and are read at once, with no second button to press.
  async function addFiles(list: FileList | File[]) {
    let chosen: File[] = [];
    const problems: string[] = [];
    if (subgoal) {
      const screened = await screenSubgoalFiles(Array.from(list));
      chosen = screened.keep;
      problems.push(...screened.problems);
      setHeldBack(screened.answerKeys);
    } else {
      for (const file of Array.from(list)) {
        const reason = refusal(file);
        if (reason) problems.push(reason);
        else chosen.push(file);
      }
    }
    if (chosen.length > MAX_FILES) problems.push(`At most ${MAX_FILES} files at a time; the first ${MAX_FILES} are added.`);
    setError(problems.length ? problems.join(" ") : null);
    if (chosen.length === 0) return;
    try {
      const supabase = createClient();
      await uploadCaseFiles(supabase, organizationId, caseId, chosen.slice(0, MAX_FILES), files, setPending);
      await parseCase(supabase, caseId, setFiles, setPending);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(null);
    }
  }

  // A dropped folder arrives as entries, not files. They have to be taken during the drop event:
  // the browser empties the DataTransfer as soon as the handler returns, so the walk comes after.
  function drop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragging(false);
    if (busy) return;
    const items = Array.from(event.dataTransfer.items);
    const entries = items.flatMap((item) => {
      const entry = item.kind === "file" ? item.webkitGetAsEntry?.() : null;
      return entry ? [entry as EntryLike] : [];
    });
    // Without entry support (or for files from another app), the plain file list still works.
    const fallback = Array.from(event.dataTransfer.files);
    if (entries.length === 0) {
      void addFiles(fallback);
      return;
    }
    setPending("Reading the folder…");
    filesInEntries(entries)
      .then((found) => {
        setPending(null);
        return addFiles(found);
      })
      .catch((caught: unknown) => {
        setPending(null);
        setError(`The folder could not be read: ${caught instanceof Error ? caught.message : String(caught)}`);
      });
  }

  // Only a sub-goal case takes a drop, and only while nothing else is going on.
  const dropProps =
    subgoal && canEdit
      ? {
          onDragOver: (event: DragEvent<HTMLElement>) => {
            if (busy || !event.dataTransfer.types.includes("Files")) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            setDragging(true);
          },
          onDragLeave: (event: DragEvent<HTMLElement>) => {
            // Leaving for a child element is not leaving the section.
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
          },
          onDrop: drop,
        }
      : {};

  async function remove(file: CaseFileView) {
    if (!window.confirm(`Remove ${file.filename} from this part? What was read from it goes too.`)) return;
    setError(null);
    setPending(`Removing ${file.filename}…`);
    try {
      setWarning(await removeCaseFile(createClient(), file.id));
      setFiles((current) => current.filter((f) => f.id !== file.id));
      if (open?.id === file.id) setOpen(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(null);
    }
  }

  const unsettled = files.some((f) => !isSettled(f.status));
  const readable = files.some((f) => f.status === "parsed");
  const modelOk = model.trim() === "" || MODEL_PATTERN.test(model.trim());
  const blockers = [
    ...runBlockers({ files: files.length, library: 1, allRegulations: true, chosen: 0, kind }),
    ...regulationBlockers,
  ];
  const canRun = canEdit && !busy && modelOk && readable && blockers.length === 0;

  async function run() {
    if (!canRun) return;
    setError(null);
    try {
      if (unsettled) await parseCase(createClient(), caseId, setFiles, setPending);
      setPending("Starting…");
      router.push(await startCaseRun(organizationId, caseId, notes.trim(), model.trim() || null));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setPending(null);
    }
  }

  return (
    <div className="grid gap-5">
      <section
        className={`grid gap-2 ${dragging ? "rounded-md outline-2 outline-offset-4 outline-ring outline-dashed" : ""}`}
        aria-labelledby="files-heading"
        {...dropProps}
      >
        <h2 id="files-heading" className="text-lg font-semibold tracking-tight">
          Files
        </h2>
        {files.length === 0 ? (
          <p className="rounded-xl border border-dashed px-3 py-4 text-center text-muted-foreground">
            No files yet.
            {canEdit
              ? subgoal
                ? " Drop Certivity's subgoal folder here, or choose it below: requirements_old.json and files.json, with old.pdf and new.pdf if you have them."
                : " Add the specification, drawings, datasheets or CAD files below."
              : ""}
          </p>
        ) : (
          <ul className="divide-y overflow-hidden rounded-xl border bg-card">
            {files.map((f) => (
              <li key={f.id} className="grid gap-1 px-4 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <FileText aria-hidden className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                  <span className="min-w-0 flex-1 truncate font-medium" title={f.filename}>
                    {f.filename}
                  </span>
                  <span className="text-xs text-muted-foreground tabular-nums">{describeSize(f.bytes)}</span>
                  <FileStatus status={f.status} />
                  {(["file", "read"] as const).map((show) => {
                    const shown = open?.id === f.id && open.show === show;
                    return (
                      <Button
                        key={show}
                        size="xs"
                        variant="outline"
                        aria-expanded={shown}
                        aria-label={`${show === "file" ? "View" : "What was read from"} ${f.filename}`}
                        onClick={() => setOpen(shown ? null : { id: f.id, show })}
                      >
                        {show === "file" ? "View" : "What was read"}
                      </Button>
                    );
                  })}
                  {canEdit ? (
                    <Button
                      size="xs"
                      variant="destructive"
                      disabled={busy}
                      aria-label={`Remove ${f.filename}`}
                      onClick={() => void remove(f)}
                    >
                      Remove
                    </Button>
                  ) : null}
                </div>
                {f.error ? <p className="text-sm text-danger">{f.error}</p> : null}
                {f.notes.map((n) => (
                  <p key={n} className="text-xs text-muted-foreground">
                    {n}
                  </p>
                ))}
                {open?.id === f.id ? (
                  open.show === "file" ? <UploadedFile file={f} /> : <FileContent fileId={f.id} />
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {canEdit ? (
          <div className="grid gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              {subgoal ? (
                <FilePickerButton
                  label="Choose folder…"
                  accept={SUBGOAL_ACCEPT}
                  directory
                  disabled={busy}
                  onPick={(list) => void addFiles(list)}
                />
              ) : null}
              <FilePickerButton
                label={files.length === 0 ? "Add files…" : "Add more files…"}
                accept={subgoal ? SUBGOAL_ACCEPT : ACCEPT}
                multiple
                disabled={busy}
                onPick={(list) => void addFiles(list)}
              />
              {pending ? <span className="text-sm text-muted-foreground">{pending}</span> : null}
            </div>
            <p className="text-xs text-muted-foreground">
              {subgoal
                ? `.json and .pdf only; other files in the folder are left out. Up to ${MAX_FILES} files at a time, 25 MB each. Each file is checked once, when added; the note under it says what it was recognised as.`
                : `.md .txt .csv .json, .png .jpg .webp, .pdf, .docx, .xlsx, CAD .step .iges .stl. Up to ${MAX_FILES} files at a time, 25 MB each. Each file is read once, when added; View shows it as uploaded, What was read what the agent took from it.`}
            </p>
            {heldBack.map((message) => (
              <p key={message} role="status" className="text-sm text-attention">
                {message}
              </p>
            ))}
          </div>
        ) : null}
      </section>

      {canEdit ? (
        <section className="grid gap-2 rounded-xl border bg-card p-4" aria-labelledby="run-heading">
          <h2 id="run-heading" className="text-lg font-semibold tracking-tight">
            {subgoal ? "Review requirements" : "Draft requirements"}
          </h2>
          {subgoal ? (
            <p className="text-sm text-muted-foreground">
              The run compares the old and the new version by text, then a reviewer model re-reads each requirement
              whose paragraph changed. It writes Certivity&apos;s changes file, checked and ready to download on the
              run page.
            </p>
          ) : null}
          {/* Notes are for the requirement writer; the comparison has no use for them. */}
          <div className={subgoal ? "hidden" : "grid gap-1.5"}>
            <Label htmlFor="notes">Notes for this run (optional)</Label>
            <Textarea
              id="notes"
              rows={3}
              maxLength={TASK_MAX_LENGTH}
              placeholder="Anything the files do not say."
              className="max-h-80"
              value={notes}
              disabled={busy}
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5 sm:max-w-md">
            <Label htmlFor="run-model">{subgoal ? "Reviewer model for this run" : "Model for this run"}</Label>
            <Input
              id="run-model"
              placeholder={writerModel}
              maxLength={200}
              value={model}
              disabled={busy}
              aria-invalid={!modelOk}
              onChange={(event) => setModel(event.target.value)}
              className="font-mono text-sm"
            />
            <p className={`text-xs ${modelOk ? "text-muted-foreground" : "text-danger"}`}>
              {modelOk
                ? `Empty uses ${writerModel}. Another one, as provider:model, is for comparing models on the same part; the organisation needs a key for its provider.`
                : 'Write it as provider:model, for example "anthropic:claude-sonnet-5-5".'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {pending ? <span className="text-sm text-muted-foreground">{pending}</span> : null}
            <Button className="ml-auto" disabled={!canRun} onClick={() => void run()}>
              {pending ? "Working…" : subgoal ? "Review requirements" : "Draft requirements"}
            </Button>
          </div>
          {blockers.map((b) => (
            <p key={b} className="text-sm text-attention">
              {b}
            </p>
          ))}
          {!readable && files.length > 0 && !unsettled ? (
            <p className="text-sm text-danger">No file of this part could be read. See the reasons above.</p>
          ) : null}
        </section>
      ) : (
        <p className="rounded-md border bg-card px-3 py-2 text-muted-foreground">
          You can read this {subgoal ? "review" : "part"}. Adding files and {subgoal ? "reviewing requirements" : "drafting requirements"} needs the member
          role.
        </p>
      )}

      {pending && !canEdit ? <p className="text-sm text-muted-foreground">{pending}</p> : null}
      {warning ? (
        <p role="status" className="text-sm text-attention">
          {warning}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// The parse status in words and in the status colours the runs use: read is done, failed needs
// the person, pending and parsing are the agent at work.
function FileStatus({ status }: { status: string }) {
  if (status === "parsed") return <ToneBadge tone="green">Read</ToneBadge>;
  if (status === "failed") return <ToneBadge tone="red">Not read</ToneBadge>;
  if (status === "parsing") return <ToneBadge tone="blue" pulse>Reading</ToneBadge>;
  return <ToneBadge tone="neutral">Waiting</ToneBadge>;
}

// What was read from one file, page by page. Images are shown through a short-lived signed link,
// made as the signed-in person, so the storage policy decides as it does for the rows.
function FileContent({ fileId }: { fileId: string }) {
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; blocks: CaseBlockView[]; links: Map<string, string> }
  >({ kind: "loading" });

  useEffect(() => {
    let live = true;
    const supabase = createClient();
    fetchCaseBlocks(supabase, fileId)
      .then(async (blocks) => {
        const paths = blocks.flatMap((b) => (b.image_path ? [b.image_path] : []));
        const links = new Map<string, string>();
        if (paths.length > 0) {
          const { data } = await supabase.storage.from(CASE_FILES_BUCKET).createSignedUrls(paths, 60 * 60);
          for (const item of data ?? []) if (item.path && item.signedUrl) links.set(item.path, item.signedUrl);
        }
        if (live) setState({ kind: "ready", blocks, links });
      })
      .catch((caught: unknown) => {
        if (live) setState({ kind: "error", message: caught instanceof Error ? caught.message : String(caught) });
      });
    return () => {
      live = false;
    };
  }, [fileId]);

  if (state.kind === "loading") return <p className="text-sm text-muted-foreground">Loading what was read…</p>;
  if (state.kind === "error") return <p className="text-sm text-danger">{state.message}</p>;
  if (state.blocks.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing was read from this file yet.</p>;
  }
  return (
    <ol className="grid max-h-[32rem] gap-2 overflow-y-auto rounded-md border bg-background p-2">
      {state.blocks.map((b) => (
        <li key={b.seq} className="grid gap-1">
          <p className="text-xs text-muted-foreground">
            {[b.page ? `Page ${b.page}` : null, b.label || null, describeParser(b.parser)].filter(Boolean).join(" · ")}
          </p>
          {b.kind === "text" ? (
            <pre className="text-sm whitespace-pre-wrap">{b.text}</pre>
          ) : b.image_path && state.links.get(b.image_path) ? (
            // A signed Storage link, not a static asset: next/image would try to optimise it.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={state.links.get(b.image_path)}
              alt={b.label || `Page ${b.page ?? "?"} as an image`}
              className="max-h-96 w-auto rounded border"
            />
          ) : (
            <p className="text-sm text-muted-foreground">An image that could not be opened.</p>
          )}
        </li>
      ))}
    </ol>
  );
}
