"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import { ROLES, ROLE_LABELS, type Role } from "@/lib/access";
import { createClient } from "@/lib/supabase/client";

export type PendingRequest = { id: string; email: string; organization_name: string; created_at: string };

// Requests waiting on this admin (SYS-35). In People: who asks to join this organisation, and the
// role to give them. In Organisations (platform admins): who asks for a new organisation; they
// become its admin. The database checks the decider again (decide_access_request).
export function AccessRequests({ kind, requests }: { kind: "join" | "create"; requests: PendingRequest[] }) {
  if (requests.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {kind === "join" ? "Nobody is waiting to join." : "Nobody is waiting for a new organisation."}
      </p>
    );
  }
  return (
    <ul className="divide-y rounded-md border bg-card">
      {requests.map((r) => (
        <Row key={r.id} kind={kind} request={r} />
      ))}
    </ul>
  );
}

function Row({ kind, request }: { kind: "join" | "create"; request: PendingRequest }) {
  const router = useRouter();
  // Member by default: viewer cannot start the runs the person most likely signed up for, admin is
  // a choice to make on purpose.
  const [role, setRole] = useState<Role>("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(approve: boolean) {
    setBusy(true);
    setError(null);
    const { error: e } = await createClient().rpc("decide_access_request", {
      request: request.id,
      approve,
      member_role: role,
    });
    setBusy(false);
    if (e) {
      setError(e.code === "55000" ? "Someone else decided it already." : e.message);
      return;
    }
    router.refresh();
  }

  return (
    <li className="grid gap-1 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{request.email}</span>
        {kind === "create" ? (
          <span className="text-muted-foreground">asks for &ldquo;{request.organization_name}&rdquo;</span>
        ) : null}
        <span className="text-xs text-muted-foreground">
          <RelativeTime iso={request.created_at} />
        </span>
        <div className="ml-auto flex items-center gap-2">
          {kind === "join" ? (
            <select
              aria-label={`Role for ${request.email}`}
              className="h-8 rounded-md border border-input bg-card px-1.5 text-sm"
              value={role}
              disabled={busy}
              onChange={(event) => setRole(event.target.value as Role)}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          ) : null}
          <Button size="sm" disabled={busy} onClick={() => void decide(true)}>
            Approve
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void decide(false)}>
            Decline
          </Button>
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </li>
  );
}
