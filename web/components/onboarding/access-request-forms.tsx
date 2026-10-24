"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createClient } from "@/lib/supabase/client";

export type MyRequest = {
  id: string;
  kind: "join" | "create";
  organization_name: string;
  status: string;
  created_at: string;
};

// Getting into an organisation (SYS-35). Either ask one to let you in, and its admins decide, or
// ask for a new one, and a platform admin decides (Clemente, 2026-10-24: otherwise a stranger runs
// on the deployment's model keys). The page follows the requests live, so an approval shows up
// without a reload.
export function AccessRequestForms({
  userId,
  organizations,
  requests,
}: {
  userId: string;
  organizations: { id: string; name: string }[];
  requests: MyRequest[];
}) {
  const router = useRouter();
  const [orgId, setOrgId] = useState(organizations[0]?.id ?? "");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`access_requests:${userId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "access_requests", filter: `user_id=eq.${userId}` },
        () => router.refresh(),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [userId, router]);

  async function call(work: () => PromiseLike<{ error: { message: string; code?: string } | null }>) {
    setBusy(true);
    setError(null);
    const { error: e } = await work();
    setBusy(false);
    if (e) {
      setError(e.code === "23505" ? "You already have a membership there; an admin can reactivate it." : e.message);
      return;
    }
    router.refresh();
  }

  const pending = requests.filter((r) => r.status === "pending");
  const closed = requests.filter((r) => r.status === "declined");
  const supabase = createClient();

  return (
    <div className="grid gap-5">
      {pending.length > 0 ? (
        <section className="grid gap-2" aria-labelledby="pending-heading">
          <h2 id="pending-heading" className="text-sm font-semibold">
            Waiting for approval
          </h2>
          <ul className="divide-y rounded-md border bg-card">
            {pending.map((r) => (
              <li key={r.id} className="flex flex-wrap items-baseline gap-2 px-3 py-2">
                <span>
                  {r.kind === "join" ? (
                    <>
                      To join <span className="font-medium">{r.organization_name}</span>: an admin of it decides.
                    </>
                  ) : (
                    <>
                      New organisation <span className="font-medium">{r.organization_name}</span>: a platform admin
                      decides.
                    </>
                  )}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  disabled={busy}
                  onClick={() => void call(() => supabase.rpc("cancel_access_request", { request: r.id }))}
                >
                  Withdraw
                </Button>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">This page updates by itself when someone decides.</p>
        </section>
      ) : null}
      {closed.length > 0 ? (
        <ul className="grid gap-1 text-sm text-muted-foreground">
          {closed.map((r) => (
            <li key={r.id}>
              {r.kind === "join" ? `Joining ${r.organization_name}` : `The new organisation ${r.organization_name}`} was
              declined. You can ask again.
            </li>
          ))}
        </ul>
      ) : null}

      <section className="grid gap-2" aria-labelledby="join-heading">
        <h2 id="join-heading" className="text-sm font-semibold">
          Join your organisation
        </h2>
        {organizations.length === 0 ? (
          <p className="text-muted-foreground">There is no other organisation to join.</p>
        ) : (
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void call(() => supabase.rpc("request_to_join", { org: orgId }));
            }}
          >
            <select
              aria-label="Organisation"
              className="h-9 min-w-48 rounded-md border border-input bg-card px-2 text-sm"
              value={orgId}
              disabled={busy}
              onChange={(event) => setOrgId(event.target.value)}
            >
              {organizations.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
            <Button type="submit" disabled={busy || orgId === ""}>
              Ask to join
            </Button>
          </form>
        )}
        <p className="text-xs text-muted-foreground">
          Its admins see your email and choose your role. You see nothing of it until then.
        </p>
      </section>

      <section className="grid gap-2" aria-labelledby="create-heading">
        <h2 id="create-heading" className="text-sm font-semibold">
          Or start a new organisation
        </h2>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void call(() => supabase.rpc("request_organization", { org_name: name }));
          }}
        >
          <Input
            aria-label="Organisation name"
            placeholder="e.g. Lamps Inc"
            maxLength={200}
            className="max-w-xs"
            value={name}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
          <Button type="submit" variant="outline" disabled={busy || name.trim() === ""}>
            Ask for it
          </Button>
        </form>
        <p className="text-xs text-muted-foreground">
          A platform admin approves each new organisation, because its runs use the deployment&apos;s model keys
          until it adds its own. Once approved you are its admin.
        </p>
      </section>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
