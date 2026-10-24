import {
  type Bar,
  type Bucket,
  type Metric,
  formatCost,
  formatPeriod,
  formatTokens,
  niceMax,
  providerSlot,
  usageProviderLabel,
} from "@/lib/usage";

// Stacked bars per period and provider, drawn on the server: no chart library, no client code.
// Each bar's full-height column carries a native tooltip with its breakdown, so the hit target is
// the whole column, not the thin segment. The provider table under the chart is the same data as
// text (three light-mode colours are under 3:1 on the card, so colour is never the only key).

const WIDTH = 640;
const HEIGHT = 180;
const LEFT = 52;
const BOTTOM = 20;
const TOP = 8;
// The 2px gap between bars and between stacked segments, in the card's colour.
const GAP = 2;

function colour(provider: string): string {
  const slot = providerSlot(provider);
  return slot === null ? "var(--series-other)" : `var(--series-${slot})`;
}

function format(value: number, metric: Metric): string {
  return metric === "cost" ? formatCost(value) : formatTokens(value);
}

export function UsageChart({ bars, metric, bucket }: { bars: Bar[]; metric: Metric; bucket: Bucket }) {
  const top = niceMax(Math.max(0, ...bars.map((b) => b.total)));
  const plotHeight = HEIGHT - TOP - BOTTOM;
  const plotWidth = WIDTH - LEFT;
  const slot = plotWidth / Math.max(1, bars.length);
  const barWidth = Math.max(1, slot - GAP);
  const y = (v: number) => TOP + plotHeight - (v / top) * plotHeight;
  const providers = [...new Set(bars.flatMap((b) => b.segments.map((s) => s.provider)))].sort(
    (a, b) => (providerSlot(a) ?? 99) - (providerSlot(b) ?? 99),
  );
  // First, middle and last period: enough to place a bar in time without labels colliding.
  const labelled = new Set([0, Math.floor((bars.length - 1) / 2), bars.length - 1]);

  return (
    <figure className="grid gap-2">
      {providers.length > 0 && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Providers">
          {providers.map((p) => (
            <li key={p} className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block size-2.5 rounded-sm" style={{ background: colour(p) }} />
              {usageProviderLabel(p)}
            </li>
          ))}
        </ul>
      )}
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-auto w-full"
        role="img"
        aria-label={`${metric === "cost" ? "Estimated cost" : "Tokens"} per ${bucket}, by provider`}
      >
        {[0, top / 2, top].map((v) => (
          <g key={v}>
            <line x1={LEFT} x2={WIDTH} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeWidth={1} />
            <text x={LEFT - 6} y={y(v) + 3} textAnchor="end" fontSize={10} fill="var(--muted-foreground)">
              {format(v, metric)}
            </text>
          </g>
        ))}
        {bars.map((bar, i) => {
          const x = LEFT + i * slot + GAP / 2;
          let base = 0;
          const tip = [
            `${formatPeriod(bar.period, bucket)}: ${format(bar.total, metric)}`,
            ...bar.segments.map((s) => `${usageProviderLabel(s.provider)}: ${format(s.value, metric)}`),
          ].join("\n");
          return (
            <g key={bar.period}>
              <title>{tip}</title>
              <rect x={x} y={TOP} width={barWidth} height={plotHeight} fill="transparent" />
              {bar.segments.map((s) => {
                const y0 = y(base);
                base += s.value;
                const y1 = y(base);
                // The gap comes off the top of each segment, so stacked fills never touch; a
                // segment too small to survive it still shows as one pixel.
                const h = Math.max(1, y0 - y1 - GAP);
                return <rect key={s.provider} x={x} y={y0 - h} width={barWidth} height={h} fill={colour(s.provider)} />;
              })}
              {labelled.has(i) && (
                <text
                  x={x + barWidth / 2}
                  y={HEIGHT - 6}
                  textAnchor={i === 0 ? "start" : i === bars.length - 1 ? "end" : "middle"}
                  fontSize={10}
                  fill="var(--muted-foreground)"
                >
                  {formatPeriod(bar.period, bucket)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </figure>
  );
}
