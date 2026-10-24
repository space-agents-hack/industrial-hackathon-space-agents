"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";

export type LibraryRegulation = { id: string; code: string; title: string | null };

// Which regulations of the organisation's library a project uses (SYS-32). "All" is the default
// and includes regulations imported later: the held-out case may bring new PDFs, and a regulation
// left out cannot be found by the writer at all (F2 weighs a miss four times an extra). Choosing a
// subset is for a client who knows their scope.
//
// The regulation search keeps to the choice when given the run's case (IF-3 as agreed on #24,
// agent domain/regulation_search.py). No run searches until the writer (#4) is built.
export function ProjectRegulations({
  organizationId,
  projectId,
  library,
  allRegulations,
  chosen,
  canEdit,
}: {
  organizationId: string;
  projectId: string;
  library: LibraryRegulation[];
  allRegulations: boolean;
  chosen: string[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [all, setAll] = useState(allRegulations);
  const [selected, setSelected] = useState(() => new Set(chosen));
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosenRegulations = library.filter((r) => chosen.includes(r.id));
  const shown = library.filter((r) =>
    `${r.code} ${r.title ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()),
  );

  async function save() {
    setBusy(true);
    setError(null);
    const supabase = createClient();
    try {
      const before = new Set(chosen);
      const add = [...selected].filter((id) => !before.has(id));
      const drop = chosen.filter((id) => !selected.has(id));
      // The list first, then the switch: a project briefly on "all" with a stale list is harmless,
      // a project briefly on "chosen" with an empty list is not.
      if (add.length > 0) {
        const { error: e } = await supabase
          .from("project_regulations")
          .insert(add.map((regulation_id) => ({ project_id: projectId, regulation_id, organization_id: organizationId })));
        if (e) throw new Error(`The regulations could not be added: ${e.message}`);
      }
      if (drop.length > 0) {
        const { error: e } = await supabase
          .from("project_regulations")
          .delete()
          .eq("project_id", projectId)
          .in("regulation_id", drop);
        if (e) throw new Error(`The regulations could not be removed: ${e.message}`);
      }
      if (all !== allRegulations) {
        const { error: e, count } = await supabase
          .from("projects")
          .update({ all_regulations: all }, { count: "exact" })
          .eq("id", projectId);
        if (e || count === 0) throw new Error(`The choice could not be saved: ${e?.message ?? "it needs the member role"}`);
      }
      setEditing(false);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  const summary = allRegulations
    ? `All ${library.length} regulations in the library, including any imported later.`
    : chosenRegulations.length === 0
      ? "None chosen: a run on this project would have no regulation to cite."
      : `${chosenRegulations.length} of ${library.length} regulations in the library.`;

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <p className={!allRegulations && chosenRegulations.length === 0 ? "text-danger" : ""}>{summary}</p>
        {canEdit && !editing ? (
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => setEditing(true)}>
            Choose
          </Button>
        ) : null}
      </div>
      {!allRegulations && chosenRegulations.length > 0 && !editing ? (
        <ul className="flex flex-wrap gap-1.5 text-sm">
          {chosenRegulations.map((r) => (
            <li key={r.id}>
              <Link href={`/regulations/${r.id}`} className="rounded border px-1.5 py-0.5 hover:bg-muted">
                {r.code}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}

      {editing ? (
        <div className="grid gap-2 rounded-md border bg-background p-3">
          <fieldset className="grid gap-1.5">
            <legend className="sr-only">Which regulations</legend>
            <label className="flex items-center gap-2">
              <input type="radio" name="scope" checked={all} onChange={() => setAll(true)} />
              All regulations in the library, now and later (recommended)
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="scope" checked={!all} onChange={() => setAll(false)} />
              Only the ones I choose
            </label>
          </fieldset>
          {!all ? (
            <>
              <p className="text-xs text-attention">
                A regulation left out cannot be found by the agent, and a missed requirement costs four times
                an extra one in Certivity&apos;s score. Keep the challenge project on all.
              </p>
              <input
                type="search"
                aria-label="Filter regulations"
                placeholder="Filter, e.g. R48 or lamps"
                className="h-8 rounded-md border border-input bg-card px-2 text-sm sm:max-w-sm"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <div className="flex gap-2 text-xs">
                <button type="button" className="underline" onClick={() => setSelected(new Set(library.map((r) => r.id)))}>
                  Select all
                </button>
                <button type="button" className="underline" onClick={() => setSelected(new Set())}>
                  Clear
                </button>
                <span className="text-muted-foreground">{selected.size} selected</span>
              </div>
              <ul className="grid max-h-72 gap-0.5 overflow-y-auto text-sm sm:grid-cols-2">
                {shown.map((r) => (
                  <li key={r.id}>
                    <label className="flex items-baseline gap-2 py-0.5">
                      <input
                        type="checkbox"
                        checked={selected.has(r.id)}
                        onChange={(event) => {
                          const next = new Set(selected);
                          if (event.target.checked) next.add(r.id);
                          else next.delete(r.id);
                          setSelected(next);
                        }}
                      />
                      <span className="font-medium">{r.code}</span>
                      {r.title ? <span className="truncate text-muted-foreground">{r.title}</span> : null}
                    </label>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <div className="flex gap-2">
            <Button disabled={busy || (!all && selected.size === 0)} onClick={() => void save()}>
              Save
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setAll(allRegulations);
                setSelected(new Set(chosen));
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
