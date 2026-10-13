import type { Metadata } from "next";
import { Suspense } from "react";

import { NewRunForm } from "@/components/new-run-form";
import { RunList } from "@/components/run-list";
import { fetchRunList } from "@/lib/runs";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Runs" };

export default function HomePage() {
  return (
    <div className="grid gap-5">
      <NewRunForm />
      <section className="grid gap-2">
        <h2 className="text-sm font-semibold">Runs</h2>
        <Suspense fallback={<p className="text-muted-foreground">Loading runs…</p>}>
          <Runs />
        </Suspense>
      </section>
    </div>
  );
}

async function Runs() {
  const supabase = await createClient();
  const runs = await fetchRunList(supabase).catch((error: unknown) => {
    console.error("Home: could not load runs", error);
    return null;
  });
  if (!runs) {
    return (
      <p role="alert" className="text-red-700">
        The runs could not be loaded. Check that the database is reachable and reload.
      </p>
    );
  }
  return <RunList initialRuns={runs} />;
}
