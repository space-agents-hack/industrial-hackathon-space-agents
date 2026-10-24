import { type FlaggedRequirement } from "@/lib/check-findings";

// The check's findings on this run, under the trace (SYS-29). Collapsed: the counts say whether
// the check ran and what it did; the list is for whoever reviews before approving.
export function CheckFindings({
  rows,
  total,
}: {
  rows: FlaggedRequirement[];
  total: number;
}) {
  if (total === 0) return null;
  const rejected = rows.filter((r) => r.status === "rejected").length;
  return (
    <section className="grid gap-2 rounded-xl border bg-card p-4">
      <h2 className="text-lg font-semibold tracking-tight">Check</h2>
      <p className="text-sm text-muted-foreground">
        {rows.length === 0
          ? `No findings on the ${total} requirements stored for this draft. If the run has finished, the check found nothing, or did not run: the trace shows its call.`
          : `${rows.length} of ${total} requirements flagged: ${rejected} rejected and left out of the file, ${rows.length - rejected} kept for a person to look at.`}
      </p>
      {rows.length > 0 ? (
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground select-none hover:text-foreground">
            Show the findings
          </summary>
          <ul className="mt-2 grid max-h-[32rem] gap-2 overflow-y-auto text-xs">
            {rows.map((r) => (
              <li key={r.extId} className="grid gap-0.5">
                <p>
                  <span className="font-mono">{r.extId}</span>{" "}
                  <span
                    className={
                      r.status === "rejected"
                        ? "text-danger"
                        : "text-muted-foreground"
                    }
                  >
                    {r.status}
                  </span>{" "}
                  <span className="text-muted-foreground">
                    {r.regulation} {r.paragraph}
                  </span>
                </p>
                <p className="text-muted-foreground">{r.text}</p>
                {r.findings.map((f, i) => (
                  <p key={i}>
                    <span className="text-muted-foreground">
                      {f.by === "code" ? "Code" : "Check agent"}, {f.action}:
                    </span>{" "}
                    {f.problem}
                  </p>
                ))}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
