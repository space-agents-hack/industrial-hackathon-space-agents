import type { Metadata } from "next";
import { Suspense } from "react";

import { CheckFileForm } from "@/components/check-file-form";
import { NoProject } from "@/components/projects/no-project";
import { getCurrentOrg } from "@/lib/current-org";
import { getCurrentProject } from "@/lib/current-project";

export const metadata: Metadata = { title: "Checks" };

// For files made outside a run (a script, a hand edit, a teammate's laptop): the same checks a
// run's output gets, before anyone spends one of the five uploads an hour on it.
export default function ChecksPage() {
  return (
    <div className="grid gap-5">
      <h1 className="sr-only">Checks</h1>
      {/* The organisation is only known at request time: its library is what citations are
          checked against. */}
      <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
        <Form />
      </Suspense>
    </div>
  );
}

// Inside a project like the other sections (SYS-36). The citations are still checked against the
// organisation's whole library: a file citing a regulation outside the project's choice is a
// scoping question for the person, not an invalid citation.
async function Form() {
  const [{ current }, project] = await Promise.all([getCurrentOrg(), getCurrentProject()]);
  if (!project) return <NoProject />;
  return <CheckFileForm organizationId={current?.id ?? null} />;
}
