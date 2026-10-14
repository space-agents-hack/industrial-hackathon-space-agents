"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { type ApprovalRow, describeArgs, formatJson } from "@/lib/trace";
import { type Decision, NOTE_MAX_LENGTH } from "@/lib/validation";

// The one element on the page that is meant to stand out: the agent is stopped until a person
// answers here.
export function ApprovalCard({
  approval,
  onDecide,
}: {
  approval: ApprovalRow;
  // Null for a viewer: the card shows what is waiting, without the controls.
  onDecide: ((approvalId: string, decision: Decision, note: string) => Promise<void>) | null;
}) {
  const [note, setNote] = useState("");
  const [sending, setSending] = useState<Decision | null>(null);
  const args = describeArgs(approval.args);
  const noteId = `note-${approval.id}`;

  async function decide(decision: Decision) {
    if (!onDecide) return;
    setSending(decision);
    try {
      await onDecide(approval.id, decision, note);
    } finally {
      setSending(null);
    }
  }

  return (
    <section
      aria-label={`Approval needed for ${approval.tool_name}`}
      className="grid gap-3 rounded-md border border-l-4 border-attention-border bg-attention-surface p-3 shadow-sm"
    >
      <div className="grid gap-0.5">
        <p className="text-xs font-semibold tracking-wide text-attention uppercase">Approval needed</p>
        <p>
          The agent wants to call{" "}
          <code className="rounded-sm bg-attention-muted px-1 py-0.5 font-mono text-[0.8rem] font-semibold">
            {approval.tool_name}
          </code>{" "}
          and is waiting for a decision.
        </p>
      </div>

      {args === null ? (
        <pre className="max-h-72 overflow-auto rounded-sm border border-attention-muted bg-card px-2 py-1.5 font-mono text-xs break-words whitespace-pre-wrap">
          {formatJson(approval.args)}
        </pre>
      ) : args.length === 0 ? (
        <p className="text-xs text-attention">No arguments.</p>
      ) : (
        <div className="overflow-hidden rounded-sm border border-attention-muted bg-card">
          <table className="w-full border-collapse text-xs">
            <tbody className="divide-y divide-attention-muted">
              {args.map((arg) => (
                <tr key={arg.name}>
                  <th
                    scope="row"
                    className="w-1/3 bg-attention-surface px-2 py-1.5 text-left align-top font-mono font-medium break-words text-attention sm:w-44"
                  >
                    {arg.name}
                  </th>
                  <td className="px-2 py-1.5 align-top font-mono">
                    <div className="max-h-56 overflow-auto break-words whitespace-pre-wrap">{arg.value}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {onDecide === null ? (
        <p className="text-xs text-attention">
          Only an admin or a member of this organisation can decide. You can follow the run.
        </p>
      ) : (
        <>
          <div className="grid gap-1.5">
            <Label htmlFor={noteId}>Note for the agent (optional)</Label>
            <Textarea
              id={noteId}
              rows={2}
              maxLength={NOTE_MAX_LENGTH}
              placeholder="Why you approve or deny. The agent reads this."
              className="min-h-14 bg-card"
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <Button onClick={() => decide("approved")} disabled={sending !== null}>
              {sending === "approved" ? "Approving…" : "Approve"}
            </Button>
            <Button
              variant="outline"
              className="border-danger-border bg-card text-danger hover:bg-danger-surface hover:text-danger"
              onClick={() => decide("denied")}
              disabled={sending !== null}
            >
              {sending === "denied" ? "Denying…" : "Deny"}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
