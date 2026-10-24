"use client";

import { useState } from "react";

import { CertivityChecks } from "@/components/certivity-checks";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SUBMISSION_MAX_BYTES, isExpectedFile } from "@/lib/certivity";

// Paste or load a submission and press Check. The text goes to the agent and back; nothing is
// stored, so it is also safe for a file that is not finished.
export function CheckFileForm({ organizationId }: { organizationId: string | null }) {
  const [text, setText] = useState("");
  const [checked, setChecked] = useState<string | null>(null);
  // An expected.json to score against instead of the one in the database (score_local.py --expected).
  const [expected, setExpected] = useState<{ name: string; text: string } | null>(null);
  const [checkedExpected, setCheckedExpected] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const [error, setError] = useState<string | null>(null);

  async function loadFile(file: File | undefined) {
    if (!file) return;
    if (file.size > SUBMISSION_MAX_BYTES) {
      setError(`${file.name} is over Certivity's 5 MB limit.`);
      return;
    }
    try {
      setText(await file.text());
      setError(null);
      setChecked(null);
    } catch {
      setError(`${file.name} could not be read.`);
    }
  }

  async function loadExpected(file: File | undefined) {
    if (!file) return;
    try {
      const raw = await file.text();
      const data: unknown = JSON.parse(raw);
      if (!isExpectedFile(data)) {
        setError(`${file.name} is not an expected.json: it has no requirements or changes list.`);
        return;
      }
      setExpected({ name: file.name, text: raw });
      setError(null);
    } catch {
      setError(`${file.name} is not valid JSON.`);
    }
  }

  return (
    <div className="grid gap-4">
      <form
        className="grid gap-3 rounded-md border bg-card p-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!text.trim()) return;
          setChecked(text);
          setCheckedExpected(expected?.text ?? null);
          setRound((n) => n + 1);
        }}
      >
        <div className="grid gap-1">
          <h2 className="text-sm font-semibold">Check a submission file</h2>
          <p className="text-xs text-muted-foreground">
            Runs Certivity&apos;s validate.py on a main-goal or sub-goal file, the same check the
            platform runs on upload. For the worked examples it also scores the file: dev-rear-lamp with
            score_local.py, subgoal-dev with our sub-goal scorer. Nothing is uploaded to Certivity and
            nothing is stored.
          </p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="submission">Submission JSON</Label>
          <Textarea
            id="submission"
            rows={10}
            placeholder='{ "team_id": "…", "case_id": "dev-rear-lamp", "requirements": [ … ] }'
            className="max-h-96 font-mono text-xs"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor="submission-file" className="text-xs text-muted-foreground">
              Load from file
            </Label>
            <input
              id="submission-file"
              type="file"
              accept=".json,application/json"
              className="text-xs"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                void loadFile(file);
              }}
            />
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="expected-file">Expected file (optional)</Label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id="expected-file"
              type="file"
              accept=".json,application/json"
              className="text-xs"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                void loadExpected(file);
              }}
            />
            {expected ? (
              <>
                <span className="text-xs">{expected.name}</span>
                <Button type="button" variant="outline" size="sm" onClick={() => setExpected(null)}>
                  Remove
                </Button>
              </>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            Your own expected.json: the score is computed against it, whatever case_id the submission
            names. Without one, dev-rear-lamp and subgoal-dev are scored against Certivity&apos;s. Not
            stored.
          </p>
        </div>
        <div className="flex items-center">
          <Button type="submit" className="ml-auto" disabled={text.trim() === ""}>
            Check
          </Button>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </form>
      {/* Keyed so that pressing Check again on the same text runs the checks again. */}
      {checked !== null ? <CertivityChecks key={round} text={checked} organizationId={organizationId} expected={checkedExpected} /> : null}
    </div>
  );
}
