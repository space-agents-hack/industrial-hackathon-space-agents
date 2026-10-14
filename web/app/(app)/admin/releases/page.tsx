import type { Metadata } from "next";
import { Suspense } from "react";

import { ControlTokenSteps } from "@/components/admin/control-token-steps";
import { NoAccess } from "@/components/no-access";
import { ReleaseProgress } from "@/components/release-progress";
import { getCurrentOrg } from "@/lib/current-org";
import { canWrite } from "@/lib/github";

export const metadata: Metadata = { title: "Releases" };

export default function ReleasesPage() {
  return (
    <Suspense fallback={<p className="text-muted-foreground">Loading releases…</p>}>
      <Releases />
    </Suspense>
  );
}

async function Releases() {
  const { access, failed } = await getCurrentOrg();
  if (failed) return <NoAccess failed />;
  if (!access.platformAdmin) {
    return <p className="text-muted-foreground">Only a platform admin sees the deployment&apos;s releases.</p>;
  }
  return (
    <div className="grid gap-3">
      <p className="max-w-prose text-muted-foreground">
        Every push to main runs the checks, then releases: migrations, agent, web, each
        smoke-tested before it goes live. A failed step leaves the previous version in place.
      </p>
      <ReleaseProgress
        endpoint="/api/admin/releases"
        startUrl={canWrite() ? "/api/admin/releases" : undefined}
        notConfigured={<ControlTokenSteps />}
      />
    </div>
  );
}
