"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { nameTakenMessage } from "@/lib/cases";
import { rememberProject } from "@/lib/project-actions";
import { createClient } from "@/lib/supabase/client";

// "New project" on the projects page and "New case" on a project page. The id is made here, as in
// the quick-run form: a case's id names its Storage folder, and the page to open next needs it.
export function NewNamedForm({
  kind,
  organizationId,
  projectId,
  placeholder,
}: {
  kind: "project" | "case";
  organizationId: string;
  projectId?: string;
  placeholder: string;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    const trimmed = name.trim();
    if (trimmed === "") return;
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const id = crypto.randomUUID();
    const { error: e } =
      kind === "project"
        ? await supabase.from("projects").insert({ id, organization_id: organizationId, name: trimmed })
        : await supabase
            .from("cases")
            .insert({ id, project_id: projectId!, organization_id: organizationId, name: trimmed });
    if (e) {
      setBusy(false);
      setError(nameTakenMessage(e.code, kind, trimmed) ?? `The ${kind} could not be created: ${e.message}`);
      return;
    }
    // A new project becomes the one the person works in (SYS-36).
    if (kind === "project") await rememberProject(id);
    router.push(kind === "project" ? `/projects/${id}` : `/projects/${projectId}/cases/${id}`);
  }

  return (
    <form
      className="grid gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
    >
      <div className="flex gap-2">
        <Input
          aria-label={`New ${kind} name`}
          placeholder={placeholder}
          maxLength={200}
          value={name}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
          className="max-w-sm"
        />
        <Button type="submit" variant="outline" disabled={busy || name.trim() === ""}>
          {kind === "project" ? "New project" : "New case"}
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
