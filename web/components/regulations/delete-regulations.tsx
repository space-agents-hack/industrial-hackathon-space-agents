"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type LibraryPart, confirmsClear, describeConsequences, describeDeletion } from "@/lib/regulations";
import { sendJson } from "@/lib/send-json";

type Answer = { regulations: number; versions: number; paragraphs: number; requirements_unlinked: number; warning?: string };

async function send(payload: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
  const result = await sendJson<Answer>("/api/regulations", "DELETE", payload);
  if (!result.ok) return { ok: false, text: result.error };
  const b = result.body;
  const done = describeDeletion({
    regulations: b.regulations,
    versions: b.versions,
    paragraphs: b.paragraphs,
    requirementsUnlinked: b.requirements_unlinked,
    paths: [],
  });
  return { ok: true, text: b.warning ? `${done} ${b.warning}` : done };
}

function Consequences({ part }: { part: LibraryPart }) {
  const { removed, kept } = describeConsequences(part);
  return (
    <>
      <p>{removed}</p>
      <p className="text-muted-foreground">{kept}</p>
    </>
  );
}

// On each row of the list, for admins. The list shows the project's regulations, but the delete
// is from the organisation's library, so the confirmation says so and points to the project's
// choice for someone who only wanted it out of this project.
export function DeleteRegulation({
  org,
  orgName,
  regulationId,
  code,
  part,
  projectHref,
  blocked,
}: {
  org: string;
  orgName: string;
  regulationId: string;
  code: string;
  part: LibraryPart;
  projectHref: string;
  // Why it cannot be deleted now (an import in progress), or null.
  blocked: string | null;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setError(null);
    const result = await send({ organization_id: org, regulation_ids: [regulationId] });
    setBusy(false);
    if (!result.ok) {
      setError(result.text);
      return;
    }
    // The row is gone after the refresh; a warning about leftover PDFs would go with it, so it is
    // logged by the route rather than shown here.
    router.refresh();
  }

  if (!confirming) {
    return (
      <Button
        size="xs"
        variant="ghost"
        className="text-muted-foreground"
        disabled={blocked !== null}
        title={blocked ?? `Delete ${code} from the library`}
        onClick={() => setConfirming(true)}
      >
        Delete
      </Button>
    );
  }
  return (
    <div className="grid w-full gap-2 rounded-md border border-danger-border bg-danger-surface p-3 text-sm">
      <p className="font-medium text-danger">
        Delete {code} from the library of {orgName}?
      </p>
      <Consequences part={part} />
      <p className="text-muted-foreground">
        To leave it out of this project only,{" "}
        <a href={projectHref} className="text-tint underline-offset-4 hover:underline">
          change the project&apos;s choice
        </a>{" "}
        instead.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="destructive" disabled={busy} onClick={() => void remove()}>
          {busy ? "Deleting…" : `Delete ${code}`}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// At the end of the admin's part of the page. Typing the organisation's name is the confirmation:
// one click must never empty the library every project of the organisation cites.
export function ClearLibrary({
  org,
  orgName,
  part,
  blocked,
}: {
  org: string;
  orgName: string;
  part: LibraryPart;
  blocked: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function clear() {
    setBusy(true);
    setMessage(null);
    const result = await send({ organization_id: org, all: true, confirm: typed });
    setBusy(false);
    setMessage(result);
    if (result.ok) {
      setOpen(false);
      setTyped("");
    }
    router.refresh();
  }

  return (
    <section className="grid gap-3">
      <h2 className="text-base font-semibold">Clear the library</h2>
      <p className="max-w-prose text-muted-foreground">
        Deletes every regulation of {orgName}, for all its projects, so the library can be imported again from
        scratch. Requirements already written are kept.
      </p>
      {open ? (
        <form
          className="grid max-w-prose gap-2 rounded-md border border-danger-border bg-danger-surface p-3 text-sm"
          onSubmit={(event) => {
            event.preventDefault();
            if (confirmsClear(typed, orgName)) void clear();
          }}
        >
          <Consequences part={part} />
          <Label htmlFor="clear-library-confirm">
            Type <span className="font-mono">{orgName}</span> to confirm
          </Label>
          <Input
            id="clear-library-confirm"
            autoComplete="off"
            value={typed}
            disabled={busy}
            onChange={(event) => setTyped(event.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" variant="destructive" disabled={busy || !confirmsClear(typed, orgName)}>
              {busy ? "Clearing…" : `Delete all ${part.regulations} regulations`}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                setTyped("");
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="destructive"
            disabled={blocked !== null}
            onClick={() => {
              setMessage(null);
              setOpen(true);
            }}
          >
            Clear library…
          </Button>
          {blocked ? <span className="text-xs text-muted-foreground">{blocked}</span> : null}
        </div>
      )}
      {message ? (
        <p role={message.ok ? "status" : "alert"} className={message.ok ? "text-success" : "text-danger"}>
          {message.text}
        </p>
      ) : null}
    </section>
  );
}
