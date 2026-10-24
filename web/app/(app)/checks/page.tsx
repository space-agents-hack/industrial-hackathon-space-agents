import type { Metadata } from "next";

import { CheckFileForm } from "@/components/check-file-form";

export const metadata: Metadata = { title: "Checks" };

// For files made outside a run (a script, a hand edit, a teammate's laptop): the same checks a
// run's output gets, before anyone spends one of the five uploads an hour on it.
export default function ChecksPage() {
  return (
    <div className="grid gap-5">
      <h1 className="sr-only">Checks</h1>
      <CheckFileForm />
    </div>
  );
}
