import type { Metadata } from "next";
import { Suspense } from "react";

import { type RegulationOption, ChangesForm } from "@/components/changes-form";
import { NoAccess } from "@/components/no-access";
import { hasNoAccess } from "@/lib/access";
import { listSubgoalCases } from "@/lib/agent-admin";
import { getCurrentOrg } from "@/lib/current-org";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Changes" };

// Certivity's sub-goal: given requirements written from one version of a regulation, which of them
// a newer version changes, removes or adds to. The result goes through the same checks as any
// file before anyone uploads it.
export default function ChangesPage() {
  return (
    <div className="grid gap-4">
      <h1 className="text-base font-semibold">Regulation changes</h1>
      <Suspense fallback={<p className="text-muted-foreground">Loading the library…</p>}>
        <Changes />
      </Suspense>
    </div>
  );
}

async function Changes() {
  const { access, failed, current } = await getCurrentOrg();
  if (failed || hasNoAccess(access)) return <NoAccess failed={failed} />;
  if (!current) return <p className="text-muted-foreground">There is no organisation yet.</p>;
  const supabase = await createClient();

  const [{ data, error }, cases] = await Promise.all([
    supabase
      .from("regulations")
      .select("id, code, regulation_versions(id, version_label, role)")
      .eq("organization_id", current.id),
    listSubgoalCases(),
  ]);
  if (error) {
    console.error("Changes: reading the library failed", error);
    return (
      <p role="alert" className="text-danger">
        The library could not be loaded. Check that the database is reachable and reload.
      </p>
    );
  }

  // Only regulations with two versions can change; "UN R3" before "UN R10".
  const regulations: RegulationOption[] = data
    .filter((r) => r.regulation_versions.length >= 2)
    .sort((a, b) => a.code.localeCompare(b.code, "en", { numeric: true }))
    .map((r) => ({
      id: r.id,
      code: r.code,
      versions: r.regulation_versions
        .map((v) => ({ id: v.id, label: v.version_label, role: v.role }))
        .sort((a, b) => a.label.localeCompare(b.label, "en", { numeric: true })),
    }));

  if (regulations.length === 0) {
    return (
      <p className="rounded-md border border-dashed px-3 py-6 text-center text-muted-foreground">
        No regulation in the library of {current.name} has two versions yet. Import an index file on the
        Regulations page first.
      </p>
    );
  }
  return <ChangesForm org={current.id} regulations={regulations} cases={cases} />;
}
