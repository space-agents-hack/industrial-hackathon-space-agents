"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { providerLabel } from "@/lib/admin";
import { createClient } from "@/lib/supabase/client";
import { MODEL_PATTERN } from "@/lib/validation";

// A model for each agent and process other than the writer (SYS-33). The writer's model is the
// form above (organization_settings.model): one place per setting, so two copies cannot disagree.
// What a process does with its model, and what changing it costs, is said next to each.
export const PROCESSES = [
  {
    id: "transcription",
    label: "Case transcription",
    help: "Reads what the parsers cannot: scanned pages, drawings, pictures. It transcribes, it does not reason, so a small model is enough.",
    used: true,
  },
  {
    id: "check",
    label: "Check agent",
    help: "Verifies each requirement against the stored paragraph (SYS-29). Not built yet: the choice is kept for when it is.",
    used: false,
  },
  {
    id: "summary",
    label: "Regulation summaries",
    help: "Writes the scope summary and keywords of each regulation version when the library is indexed; the agent reads them to choose which regulations to open. A cheap model is enough: it reads the first pages of each PDF once (about 0.7M tokens for 92 versions).",
    used: true,
  },
  {
    id: "chat",
    label: "Assistant",
    help: "Answers questions in the chat bubble on every page of a project, from the project's rows and a few paragraphs. Not the run's model: a small model does this well, and people ask many questions. An organisation whose run model is on its own Ollama server keeps the assistant there unless it chooses one here.",
    used: true,
  },
  {
    id: "embedding",
    label: "Embeddings",
    help: "Turns paragraphs and the case text into vectors for the regulation search. Vectors are kept per model: after a change the library has to be indexed again before vector search uses the new model (full-text search keeps working meanwhile), and changing back reuses the old vectors.",
    used: true,
  },
] as const;

// What the indexer can call (agent domain/regulation_search.py, docs/regulations-store.md): OpenAI's
// embeddings API, directly or through OpenRouter, at 1,024 dimensions, the stored vector's length.
// OpenAI directly is Ramón's choice; OpenRouter is the fallback for a team with only that key.
export const EMBEDDING_MODELS = [
  "openai:text-embedding-3-small",
  "openai:text-embedding-3-large",
  "openrouter:openai/text-embedding-3-small",
  "openrouter:openai/text-embedding-3-large",
] as const;

export type ProcessId = (typeof PROCESSES)[number]["id"];

export function ProcessModelsForm({
  org,
  stored,
  defaults,
  connected,
}: {
  org: string;
  stored: Partial<Record<ProcessId, string>>;
  defaults: Partial<Record<string, string>>;
  connected: string[];
}) {
  return (
    <ul className="divide-y rounded-md border bg-card">
      {PROCESSES.map((p) => (
        <ProcessRow
          key={p.id}
          org={org}
          process={p}
          stored={stored[p.id] ?? ""}
          fallback={defaults[p.id] ?? null}
          connected={connected}
        />
      ))}
    </ul>
  );
}

function ProcessRow({
  org,
  process,
  stored,
  fallback,
  connected,
}: {
  org: string;
  process: (typeof PROCESSES)[number];
  stored: string;
  fallback: string | null;
  connected: string[];
}) {
  const router = useRouter();
  const [value, setValue] = useState(stored);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = value.trim();
  const valid = trimmed === "" || MODEL_PATTERN.test(trimmed);
  const effective = trimmed || fallback || "";
  const provider = effective.includes(":") ? effective.slice(0, effective.indexOf(":")) : null;
  // Without the organisation's key the agent falls back to the deployment's environment key, which
  // may not exist; then the process fails file by file. Saying it here is cheaper.
  const missingKey = provider !== null && provider !== "scripted" && !connected.includes(provider);

  async function save() {
    if (process.id === "embedding" && trimmed !== stored) {
      const ok = window.confirm(
        "The library has to be indexed again with the new model before vector search uses it; until then paragraphs are found by full text only. The old vectors are kept. Change it?",
      );
      if (!ok) return;
    }
    setBusy(true);
    setError(null);
    const { error: e } = await createClient().rpc("set_organization_model", {
      org,
      model_process: process.id,
      new_model: trimmed,
    });
    setBusy(false);
    if (e) {
      setError(e.code === "42501" ? "Only an admin of this organisation changes its models." : e.message);
      return;
    }
    router.refresh();
  }

  return (
    <li className="grid gap-1.5 px-3 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium">{process.label}</span>
        {!process.used ? <span className="text-xs text-muted-foreground">(not read by the agent yet)</span> : null}
      </div>
      <p className="max-w-prose text-xs text-muted-foreground">{process.help}</p>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {process.id === "embedding" ? (
          // A fixed list: only these reach an embeddings endpoint the indexer knows, at the stored
          // vector length. The database refuses any other provider as well.
          <select
            aria-label={`${process.label} model`}
            className="h-8 max-w-md rounded-md border border-input bg-card px-2 font-mono text-sm"
            value={value}
            disabled={busy}
            onChange={(event) => setValue(event.target.value)}
          >
            <option value="">{fallback ? `Deployment default: ${fallback}` : "Deployment default"}</option>
            {[...EMBEDDING_MODELS, ...(stored && !(EMBEDDING_MODELS as readonly string[]).includes(stored) ? [stored] : [])].map(
              (m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ),
            )}
          </select>
        ) : (
          <Input
            aria-label={`${process.label} model`}
            placeholder={fallback ? `Deployment default: ${fallback}` : "Deployment default"}
            maxLength={200}
            value={value}
            disabled={busy}
            aria-invalid={!valid}
            onChange={(event) => setValue(event.target.value)}
            className="max-w-md font-mono text-sm"
          />
        )}
        <Button type="submit" variant="outline" disabled={busy || !valid || trimmed === stored}>
          Save
        </Button>
      </form>
      {!valid ? <p className="text-xs text-danger">Write it as provider:model, for example anthropic:claude-haiku-5-5.</p> : null}
      {valid && missingKey && provider ? (
        <p className="text-xs text-attention">
          This organisation has no {providerLabel(provider)} key. It works only if the deployment has one; add the
          organisation&apos;s own under Providers to be sure.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </li>
  );
}
