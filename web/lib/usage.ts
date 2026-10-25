// Pure helpers for Admin, Usage (SYS-40, IF-7): the time ranges, the chart's periods, and the sums
// and labels of the rows organization_usage_breakdown and organization_usage_series return. No
// React, Supabase or Next.js imports, so `node --test` runs them directly.

import { providerLabel } from "./admin.ts";

export type Bucket = "day" | "week" | "month";

// Each range is a whole number of the database's buckets (UTC, as the monthly cap), so the first
// bar is never a partial period cut by `since`. Weeks for 90 days: 90 daily bars are too thin to
// read at the page's width.
export const RANGES = [
  { id: "30d", label: "30 days", bucket: "day", count: 30 },
  { id: "90d", label: "13 weeks", bucket: "week", count: 13 },
  { id: "12m", label: "12 months", bucket: "month", count: 12 },
] as const satisfies readonly { id: string; label: string; bucket: Bucket; count: number }[];
export type RangeId = (typeof RANGES)[number]["id"];
export type Range = (typeof RANGES)[number];

export function rangeOf(value: unknown): Range {
  return RANGES.find((r) => r.id === value) ?? RANGES[0];
}

export type Metric = "cost" | "tokens";
export function metricOf(value: unknown): Metric {
  return value === "tokens" ? "tokens" : "cost";
}

function utcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

// The start of the bucket `now` falls in, as Postgres' date_trunc sees it: weeks start on Monday.
function bucketStart(now: Date, bucket: Bucket): Date {
  const day = utcDay(now);
  if (bucket === "day") return day;
  if (bucket === "month") return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1));
  const sinceMonday = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - sinceMonday * 86_400_000);
}

function step(date: Date, bucket: Bucket, n: number): Date {
  if (bucket === "month") return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + n, 1));
  return new Date(date.getTime() + n * (bucket === "week" ? 7 : 1) * 86_400_000);
}

// The start of every bar, oldest first, as "YYYY-MM-DD" (the `period` the series returns).
export function periodStarts(range: Range, now: Date): string[] {
  const last = bucketStart(now, range.bucket);
  return Array.from({ length: range.count }, (_, i) =>
    step(last, range.bucket, i - range.count + 1).toISOString().slice(0, 10),
  );
}

export function sinceOf(range: Range, now: Date): string {
  return `${periodStarts(range, now)[0]}T00:00:00Z`;
}

export function monthStart(now: Date): string {
  return bucketStart(now, "month").toISOString();
}

// ---------------------------------------------------------------------------------------------
// The rows
// ---------------------------------------------------------------------------------------------

// numeric comes back from PostgREST as a number; Number() also covers a string, should a client
// library change that. Null stays null: an unpriced model is not a free one.
function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
function cost(value: unknown): number | null {
  return value === null || value === undefined ? null : num(value);
}

export type UsageLine = {
  process: string;
  provider: string;
  model: string;
  keySource: string;
  keyHint: string | null;
  runs: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number | null;
  unpricedRequests: number;
};

export function parseBreakdown(rows: readonly Record<string, unknown>[]): UsageLine[] {
  return rows.map((r) => ({
    process: String(r.process ?? "?"),
    provider: String(r.provider ?? "unknown"),
    model: String(r.model ?? "unknown"),
    keySource: String(r.key_source ?? "unknown"),
    keyHint: typeof r.key_hint === "string" && r.key_hint !== "" ? r.key_hint : null,
    runs: num(r.runs),
    requests: num(r.requests),
    inputTokens: num(r.input_tokens),
    outputTokens: num(r.output_tokens),
    cacheReadTokens: num(r.cache_read_tokens),
    costUsd: cost(r.cost_usd),
    unpricedRequests: num(r.unpriced_requests),
  }));
}

export type Totals = {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  requests: number;
  // Requests whose model has no published price: with any, the cost is a lower bound.
  unpricedRequests: number;
};

export function totals(lines: readonly UsageLine[]): Totals {
  return lines.reduce<Totals>(
    (t, l) => ({
      costUsd: t.costUsd + (l.costUsd ?? 0),
      inputTokens: t.inputTokens + l.inputTokens,
      outputTokens: t.outputTokens + l.outputTokens,
      cacheReadTokens: t.cacheReadTokens + l.cacheReadTokens,
      requests: t.requests + l.requests,
      unpricedRequests: t.unpricedRequests + l.unpricedRequests,
    }),
    { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, requests: 0, unpricedRequests: 0 },
  );
}

export type ProviderTotal = Totals & { provider: string; share: number };

// One line per provider, most expensive first; `share` is of the total cost, or of the tokens when
// nothing had a price.
export function byProvider(lines: readonly UsageLine[]): ProviderTotal[] {
  const groups = new Map<string, UsageLine[]>();
  for (const l of lines) groups.set(l.provider, [...(groups.get(l.provider) ?? []), l]);
  const all = totals(lines);
  const byCost = all.costUsd > 0;
  return [...groups.entries()]
    .map(([provider, ls]) => {
      const t = totals(ls);
      const part = byCost ? t.costUsd / all.costUsd : (t.inputTokens + t.outputTokens) / Math.max(1, all.inputTokens + all.outputTokens);
      return { provider, ...t, share: part };
    })
    .sort((a, b) => b.costUsd - a.costUsd || b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
}

// ---------------------------------------------------------------------------------------------
// The chart
// ---------------------------------------------------------------------------------------------

// Stacking order and colour slot per provider: fixed, so a provider keeps its colour whichever
// others are on screen (the palette is validated for neighbours in this order). Anything else is
// grey, at the top of the stack.
export const CHART_PROVIDERS = ["anthropic", "openai", "openrouter", "deepseek", "ollama"] as const;

export function providerSlot(provider: string): number | null {
  const i = CHART_PROVIDERS.indexOf(provider as (typeof CHART_PROVIDERS)[number]);
  return i < 0 ? null : i + 1;
}

export type Bar = { period: string; segments: { provider: string; value: number }[]; total: number };

export function chartBars(
  rows: readonly Record<string, unknown>[],
  periods: readonly string[],
  metric: Metric,
): Bar[] {
  const values = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const period = String(r.period ?? "").slice(0, 10);
    const provider = String(r.provider ?? "unknown");
    const value = metric === "cost" ? (cost(r.cost_usd) ?? 0) : num(r.input_tokens) + num(r.output_tokens);
    const at = values.get(period) ?? new Map<string, number>();
    at.set(provider, (at.get(provider) ?? 0) + value);
    values.set(period, at);
  }
  const order = (p: string) => providerSlot(p) ?? CHART_PROVIDERS.length + 1;
  return periods.map((period) => {
    const at = values.get(period) ?? new Map<string, number>();
    const segments = [...at.entries()]
      .filter(([, v]) => v > 0)
      .map(([provider, value]) => ({ provider, value }))
      .sort((a, b) => order(a.provider) - order(b.provider) || a.provider.localeCompare(b.provider));
    return { period, segments, total: segments.reduce((s, x) => s + x.value, 0) };
  });
}

// A round axis top: 1, 2 or 5 times a power of ten, at or above the tallest bar.
export function niceMax(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  return ([1, 2, 5, 10].map((m) => m * power).find((m) => m >= value) ?? 10 * power);
}

// ---------------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------------

const PROCESS_LABELS: Record<string, string> = {
  writer: "Requirement runs",
  check: "Check agent",
  transcription: "Part transcription",
  summary: "Regulation summaries",
  figures: "Regulation figures",
  embedding: "Regulation vectors",
  search: "Search queries",
  chat: "Run chat",
};

export function processLabel(process: string): string {
  return PROCESS_LABELS[process] ?? process;
}

export function usageProviderLabel(provider: string): string {
  return provider === "unknown" ? "Unknown" : providerLabel(provider);
}

// Matches what Admin, Providers shows for the same key, and never more than it shows.
export function keyLabel(source: string, hint: string | null): string {
  switch (source) {
    case "organization":
      return hint ? `Organisation key …${hint}` : "Organisation key";
    case "deployment":
      return hint ? `Deployment key (${hint})` : "Deployment key";
    case "server":
      return hint ? `Server ${hint}` : "Own server";
    default:
      return "Not recorded (before per-key usage)";
  }
}

// "anthropic:claude-opus-5-5" → "claude-opus-5-5"; Ollama's "ollama:qwen3:32b" keeps its tag.
export function modelLabel(model: string): string {
  const colon = model.indexOf(":");
  return colon > 0 ? model.slice(colon + 1) : model;
}

export function formatTokens(n: number): string {
  if (n < 1000) return n.toLocaleString("en-US");
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

// Cents for anything a person budgets; below a cent the amount is real (a search query is a
// millionth of a dollar) but "$0.00" would read as free.
export function formatCost(usd: number | null): string {
  if (usd === null) return "no price";
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return "< $0.01";
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// "2026-10-24" → "24 Oct" for days and weeks, "Oct 2026" for months.
export function formatPeriod(period: string, bucket: Bucket): string {
  const date = new Date(`${period.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return period;
  if (bucket === "month") return date.toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}
