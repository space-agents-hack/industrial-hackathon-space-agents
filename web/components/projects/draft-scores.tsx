import Link from "next/link";

import { CheckAgain } from "@/components/projects/check-again";
import { RelativeTime } from "@/components/relative-time";
import { type Level, f2, formatRatio } from "@/lib/certivity";
import { type StoredCheck, basisOf, newestBasis, shortVersion } from "@/lib/run-checks";
import { formatDuration, isFinished } from "@/lib/trace";

export type DraftScoreRun = {
  id: string;
  created_at: string;
  updated_at: string;
  status: string;
  model: string | null;
  agent_version: string | null;
};

// The part's drafts side by side, each with the latest check stored with it (run_checks, #51), so
// a writer change can be judged without opening every draft. Only the dev cases have an answer
// key; on any other part the table shows validity and the count, and says there is no score.
export function DraftScores({
  runs,
  checks,
  subgoal,
}: {
  runs: readonly DraftScoreRun[];
  checks: ReadonlyMap<string, StoredCheck>;
  subgoal: boolean;
}) {
  if (runs.length === 0) return null;
  const newest = newestBasis(checks.values());
  // Only succeeded drafts can be checked from here: the others have no output, and their file is
  // built and checked on their own page.
  const checkable = runs.filter((run) => run.status === "succeeded").map((run) => run.id);
  const unchecked = checkable.filter((id) => !checks.has(id));
  const stale = checkable.filter((id) => {
    const check = checks.get(id);
    return check !== undefined && newest !== null && basisOf(check) !== newest;
  });
  const scored = [...checks.values()].some((c) => c.result.score || c.result.subgoalScore);

  return (
    <div className="grid gap-2">
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full text-xs tabular-nums">
          <thead className="text-muted-foreground">
            <tr className="border-b">
              <th className="px-3 py-2 text-left font-normal">Draft</th>
              <th className="px-3 py-2 text-right font-normal">{subgoal ? "Changes" : "Requirements"}</th>
              {subgoal ? (
                <>
                  <Header>Flagged</Header>
                  <Header>Added</Header>
                  <th className="px-3 py-2 text-right font-normal">Change type</th>
                </>
              ) : (
                <>
                  <Header>Regulations</Header>
                  <Header>Pages</Header>
                  <Header>Requirements (estimate)</Header>
                </>
              )}
            </tr>
          </thead>
          <tbody className="divide-y">
            {runs.map((run) => (
              <Row key={run.id} run={run} check={checks.get(run.id) ?? null} subgoal={subgoal} newest={newest} />
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <p className="min-w-0 flex-1 basis-64">
          {subgoal
            ? "Precision and recall of the flagged and added requirements, and the share of change types right, from our sub-goal scorer. "
            : "F2 per level, precision and recall beneath it. The requirement level is a count estimate, not the platform's judgement. "}
          Each draft keeps its latest check, saved when its page is opened or checked from here.
          {checks.size > 0 && !scored ? " This part has no answer key, so there is no local score: only the platform scores it." : ""}
        </p>
        <CheckAgain unchecked={unchecked} stale={stale} all={checkable} />
      </div>
    </div>
  );
}

function Header({ children }: { children: string }) {
  return (
    <th className="px-3 py-2 text-right font-normal">
      {children}
      <span className="block text-[0.7rem]">F2 · P / R</span>
    </th>
  );
}

function Row({
  run,
  check,
  subgoal,
  newest,
}: {
  run: DraftScoreRun;
  check: StoredCheck | null;
  subgoal: boolean;
  newest: string | null;
}) {
  const result = check?.result ?? null;
  const version = shortVersion(run.agent_version);
  const otherBasis = check !== null && newest !== null && basisOf(check) !== newest;
  return (
    <tr className="align-top">
      <td className="px-3 py-2">
        <Link href={`/runs/${run.id}`} className="text-tint underline-offset-4 hover:underline">
          <RelativeTime iso={run.created_at} />
        </Link>
        <span className="block max-w-72 truncate font-mono text-muted-foreground">{run.model ?? "model not recorded"}</span>
        <span className="block text-muted-foreground">
          {isFinished(run.status)
            ? `${run.status === "failed" ? "failed after" : "took"} ${formatDuration(Date.parse(run.updated_at) - Date.parse(run.created_at))}`
            : run.status.replace("_", " ")}
          {version ? (
            <>
              {" · agent "}
              <span className="font-mono">{version}</span>
            </>
          ) : null}
        </span>
      </td>
      <td className="px-3 py-2 text-right">
        {result ? (
          <>
            {result.items ?? "–"}
            <span className={`block ${result.valid ? "text-success" : "text-danger"}`}>
              {result.valid ? "valid" : `${result.problemCount} problems`}
            </span>
            {check?.source === "stored" ? <span className="block text-muted-foreground">from stored rows</span> : null}
            {otherBasis ? <span className="block text-danger">older key or rate</span> : null}
          </>
        ) : (
          <span className="text-muted-foreground">not checked</span>
        )}
      </td>
      {subgoal ? (
        <>
          <Cell level={result?.subgoalScore?.flagged ?? null} />
          <Cell level={result?.subgoalScore?.added ?? null} />
          <td className="px-3 py-2 text-right">
            {result?.subgoalScore ? formatRatio(result.subgoalScore.changeType.accuracy) : "–"}
          </td>
        </>
      ) : (
        <>
          <Cell level={result?.score?.regulation ?? null} />
          <Cell level={result?.score?.page ?? null} />
          <Cell level={result?.requirementEstimate ?? null} />
        </>
      )}
    </tr>
  );
}

function Cell({ level }: { level: Pick<Level, "precision" | "recall"> | null }) {
  if (!level) return <td className="px-3 py-2 text-right text-muted-foreground">–</td>;
  return (
    <td className="px-3 py-2 text-right">
      <span className="text-sm font-medium">{formatRatio(f2(level))}</span>
      <span className="block text-muted-foreground">
        {formatRatio(level.precision)} / {formatRatio(level.recall)}
      </span>
    </td>
  );
}
