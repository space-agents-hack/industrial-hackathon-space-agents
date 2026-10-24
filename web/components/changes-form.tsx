"use client";

import { useMemo, useState } from "react";

import { CertivityChecks } from "@/components/certivity-checks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  type ChangesResult,
  type OldRequirement,
  type SubgoalCase,
  type VersionOption,
  citedRegulation,
  defaultPair,
  describeCounts,
  readRequirementsFile,
} from "@/lib/changes";

export type RegulationOption = { id: string; code: string; versions: VersionOption[] };

const UPLOAD = "__upload__";

const SELECT = "h-8 w-full rounded-md border bg-transparent px-2 text-sm";

type Uploaded = { name: string; requirements: OldRequirement[] };
type State = { phase: "idle" } | { phase: "running" } | { phase: "failed"; error: string } | { phase: "done"; result: ChangesResult };

export function ChangesForm({
  org,
  teamName,
  regulations,
  cases,
}: {
  org: string;
  teamName: string;
  regulations: RegulationOption[];
  cases: SubgoalCase[] | null;
}) {
  const loaded = cases ?? [];
  const [source, setSource] = useState<string>(loaded[0]?.caseId ?? UPLOAD);
  const [uploaded, setUploaded] = useState<Uploaded | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [caseId, setCaseId] = useState(loaded[0]?.caseId ?? "subgoal-heldout");
  // The organisation's name, as the writer's team_id (Clemente, 2026-10-24); still editable.
  const [teamId, setTeamId] = useState(teamName);
  const [state, setState] = useState<State>({ phase: "idle" });

    const [regulationId, setRegulationId] = useState(
    () => regulations.find((r) => r.code === loaded[0]?.regulation)?.id ?? regulations[0].id,
  );
  const regulation = regulations.find((r) => r.id === regulationId) ?? regulations[0];
  const pair = useMemo(() => defaultPair(regulation.versions), [regulation]);
  const [oldId, setOldId] = useState(pair?.[0] ?? "");
  const [newId, setNewId] = useState(pair?.[1] ?? "");

  function chooseRegulation(id: string) {
    const next = regulations.find((r) => r.id === id);
    if (!next) return;
    setRegulationId(id);
    const nextPair = defaultPair(next.versions);
    setOldId(nextPair?.[0] ?? "");
    setNewId(nextPair?.[1] ?? "");
    setState({ phase: "idle" });
  }

  function chooseSource(value: string) {
    setSource(value);
    setState({ phase: "idle" });
    if (value === UPLOAD) return;
    setCaseId(value);
    const code = loaded.find((c) => c.caseId === value)?.regulation;
    const match = regulations.find((r) => r.code === code);
    if (match) chooseRegulation(match.id);
  }

  async function loadFile(file: File | undefined) {
    if (!file) return;
    const parsed = readRequirementsFile(await file.text().catch(() => ""));
    if (!parsed.ok) {
      setUploaded(null);
      setUploadError(`${file.name}: ${parsed.error}`);
      return;
    }
    setUploaded({ name: file.name, requirements: parsed.value });
    setUploadError(null);
    const match = regulations.find((r) => r.code === citedRegulation(parsed.value));
    if (match) chooseRegulation(match.id);
  }

  async function run() {
    setState({ phase: "running" });
    try {
      const response = await fetch("/api/changes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organization_id: org,
          old_version_id: oldId,
          new_version_id: newId,
          case_id: caseId.trim(),
          team_id: teamId.trim(),
          requirements_old: source === UPLOAD ? (uploaded?.requirements ?? null) : null,
        }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const error =
          typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string"
            ? (body as { error: string }).error
            : `The comparison could not run (${response.status}).`;
        setState({ phase: "failed", error });
        return;
      }
      // The route passes the agent's answer through after checking its shape.
      setState({ phase: "done", result: body as ChangesResult });
    } catch {
      setState({ phase: "failed", error: "The server did not answer." });
    }
  }

  const ready =
    oldId !== "" &&
    newId !== "" &&
    oldId !== newId &&
    teamId.trim() !== "" &&
    caseId.trim() !== "" &&
    (source !== UPLOAD || uploaded !== null);

  return (
    <div className="grid gap-4">
      <form
        className="grid gap-3 rounded-md border bg-card p-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) void run();
        }}
      >
        <div className="grid gap-1">
          <h2 className="text-sm font-semibold">Which requirements does a new version change?</h2>
          <p className="text-xs text-muted-foreground">
            Compares two versions of a regulation sentence by sentence and traces each old requirement to the sentences
            it was written from. Requirements whose sentences changed are <em>modified</em>, those whose sentences are gone
            are <em>removed</em>, and new obligations are <em>added</em>. Wording-only edits such as &ldquo;70%&rdquo; to
            &ldquo;70 per cent&rdquo; do not count. No model is used and nothing is stored or uploaded.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="changes-source">Requirements of the old version</Label>
            <select id="changes-source" className={SELECT} value={source} onChange={(e) => chooseSource(e.target.value)}>
              {loaded.map((c) => (
                <option key={c.caseId} value={c.caseId}>
                  Certivity case {c.caseId}
                  {c.regulation ? ` (${c.regulation})` : ""}
                </option>
              ))}
              <option value={UPLOAD}>Upload a requirements file…</option>
            </select>
            {cases === null ? (
              <p className="text-xs text-muted-foreground">The loaded Certivity cases could not be listed; upload a file instead.</p>
            ) : null}
            {source === UPLOAD ? (
              <div className="grid gap-1">
                <input
                  aria-label="Requirements file"
                  type="file"
                  accept=".json,application/json"
                  className="text-xs"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    void loadFile(file);
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  {uploaded
                    ? `${uploaded.name}: ${uploaded.requirements.length} requirements.`
                    : 'A list like requirements_old.json: [{ "id", "text", "source": { "page", "paragraph" } }].'}
                </p>
                {uploadError ? (
                  <p role="alert" className="text-xs text-danger">
                    {uploadError}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="changes-regulation">Regulation</Label>
            <select id="changes-regulation" className={SELECT} value={regulation.id} onChange={(e) => chooseRegulation(e.target.value)}>
              {regulations.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.code}
                </option>
              ))}
            </select>
            <div className="grid grid-cols-2 gap-2">
              <VersionSelect id="changes-old" label="Old version" versions={regulation.versions} value={oldId} onChange={setOldId} />
              <VersionSelect id="changes-new" label="New version" versions={regulation.versions} value={newId} onChange={setNewId} />
            </div>
            {oldId !== "" && oldId === newId ? <p className="text-xs text-danger">Choose two different versions.</p> : null}
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="changes-case">Case id in the file</Label>
            <Input id="changes-case" value={caseId} onChange={(e) => setCaseId(e.target.value)} placeholder="subgoal-heldout" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="changes-team">Team id</Label>
            <Input id="changes-team" value={teamId} onChange={(e) => setTeamId(e.target.value)} placeholder="team-07" />
          </div>
        </div>

        <div className="flex items-center gap-3">
          {state.phase === "failed" ? (
            <p role="alert" className="text-sm text-danger">
              {state.error}
            </p>
          ) : null}
          <Button type="submit" className="ml-auto" disabled={!ready || state.phase === "running"}>
            {state.phase === "running" ? "Comparing…" : "Compare"}
          </Button>
        </div>
      </form>

      {state.phase === "done" ? <Result result={state.result} org={org} /> : null}
    </div>
  );
}

function VersionSelect({
  id,
  label,
  versions,
  value,
  onChange,
}: {
  id: string;
  label: string;
  versions: VersionOption[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="grid gap-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <select id={id} className={SELECT} value={value} onChange={(e) => onChange(e.target.value)}>
        {versions.map((v) => (
          <option key={v.id} value={v.id}>
            {v.label}
            {v.role ? ` (${v.role})` : ""}
          </option>
        ))}
      </select>
    </div>
  );
}

function Result({ result, org }: { result: ChangesResult; org: string }) {
  // The exact JSON the agent wrote: this text is what the checks validate and what downloads.
  const text = useMemo(() => JSON.stringify(result.submission, null, 2), [result]);
  return (
    <div className="grid gap-4">
      <section className="grid gap-1" aria-live="polite">
        <h2 className="text-xs font-medium text-muted-foreground">
          {result.regulation} {result.oldVersion} → {result.newVersion}
        </h2>
        <div className="grid gap-2 rounded-md border bg-card px-3 py-2 text-sm">
          <p>
            <span className="font-medium">{describeCounts(result.counts)}</span>
            <span className="text-muted-foreground">, from {result.requirements} old requirements.</span>
          </p>
          {result.changes.length === 0 ? (
            <p className="text-muted-foreground">No requirement changes between these versions.</p>
          ) : (
            <ul className="grid max-h-[32rem] gap-2 overflow-y-auto">
              {result.changes.map((c, i) => (
                <li key={`${c.requirementId ?? "new"}-${i}`} className="grid gap-0.5 border-t pt-2 first:border-t-0 first:pt-0">
                  <p className="text-xs">
                    <span className="font-medium">{c.change}</span>
                    {c.requirementId ? <span className="font-mono"> {c.requirementId}</span> : null}
                    {c.paragraph || c.page ? (
                      <span className="text-muted-foreground">
                        {" "}
                        · {c.paragraph ? `paragraph ${c.paragraph}` : ""}
                        {c.paragraph && c.page ? ", " : ""}
                        {c.page ? `page ${c.page}` : ""}
                      </span>
                    ) : null}
                  </p>
                  {c.newText ? <p className="break-words">{c.newText}</p> : null}
                  <p className="break-words text-xs text-muted-foreground">{c.reason}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
      {/* Certivity's validate.py through the agent, the same check the platform runs on upload. */}
      <CertivityChecks text={text} organizationId={org} />
    </div>
  );
}
