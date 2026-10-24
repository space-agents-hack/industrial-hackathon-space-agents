"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { TASK_MAX_LENGTH } from "@/lib/validation";

// The run's task is the specification itself, with nothing added. What the agent does with it
// (find the UN Regulation requirements, cite regulation, version, page and paragraph) belongs in
// agent/agent_service/domain/prompt.md, so the instruction lives in one place, and the run list,
// which previews the start of the task, shows each product instead of the same instruction.
//
// The exploded view is not sent yet. A 44 kB image is about 59,000 characters as base64, over the
// 20,000-character check on runs.task, so it needs its own storage and the runner must hand it
// to the model as an image (issue #8). The picker is shown disabled so nobody believes it was
// read.

export function NewRunForm({ organizationId }: { organizationId: string }) {
  const router = useRouter();
  const [spec, setSpec] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const trimmed = spec.trim();

  async function loadSpecFile(file: File | undefined) {
    if (!file) return;
    try {
      const text = await file.text();
      // Counted as the database counts (characters), the same rule parseNewRun applies.
      if (Array.from(text).length > TASK_MAX_LENGTH) {
        setError(`${file.name} is longer than ${TASK_MAX_LENGTH} characters.`);
        return;
      }
      setError(null);
      setSpec(text);
    } catch {
      setError(`${file.name} could not be read.`);
    }
  }

  async function startRun() {
    if (trimmed === "" || pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task: trimmed, organization_id: organizationId }),
      });
      const body: { id?: string; warning?: string; error?: string } = await response
        .json()
        .catch(() => ({}));
      if (!response.ok || !body.id) {
        setError(body.error ?? `The run could not be started (${response.status}).`);
        return;
      }
      setSpec("");
      // With a warning the run exists but the agent never heard of it; the run page says so and
      // offers Send to agent.
      router.push(`/runs/${body.id}${body.warning ? "?agent=unreachable" : ""}`);
    } catch {
      setError("The run could not be started: the server did not answer.");
    } finally {
      setPending(false);
    }
  }

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
          Give the technical specification of a component or product. The agent lists the
          requirements it must fulfil under the UN Regulations, each with its regulation, page and
          paragraph.
        </p>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="spec">Technical specification</Label>
        <Textarea
          id="spec"
          name="spec"
          required
          rows={8}
          maxLength={TASK_MAX_LENGTH}
          placeholder="Paste the specification, or load a .md or .txt file below."
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
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="spec-file" className="text-xs text-muted-foreground">
            Load from file
          </Label>
          <input
            id="spec-file"
            type="file"
            accept=".md,.txt,text/markdown,text/plain"
            className="text-xs"
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Cleared so that choosing the same file again, after editing, reloads it.
              event.target.value = "";
              void loadSpecFile(file);
            }}
          />
        </div>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="exploded-view">Exploded view</Label>
        <input
          id="exploded-view"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          disabled
          aria-describedby="exploded-view-note"
          className="text-xs disabled:opacity-60"
        />
        <p id="exploded-view-note" className="text-xs text-muted-foreground">
          Not sent to the agent yet. Describe the components in the specification for now.
        </p>
      </div>

      <div className="flex items-center">
        <Button type="submit" className="ml-auto" disabled={pending || trimmed === ""}>
          {pending ? "Starting…" : "Find requirements"}
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
