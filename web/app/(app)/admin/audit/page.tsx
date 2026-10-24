import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminNotice } from "@/components/admin/admin-notice";
import { RelativeTime } from "@/components/relative-time";
import { shortId, summarizeAuditEvent } from "@/lib/admin";
import { adminPage, peopleById } from "@/lib/admin-page";
import { getSessionUser } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Audit log" };

const AUDIT_LIMIT = 100;

export default function AuditPage() {
  return (
    <Suspense fallback={<p className="text-muted-foreground">Loading the audit log…</p>}>
      <Audit />
    </Suspense>
  );
}

async function Audit() {
  const page = await adminPage();
  if (!page.ok) return <AdminNotice reason={page.reason} />;
  const { supabase, org } = page;

  const [events, people, me] = await Promise.all([
    supabase
      .from("audit_events")
      .select("id, created_at, actor, action, detail")
      .eq("organization_id", org.id)
      .order("id", { ascending: false })
      .limit(AUDIT_LIMIT),
    peopleById(supabase, org.id),
    getSessionUser(supabase),
  ]);
  if (events.error) {
    console.error("Admin, audit: read failed", events.error);
    return (
      <p role="alert" className="text-danger">
        The audit log could not be loaded. Check that the database is reachable and reload.
      </p>
    );
  }

  // Members have an email here; a platform admin who is not a member does not, except yourself.
  const nameOf = (id: string) => people.get(id) ?? (id === me?.id && me.email ? me.email : shortId(id));

  return (
    <div className="grid gap-2">
      {events.data.length === 0 ? (
        <p className="rounded-xl border border-dashed px-3 py-6 text-center text-muted-foreground">
          Nothing has been changed yet.
        </p>
      ) : (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card">
          {events.data.map((event) => (
            <li
              key={event.id}
              className="grid gap-x-3 gap-y-0.5 px-3 py-1.5 sm:grid-cols-[6.5rem_12rem_1fr] sm:items-baseline"
            >
              <RelativeTime iso={event.created_at} className="text-xs whitespace-nowrap text-muted-foreground" />
              <span className="truncate text-xs">{/* Null: done with the secret key (a script), or the person was deleted since. */}
                {event.actor ? nameOf(event.actor) : "system or deleted user"}</span>
              <span className="min-w-0 break-words">{summarizeAuditEvent(event, nameOf)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        The last {AUDIT_LIMIT} changes to settings, keys and people, newest first. Written by the
        database in the same transaction as each change; nobody can edit or delete a line from the app.
      </p>
    </div>
  );
}
