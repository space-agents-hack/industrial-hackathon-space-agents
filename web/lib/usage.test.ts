import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RANGES,
  byProvider,
  chartBars,
  formatCost,
  formatTokens,
  keyLabel,
  metricOf,
  modelLabel,
  niceMax,
  parseBreakdown,
  periodStarts,
  providerSlot,
  rangeOf,
  sinceOf,
  totals,
} from "./usage.ts";

// A Saturday, late in the day, so a local-time slip would show up as the wrong date.
const NOW = new Date("2026-10-24T23:30:00Z");

test("a range is whole UTC buckets ending with the current one", () => {
  const days = periodStarts(rangeOf("30d"), NOW);
  assert.equal(days.length, 30);
  assert.equal(days.at(-1), "2026-10-24");
  assert.equal(days[0], "2026-09-25");
  assert.equal(sinceOf(rangeOf("30d"), NOW), "2026-09-25T00:00:00Z");

  // Postgres' date_trunc('week') starts on Monday; 2026-10-19 is one.
  const weeks = periodStarts(rangeOf("90d"), NOW);
  assert.equal(weeks.at(-1), "2026-10-19");
  assert.equal(weeks.length, 13);

  const months = periodStarts(rangeOf("12m"), NOW);
  assert.deepEqual([months[0], months.at(-1)], ["2025-11-01", "2026-10-01"]);
});

test("an unknown range or metric falls back to the default", () => {
  assert.equal(rangeOf("forever"), RANGES[0]);
  assert.equal(metricOf("joules"), "cost");
  assert.equal(metricOf("tokens"), "tokens");
});

const ROWS = parseBreakdown([
  { process: "writer", provider: "anthropic", model: "anthropic:claude-opus-5-5", key_source: "organization", key_hint: "wxyz", runs: 2, requests: 40, input_tokens: 900000, output_tokens: 30000, cache_read_tokens: 500000, cost_usd: 4.5, unpriced_requests: 0 },
  { process: "embedding", provider: "openai", model: "openai:text-embedding-3-small", key_source: "deployment", key_hint: "OPENAI_API_KEY", runs: 0, requests: 8, input_tokens: 2000000, output_tokens: 0, cache_read_tokens: 0, cost_usd: "0.04", unpriced_requests: 0 },
  { process: "summary", provider: "deepseek", model: "deepseek:new-model", key_source: "deployment", key_hint: null, runs: 0, requests: 3, input_tokens: 9000, output_tokens: 900, cache_read_tokens: 0, cost_usd: null, unpriced_requests: 3 },
]);

test("an unpriced model adds tokens but no cost, and is counted as unpriced", () => {
  const t = totals(ROWS);
  assert.equal(t.costUsd, 4.54);
  assert.equal(t.inputTokens, 2_909_000);
  assert.equal(t.unpricedRequests, 3);
  assert.equal(ROWS[2].costUsd, null);
});

test("providers are ordered by cost and their shares add up to one", () => {
  const providers = byProvider(ROWS);
  assert.deepEqual(providers.map((p) => p.provider), ["anthropic", "openai", "deepseek"]);
  assert.ok(Math.abs(providers.reduce((s, p) => s + p.share, 0) - 1) < 1e-9);
});

test("bars fill every period, stack providers in their fixed order and sum their values", () => {
  const bars = chartBars(
    [
      { period: "2026-10-24", provider: "openai", input_tokens: 10, output_tokens: 0, cost_usd: 0.5 },
      { period: "2026-10-24", provider: "anthropic", input_tokens: 100, output_tokens: 20, cost_usd: 2 },
      { period: "2026-10-24", provider: "unknown", input_tokens: 5, output_tokens: 0, cost_usd: null },
    ],
    ["2026-10-23", "2026-10-24"],
    "tokens",
  );
  assert.deepEqual(bars[0], { period: "2026-10-23", segments: [], total: 0 });
  assert.deepEqual(bars[1].segments.map((s) => s.provider), ["anthropic", "openai", "unknown"]);
  assert.equal(bars[1].total, 135);
  // By cost, a provider with no price has nothing to stack.
  const cost = chartBars([{ period: "2026-10-24", provider: "unknown", cost_usd: null }], ["2026-10-24"], "cost");
  assert.equal(cost[0].total, 0);
});

test("a provider keeps its colour slot whatever else is shown", () => {
  assert.equal(providerSlot("anthropic"), 1);
  assert.equal(providerSlot("ollama"), 5);
  assert.equal(providerSlot("unknown"), null);
});

test("the axis top is a round number at or above the tallest bar", () => {
  assert.equal(niceMax(0), 1);
  assert.equal(niceMax(3.2), 5);
  assert.equal(niceMax(0.012), 0.02);
  assert.equal(niceMax(1_200_000), 2_000_000);
});

test("labels name the key the way Admin, Providers does, never more", () => {
  assert.equal(keyLabel("organization", "wxyz"), "Organisation key …wxyz");
  assert.equal(keyLabel("deployment", "OPENAI_API_KEY"), "Deployment key (OPENAI_API_KEY)");
  assert.equal(keyLabel("server", "http://gpu:11434"), "Server http://gpu:11434");
  assert.match(keyLabel("unknown", null), /Not recorded/);
  assert.equal(modelLabel("ollama:qwen3:32b"), "qwen3:32b");
});

test("small amounts are not shown as free, and tokens are compact", () => {
  assert.equal(formatCost(0.0000002), "< $0.01");
  assert.equal(formatCost(0), "$0.00");
  assert.equal(formatCost(null), "no price");
  assert.equal(formatCost(1234.5), "$1,234.50");
  assert.equal(formatTokens(950), "950");
  assert.equal(formatTokens(12_345), "12k");
  assert.equal(formatTokens(2_909_000), "2.91M");
});
