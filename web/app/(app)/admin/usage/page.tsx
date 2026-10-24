import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { AdminNotice } from "@/components/admin/admin-notice";
import { UsageChart } from "@/components/admin/usage-chart";
import { capShare, formatUsd } from "@/lib/admin";
import { adminPage } from "@/lib/admin-page";
import {
  RANGES,
  type Range,
  byProvider,
  chartBars,
  formatCost,
  formatTokens,
  keyLabel,
  metricOf,
  modelLabel,
  monthStart,
  parseBreakdown,
  periodStarts,
  processLabel,
  rangeOf,
  sinceOf,
  totals,
  usageProviderLabel,
} from "@/lib/usage";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Usage" };

export default function UsagePage(props: PageProps<"/admin/usage">) {
  return (
    <Suspense fallback={<p className="text-muted-foreground">Loading usage…</p>}>
      <Usage searchParams={props.searchParams} />
    </Suspense>
  );
}

const TH = "px-3 py-1.5 font-medium";
const TD = "px-3 py-1.5";
const NUM = "px-3 py-1.5 text-right tabular-nums whitespace-nowrap";

async function Usage({ searchParams }: { searchParams: PageProps<"/admin/usage">["searchParams"] }) {
  const page = await adminPage();
  if (!page.ok) return <AdminNotice reason={page.reason} />;
  const { supabase, org } = page;

  const params = await searchParams;
  const range = rangeOf(params.range);
  const metric = metricOf(params.show);
  const now = new Date();
  const periods = periodStarts(range, now);

  const [breakdown, month, series, settings] = await Promise.all([
    supabase.rpc("organization_usage_breakdown", { org: org.id, since: sinceOf(range, now) }),
    supabase.rpc("organization_usage_breakdown", { org: org.id, since: monthStart(now) }),
    supabase.rpc("organization_usage_series", { org: org.id, since: sinceOf(range, now), bucket: range.bucket }),
    supabase.from("organization_settings").select("monthly_cost_cap_usd").eq("organization_id", org.id).maybeSingle(),
  ]);
  const failed = breakdown.error ?? month.error ?? series.error ?? settings.error;
  if (failed) {
    console.error("Admin, usage: read failed", failed);
    return (
      <p role="alert" className="text-danger">
        The usage could not be loaded. Check that the database is reachable and reload.
      </p>
    );
  }

  const lines = parseBreakdown(breakdown.data ?? []);
  const all = totals(lines);
  const spent = totals(parseBreakdown(month.data ?? [])).costUsd;
  const capValue = settings.data?.monthly_cost_cap_usd;
  const cap = capValue === null || capValue === undefined ? null : Number(capValue);
  const providers = byProvider(lines);
  const bars = chartBars(series.data ?? [], periods, metric);
  const href = (r: Range, show: string) => `/admin/usage?range=${r.id}&show=${show}`;

  return (
    <div className="grid max-w-3xl gap-4">
      <p className="rounded-md border bg-card px-3 py-2">
        This month: <strong>{formatUsd(spent)}</strong>
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
            of a {formatUsd(cap)} cap ({capShare(spent, cap)}).
          </>
        )}{" "}
        <span className="text-muted-foreground">The cap counts this same total.</span>
      </p>

      <nav className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm" aria-label="Period and measure">
        <span className="flex gap-1">
          {RANGES.map((r) => (
            <Link
              key={r.id}
              href={href(r, metric)}
              aria-current={r.id === range.id ? "page" : undefined}
              className={cn(
                "rounded-md border px-2 py-0.5",
                r.id === range.id ? "border-primary text-primary" : "text-muted-foreground hover:text-foreground",
              )}
            >
              Last {r.label}
            </Link>
          ))}
        </span>
        <span className="flex gap-1">
          {(["cost", "tokens"] as const).map((m) => (
            <Link
              key={m}
              href={href(range, m)}
              aria-current={m === metric ? "page" : undefined}
              className={cn(
                "rounded-md border px-2 py-0.5",
                m === metric ? "border-primary text-primary" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {m === "cost" ? "Cost" : "Tokens"}
            </Link>
          ))}
        </span>
      </nav>

      {lines.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-6 text-center text-muted-foreground">
          No model or embedding calls in the last {range.label}.
        </p>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Estimated cost" value={formatCost(all.costUsd)} lowerBound={all.unpricedRequests > 0} />
            <Stat label="Input tokens" value={formatTokens(all.inputTokens)} note={all.cacheReadTokens > 0 ? `${formatTokens(all.cacheReadTokens)} from cache` : undefined} />
            <Stat label="Output tokens" value={formatTokens(all.outputTokens)} />
            <Stat label="Requests" value={all.requests.toLocaleString("en-US")} />
          </dl>

          <section className="grid gap-2 rounded-md border bg-card p-3">
            <h2 className="text-sm font-medium">
              {metric === "cost" ? "Estimated cost" : "Tokens (input and output)"} per {range.bucket}
            </h2>
            <UsageChart bars={bars} metric={metric} bucket={range.bucket} />
          </section>

          <section className="grid gap-2">
            <h2 className="text-sm font-medium">By provider</h2>
            <table className="w-full border-collapse rounded-md border bg-card text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className={TH}>Provider</th>
                  <th className={cn(TH, "text-right")}>Tokens in / out</th>
                  <th className={cn(TH, "text-right")}>Cost</th>
                  <th className={cn(TH, "text-right")}>Share</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {providers.map((p) => (
                  <tr key={p.provider}>
                    <td className={TD}>{usageProviderLabel(p.provider)}</td>
                    <td className={NUM}>
                      {formatTokens(p.inputTokens)} / {formatTokens(p.outputTokens)}
                    </td>
                    <td className={NUM}>{costCell(p.costUsd, p.unpricedRequests, p.requests)}</td>
                    <td className={NUM}>{Math.round(p.share * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="grid gap-2">
            <h2 className="text-sm font-medium">By model and key</h2>
            <table className="w-full border-collapse rounded-md border bg-card text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className={TH}>Model, used for</th>
                  <th className={cn(TH, "hidden sm:table-cell")}>Key</th>
                  <th className={cn(TH, "text-right")}>Tokens in / out</th>
                  <th className={cn(TH, "text-right")}>Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {lines.map((l) => (
                  <tr key={`${l.process}|${l.model}|${l.keySource}|${l.keyHint ?? ""}`}>
                    <td className={TD}>
                      <span className="font-mono text-xs">{modelLabel(l.model)}</span>
                      <span className="block text-xs text-muted-foreground">
                        {usageProviderLabel(l.provider)} · {processLabel(l.process)}
                        {l.runs > 0 ? ` · ${l.runs} run${l.runs === 1 ? "" : "s"}` : ""}
                      </span>
                      {/* On a phone the key goes under the model instead of a column of its own. */}
                      <span className="block text-xs break-all text-muted-foreground sm:hidden">
                        {keyLabel(l.keySource, l.keyHint)}
                      </span>
                    </td>
                    <td className={cn(TD, "hidden text-xs break-all sm:table-cell")}>{keyLabel(l.keySource, l.keyHint)}</td>
                    <td className={NUM}>
                      {formatTokens(l.inputTokens)} / {formatTokens(l.outputTokens)}
                    </td>
                    <td className={NUM}>{costCell(l.costUsd, l.unpricedRequests, l.requests)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}

      <div className="grid max-w-prose gap-1.5 text-xs text-muted-foreground">
        <p>
          Every model and embedding call the agent makes for this organisation: requirement runs and their
          check agent, case transcription, regulation summaries and vectors, search queries and the run chat.
          Failed runs count too. Days and months are in UTC, the same as the monthly cap.
        </p>
        <p>
          Costs are estimates from public price lists at the time of the call; &quot;no price&quot; means the
          model is not on them, so a total with such calls is a lower bound. Ollama runs on your own server and
          counts as $0. Runs from before per-key usage was recorded show as one line under their model, with the
          key not recorded. This is not a bill: the provider&apos;s own invoice is the one that counts.
        </p>
      </div>
    </div>
  );
}

function Stat({ label, value, lowerBound, note }: { label: string; value: string; lowerBound?: boolean; note?: string }) {
  return (
    <div className="rounded-md border bg-card px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-medium tabular-nums">
        {lowerBound ? <span className="text-xs font-normal text-muted-foreground">at least </span> : null}
        {value}
      </dd>
      {note ? <dd className="text-xs text-muted-foreground">{note}</dd> : null}
    </div>
  );
}

function costCell(cost: number | null, unpriced: number, requests: number) {
  // A provider's total is 0, not null, when none of its models had a price.
  if (cost === null || (cost === 0 && unpriced > 0 && unpriced >= requests)) {
    return <span className="text-muted-foreground">no price</span>;
  }
  if (unpriced > 0) {
    return (
      <span title={`${unpriced} of ${requests} requests had no published price`}>
        ≥ {formatCost(cost)}
      </span>
    );
  }
  return formatCost(cost);
}
