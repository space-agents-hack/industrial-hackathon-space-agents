"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  ACCEPT,
  CASE_FILES_BUCKET,
  MAX_FILES,
  casePath,
  describeSize,
  formatOf,
  isSettled,
  refusal,
} from "@/lib/case-files";
import { type CaseFileView, type CaseOption, type ProjectOption, fetchCaseFiles } from "@/lib/cases";
import { createClient } from "@/lib/supabase/client";
import { TASK_MAX_LENGTH } from "@/lib/validation";

// The run's task is what the engineer types, with nothing added. What the agent does with it
// (find the UN Regulation requirements, cite regulation, version, page and paragraph) belongs in
// agent/agent_service/domain/prompt.md, so the instruction lives in one place.
//
// A run is on a case (ADR-0006): organisation -> project -> case, shared by every member. Files
// go from the browser straight to the private bucket, into the case's folder, as the signed-in
// user; a Vercel function refuses bodies over 4.5 MB, so one datasheet would not fit through the
// API (issue #8). The agent parses each file once, and the run reads what it stored.

const NEW = "new";
// How long the form waits for the parse before starting the run anyway. The run's trace then
// says which files the agent did not have, which beats a button that spins for ever on a file a
// dead request left `parsing`.
const PARSE_WAIT_MS = 10 * 60 * 1000;
// Polling, not Realtime: one select every two seconds for a minute is cheap, and it needs no
// channel that can silently drop.
const POLL_MS = 2000;

async function sha256(file: File): Promise<string | null> {
  // Recorded so a run can later be matched to the exact file it read. Optional: a browser
  // without SubtleCrypto (plain http on a LAN address) still uploads.
  if (!globalThis.crypto?.subtle) return null;
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function nameTaken(code: string | undefined, what: string, name: string): string | null {
  return code === "23505" ? `A ${what} called "${name}" already exists here. Pick it from the list.` : null;
}

export function NewRunForm({
  organizationId,
  projects,
  cases,
}: {
  organizationId: string;
  projects: ProjectOption[];
  cases: CaseOption[];
}) {
  const router = useRouter();
  const [projectId, setProjectId] = useState(projects[0]?.id ?? NEW);
  const [projectName, setProjectName] = useState("");
  const casesHere = cases.filter((c) => c.project_id === projectId);
  const [caseId, setCaseId] = useState(casesHere[0]?.id ?? NEW);
  const [caseName, setCaseName] = useState("");
  const [caseFiles, setCaseFiles] = useState<CaseFileView[]>([]);
  const [spec, setSpec] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  // The files already in the chosen case, so the engineer sees what the run will read.
  useEffect(() => {
    if (caseId === NEW) return;
    let live = true;
    fetchCaseFiles(createClient(), caseId)
      .then((rows) => live && setCaseFiles(rows))
      .catch((caught: unknown) => live && setError(caught instanceof Error ? caught.message : String(caught)));
    return () => {
      live = false;
    };
  }, [caseId]);
  const shownFiles = caseId === NEW ? [] : caseFiles;

  const trimmed = spec.trim();
  const named = (projectId !== NEW || projectName.trim() !== "") && (caseId !== NEW || caseName.trim() !== "");
  const hasContent = trimmed !== "" || files.length > 0 || shownFiles.length > 0;
  const canStart = named && hasContent && pending === null;

  function pickProject(id: string) {
    setProjectId(id);
    setCaseId(cases.find((c) => c.project_id === id)?.id ?? NEW);
  }

  function addFiles(list: FileList | null) {
    if (!list) return;
    const added: File[] = [];
    const problems: string[] = [];
    for (const file of Array.from(list)) {
      const reason = refusal(file);
      if (reason) problems.push(reason);
      else added.push(file);
    }
    const next = [...files, ...added];
    if (next.length > MAX_FILES) problems.push(`At most ${MAX_FILES} files at a time.`);
    setFiles(next.slice(0, MAX_FILES));
    setError(problems.length ? problems.join(" ") : null);
  }

  // Creates what does not exist yet, with ids made here: the case's id names its Storage folder,
  // which has to be known before the first upload.
  async function resolveCase(): Promise<string> {
    const supabase = createClient();
    let project = projectId;
    if (project === NEW) {
      const name = projectName.trim();
      project = crypto.randomUUID();
      setPending(`Creating project ${name}…`);
      const { error: e } = await supabase.from("projects").insert({ id: project, organization_id: organizationId, name });
      if (e) throw new Error(nameTaken(e.code, "project", name) ?? `The project could not be created: ${e.message}`);
      setProjectId(project);
    }
    let target = caseId;
    if (target === NEW) {
      const name = caseName.trim();
      target = crypto.randomUUID();
      setPending(`Creating case ${name}…`);
      const { error: e } = await supabase
        .from("cases")
        .insert({ id: target, project_id: project, organization_id: organizationId, name });
      if (e) throw new Error(nameTaken(e.code, "case", name) ?? `The case could not be created: ${e.message}`);
      setCaseId(target);
    }
    return target;
  }

  async function uploadInto(target: string): Promise<void> {
    const supabase = createClient();
    const first = shownFiles.reduce((max, f) => Math.max(max, f.position + 1), 0);
    const rows = [];
    for (const [index, file] of files.entries()) {
      setPending(`Uploading ${file.name} (${index + 1} of ${files.length})…`);
      const position = first + index;
      const path = casePath(organizationId, target, position, file.name);
      const { error: e } = await supabase.storage
        .from(CASE_FILES_BUCKET)
        .upload(path, file, { contentType: file.type || "application/octet-stream", upsert: false });
      if (e) throw new Error(`${file.name} could not be uploaded: ${e.message}`);
      rows.push({
        case_id: target,
        organization_id: organizationId,
        position,
        storage_path: path,
        filename: file.name.slice(0, 255),
        // refusal() let only known formats into the list.
        format: formatOf(file.name)!,
        media_type: file.type || null,
        bytes: file.size,
        sha256: await sha256(file),
      });
    }
    if (rows.length === 0) return;
    const { error: e } = await supabase.from("case_files").insert(rows);
    if (e) throw new Error(`The files were uploaded but not added to the case: ${e.message}`);
    setFiles([]);
  }

  // Asks the agent to parse, then waits until every file of the case is parsed or failed.
  async function parse(target: string): Promise<CaseFileView[]> {
    const supabase = createClient();
    let rows = await fetchCaseFiles(supabase, target);
    setCaseFiles(rows);
    if (rows.every((f) => isSettled(f.status))) return rows;
    setPending("Reading the files…");
    const response = await fetch(`/api/cases/${target}/ingest`, { method: "POST" });
    if (!response.ok) {
      const body: { error?: string } = await response.json().catch(() => ({}));
      throw new Error(body.error ?? `The files could not be sent to the agent (${response.status}).`);
    }
    const until = Date.now() + PARSE_WAIT_MS;
    while (Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      rows = await fetchCaseFiles(supabase, target);
      setCaseFiles(rows);
      const done = rows.filter((f) => isSettled(f.status)).length;
      if (done === rows.length) break;
      setPending(`Reading the files… ${done} of ${rows.length} done`);
    }
    return rows;
  }

  async function startRun() {
    if (!canStart) return;
    setError(null);
    try {
      const target = await resolveCase();
      await uploadInto(target);
      const rows = await parse(target);
      const failed = rows.filter((f) => f.status === "failed");
      if (failed.length > 0 && failed.length === rows.length && trimmed === "") {
        setError("No file of this case could be read, so there is nothing to run on. See the reasons above.");
        return;
      }
      setPending("Starting…");
      const response = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task: trimmed, organization_id: organizationId, case_id: target }),
      });
      const body: { id?: string; warning?: string; error?: string } = await response.json().catch(() => ({}));
      if (!response.ok || !body.id) {
        setError(body.error ?? `The run could not be started (${response.status}).`);
        return;
      }
      setSpec("");
      // With a warning the run exists but the agent never heard of it; the run page says so and
      // offers Send to agent.
      router.push(`/runs/${body.id}${body.warning ? "?agent=unreachable" : ""}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The run could not be started: the server did not answer.");
    } finally {
      setPending(null);
    }
  }

  const busy = pending !== null;

  return (
    <form
      className="grid gap-3 rounded-md border bg-card p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void startRun();
      }}
    >
      <div className="grid gap-1">
        <h2 className="text-sm font-semibold">Find the requirements for a product</h2>
        <p className="text-xs text-muted-foreground">
          Put the case together: specification, exploded view, datasheets, drawings, BOM or CAD files.
          Everyone in this organisation sees the case. The agent lists the requirements the product
          must fulfil under the UN Regulations, each with its regulation, page and paragraph.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="project">Project</Label>
          <select
            id="project"
            className="h-8 rounded-md border bg-background px-2 text-sm"
            value={projectId}
            disabled={busy}
            onChange={(event) => pickProject(event.target.value)}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            <option value={NEW}>New project…</option>
          </select>
          {projectId === NEW ? (
            <Input
              aria-label="New project name"
              placeholder="e.g. Rear lamp, model X"
              maxLength={200}
              value={projectName}
              disabled={busy}
              onChange={(event) => setProjectName(event.target.value)}
            />
          ) : null}
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="case">Case</Label>
          <select
            id="case"
            className="h-8 rounded-md border bg-background px-2 text-sm"
            value={caseId}
            disabled={busy}
            onChange={(event) => setCaseId(event.target.value)}
          >
            {casesHere.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            <option value={NEW}>New case…</option>
          </select>
          {caseId === NEW ? (
            <Input
              aria-label="New case name"
              placeholder="e.g. Housing, revision B"
              maxLength={200}
              value={caseName}
              disabled={busy}
              onChange={(event) => setCaseName(event.target.value)}
            />
          ) : null}
        </div>
      </div>

      {shownFiles.length > 0 ? (
        <div className="grid gap-1">
          <p className="text-xs font-medium">In this case</p>
          <ul className="grid gap-1 text-xs">
            {shownFiles.map((f) => (
              <li key={f.id} className="grid gap-0.5">
                <div className="flex items-center gap-2">
                  <span className="truncate font-mono">{f.filename}</span>
                  <span className="text-muted-foreground">{describeSize(f.bytes)}</span>
                  <span className={`ml-auto ${f.status === "failed" ? "text-danger" : "text-muted-foreground"}`}>
                    {f.status}
                  </span>
                </div>
                {f.error ? <span className="text-danger">{f.error}</span> : null}
                {f.notes.map((n) => (
                  <span key={n} className="text-muted-foreground">
                    {n}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="grid gap-1.5">
        <Label htmlFor="case-files">Add files</Label>
        <input
          id="case-files"
          type="file"
          multiple
          accept={ACCEPT}
          className="text-xs"
          disabled={busy}
          onChange={(event) => {
            addFiles(event.target.files);
            // Cleared so that choosing the same file again, after removing it, adds it back.
            event.target.value = "";
          }}
        />
        <p className="text-xs text-muted-foreground">
          .md .txt .csv .json, .png .jpg .webp, .pdf, .docx, .xlsx, CAD .step .iges .stl. Up to {MAX_FILES}{" "}
          files at a time, 25 MB each. Each file is read once when added. CAD files are read for part
          names and structure, not geometry; drawings and pictures are also described by a model, marked
          as such.
        </p>
        {files.length > 0 ? (
          <ul className="grid gap-1 text-xs">
            {files.map((file, index) => (
              <li key={`${index}-${file.name}`} className="flex items-center gap-2">
                <span className="truncate font-mono">{file.name}</span>
                <span className="text-muted-foreground">{describeSize(file.size)}</span>
                <button
                  type="button"
                  className="ml-auto text-muted-foreground underline"
                  disabled={busy}
                  onClick={() => setFiles(files.filter((_, i) => i !== index))}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="spec">Notes for this run (optional)</Label>
        <Textarea
          id="spec"
          name="spec"
          rows={4}
          maxLength={TASK_MAX_LENGTH}
          placeholder="Anything the files do not say, or paste a specification here."
          className="max-h-96 font-mono text-xs"
          value={spec}
          onChange={(event) => setSpec(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void startRun();
            }
          }}
        />
      </div>

      <div className="flex items-center gap-2">
        {pending ? <span className="text-xs text-muted-foreground">{pending}</span> : null}
        <Button type="submit" className="ml-auto" disabled={!canStart}>
          {pending ? "Working…" : "Find requirements"}
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
