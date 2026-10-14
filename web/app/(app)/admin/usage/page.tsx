import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { AdminNotice } from "@/components/admin/admin-notice";
import { capShare, formatMonth, formatUsd } from "@/lib/admin";
import { adminPage } from "@/lib/admin-page";

export const metadata: Metadata = { title: "Usage" };

const MONTHS = 6;

export default function UsagePage() {
  return (
    <Suspense fallback={<p className="text-muted-foreground">Loading usage…</p>}>
      <Usage />
    </Suspense>
  );
}

async function Usage() {
  const page = await adminPage();
  if (!page.ok) return <AdminNotice reason={page.reason} />;
  const { supabase, org } = page;

  const [usage, settings] = await Promise.all([
    supabase.rpc("organization_usage", { org: org.id, months: MONTHS }),
    supabase.from("organization_settings").select("monthly_cost_cap_usd").eq("organization_id", org.id).maybeSingle(),
  ]);
  if (usage.error || settings.error) {
    console.error("Admin, usage: read failed", usage.error ?? settings.error);
    return (
      <p role="alert" className="text-danger">
        The usage could not be loaded. Check that the database is reachable and reload.
      </p>
    );
  }

  // numeric comes back from PostgREST as a number; Number() also covers a string, should a
  // client library change that.
  const rows = usage.data.map((row) => ({
    month: row.month,
    runs: Number(row.runs),
    tokens: Number(row.tokens),
    cost: Number(row.cost_usd),
  }));
  const capValue = settings.data?.monthly_cost_cap_usd;
  const cap = capValue === null || capValue === undefined ? null : Number(capValue);
  // The function groups by the database's month (UTC); the first row is the current month only
  // if it had runs.
  const thisMonth = new Date().toISOString().slice(0, 7);
  const current = rows.find((row) => row.month.slice(0, 7) === thisMonth);

  return (
    <div className="grid max-w-2xl gap-3">
      <p className="rounded-md border bg-card px-3 py-2">
        This month: <strong>{formatUsd(current?.cost ?? 0)}</strong>
        {cap === null ? (
          <>
            , and this organisation sets no cap of its own (the deployment default applies).{" "}
            <Link href="/admin" className="text-primary underline-offset-4 hover:underline">
              Set one
            </Link>
            .
          </>
        ) : (
          <>
            {" "}
            of a {formatUsd(cap)} cap ({capShare(current?.cost ?? 0, cap)}).
          </>
        )}
      </p>
      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-6 text-center text-muted-foreground">
          No runs in the last {MONTHS} months.
        </p>
      ) : (
        <table className="w-full border-collapse rounded-md border bg-card text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="px-3 py-1.5 font-medium">Month</th>
              <th className="px-3 py-1.5 text-right font-medium">Runs</th>
              <th className="px-3 py-1.5 text-right font-medium">Tokens</th>
              <th className="px-3 py-1.5 text-right font-medium">Cost</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((row) => (
              <tr key={row.month}>
                <td className="px-3 py-1.5">{formatMonth(row.month)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{row.runs.toLocaleString("en-US")}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{row.tokens.toLocaleString("en-US")}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{formatUsd(row.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="text-xs text-muted-foreground">
        From the cost the agent records when a run ends, by calendar month in UTC. Runs still working
        are not counted yet, and the scripted model costs nothing. This is not a bill: the provider&apos;s
        own invoice is the one that counts.
      </p>
    </div>
  );
}
