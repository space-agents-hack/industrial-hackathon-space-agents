"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { FilePickerButton } from "@/components/file-picker-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ACCEPT, MAX_FILES, describeSize, refusal } from "@/lib/case-files";
import { parseCase, startCaseRun, uploadCaseFiles } from "@/lib/case-upload";
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

function nameTaken(code: string | undefined, what: string, name: string): string | null {
  return code === "23505" ? `A ${what} called "${name}" already exists here. Pick it from the list.` : null;
}

export function NewRunForm({
  organizationId,
  projects,
  cases,
  fixedProject = false,
  blockers = [],
}: {
  organizationId: string;
  projects: ProjectOption[];
  cases: CaseOption[];
  // Inside a project (SYS-36) the run is on that project: no project choice, no new project.
  fixedProject?: boolean;
  // Why no run can start here whatever the form holds (lib/run-readiness.ts), e.g. no regulation.
  blockers?: string[];
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
  // A run needs at least one file in its case (lib/run-readiness.ts); notes alone are not a case.
  const hasContent = files.length > 0 || shownFiles.length > 0;
  const canStart = named && hasContent && blockers.length === 0 && pending === null;

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
    await uploadCaseFiles(createClient(), organizationId, target, files, shownFiles, setPending);
    setFiles([]);
  }

  async function startRun() {
    if (!canStart) return;
    setError(null);
    try {
      const target = await resolveCase();
      await uploadInto(target);
      const rows = await parseCase(createClient(), target, setCaseFiles, setPending);
      const failed = rows.filter((f) => f.status === "failed");
      if (failed.length > 0 && failed.length === rows.length && trimmed === "") {
        setError("No file of this case could be read, so there is nothing to run on. See the reasons above.");
        return;
      }
      setPending("Starting…");
      const path = await startCaseRun(organizationId, target, trimmed, null);
      setSpec("");
      router.push(path);
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
        <h2 className="text-sm font-semibold">Quick run: find the requirements for a product</h2>
        <p className="text-xs text-muted-foreground">
          Put the case together: specification, exploded view, datasheets, drawings, BOM or CAD files.
          Everyone in this organisation sees the case. The agent lists the requirements the product
          must fulfil under the UN Regulations, each with its regulation, page and paragraph. To add
          files without running, rename or delete, open the case under{" "}
          <Link href={fixedProject ? `/projects/${projects[0]?.id}` : "/projects"} className="underline-offset-4 hover:underline">
            Cases
          </Link>
          .
        </p>
      </div>

      <div className={fixedProject ? "grid gap-3 sm:max-w-md" : "grid gap-3 sm:grid-cols-2"}>
        <div className={fixedProject ? "hidden" : "grid gap-1.5"}>
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
        <span className="text-sm font-medium">Files</span>
        <div>
          <FilePickerButton
            label={files.length === 0 ? "Choose files…" : "Choose more files…"}
            accept={ACCEPT}
            multiple
            disabled={busy}
            onPick={addFiles}
          />
        </div>
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

      {blockers.map((b) => (
        <p key={b} className="text-sm text-attention">
          {b}
        </p>
      ))}
      <div className="flex items-center gap-2">
        {pending ? <span className="text-xs text-muted-foreground">{pending}</span> : null}
        {!hasContent && blockers.length === 0 ? (
          <span className="text-xs text-muted-foreground">Choose at least one file to start.</span>
        ) : null}
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
