"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { TASK_MAX_LENGTH } from "@/lib/validation";

// These match the records in agent/agent_service/domain/fixtures/plant.json, so they also work
// with the scripted model. Replace them together with the domain. They only fill the textarea.
const EXAMPLES: { label: string; task: string }[] = [
  {
    label: "ECN-1001: a collision",
    task: "Triage ECN-1001: bracket wall thickness 2.0 → 2.5 mm. Find affected assemblies, check fit, check open orders, and put the ECN on hold if anything collides.",
  },
  {
    label: "ECN-1002: everything fits",
    task: "Triage ECN-1002: cover plate thickness 1.5 → 1.6 mm. Find affected assemblies, check fit, check open orders, and put the ECN on hold if anything collides.",
  },
  {
    label: "ECN-4040: unknown record",
    task: "Triage ECN-4040 and put it on hold if anything collides.",
  },
];

export function NewRunForm({ organizationId }: { organizationId: string }) {
  const router = useRouter();
  const [task, setTask] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const trimmed = task.trim();

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
      setTask("");
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
      className="grid gap-2 rounded-md border bg-card p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void startRun();
      }}
    >
      <Label htmlFor="task">New run</Label>
      <Textarea
        id="task"
        name="task"
        required
        rows={3}
        maxLength={TASK_MAX_LENGTH}
        placeholder="Describe the task for the agent."
        className="max-h-80"
        value={task}
        onChange={(event) => setTask(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void startRun();
          }
        }}
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted-foreground">Examples:</span>
        {EXAMPLES.map((example) => (
          <Button
            key={example.label}
            type="button"
            variant="outline"
            size="sm"
            title={example.task}
            onClick={() => setTask(example.task)}
          >
            {example.label}
          </Button>
        ))}
        <Button type="submit" className="ml-auto" disabled={pending || trimmed === ""}>
          {pending ? "Starting…" : "Start run"}
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
