"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { deleteCase, deleteProject } from "@/lib/case-upload";
import { nameTakenMessage } from "@/lib/cases";
import { createClient } from "@/lib/supabase/client";

// The page title of a project or a case, with Rename and Delete for members (SYS-31). Delete asks
// once, in words that say what goes with it: a case's files and what was read from them; a
// project's cases too. Runs stay, without their case (runs.case_id is set null).
export function TitleActions({
  kind,
  id,
  name,
  canEdit,
  deleteWarning,
  afterDelete,
}: {
  kind: "project" | "case";
  id: string;
  name: string;
  canEdit: boolean;
  deleteWarning: string;
  afterDelete: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function rename() {
    const next = draft.trim();
    if (next === "" || next === name) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setError(null);
    const table = kind === "project" ? "projects" : "cases";
    const { error: e, count } = await createClient().from(table).update({ name: next }, { count: "exact" }).eq("id", id);
    setBusy(false);
    if (e) {
      setError(nameTakenMessage(e.code, kind, next) ?? `The ${kind} could not be renamed: ${e.message}`);
      return;
    }
    if (count === 0) {
      setError(`The ${kind} could not be renamed: it needs the member role in this organisation.`);
      return;
    }
    setEditing(false);
    router.refresh();
  }

  async function remove() {
    if (!window.confirm(`Delete ${kind} "${name}"? ${deleteWarning}`)) return;
    setBusy(true);
    setError(null);
    try {
      const supabase = createClient();
      const warning = kind === "project" ? await deleteProject(supabase, id) : await deleteCase(supabase, id);
      if (warning) console.warn(warning);
      router.push(afterDelete);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-1">
      <div className="flex flex-wrap items-center gap-2">
        {editing ? (
          <form
            className="flex min-w-0 flex-1 items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void rename();
            }}
          >
            <Input
              aria-label={`New ${kind} name`}
              autoFocus
              maxLength={200}
              value={draft}
              disabled={busy}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setDraft(name);
                  setEditing(false);
                }
              }}
              className="max-w-md text-base font-semibold"
            />
            <Button type="submit" size="sm" disabled={busy || draft.trim() === ""}>
              Save
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setDraft(name);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </form>
        ) : (
          <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{name}</h1>
        )}
        {canEdit && !editing ? (
          <div className="flex gap-1">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing(true)}>
              Rename
            </Button>
            <Button size="sm" variant="destructive" disabled={busy} onClick={() => void remove()}>
              Delete
            </Button>
          </div>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
