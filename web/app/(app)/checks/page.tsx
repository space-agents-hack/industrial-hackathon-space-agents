import type { Metadata } from "next";
import { Suspense } from "react";

import { CheckFileForm } from "@/components/check-file-form";
import { getCurrentOrg } from "@/lib/current-org";

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

async function Form() {
  const { current } = await getCurrentOrg();
  return <CheckFileForm organizationId={current?.id ?? null} />;
}
