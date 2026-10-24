import type { Metadata } from "next";
import { Suspense } from "react";

import { NoAccess } from "@/components/no-access";
import { SetupGuide } from "@/components/setup/setup-guide";
import { getCurrentOrg } from "@/lib/current-org";

export const metadata: Metadata = { title: "Setup" };

// The deployment's steps inside Settings (SYS-37). They are the platform's, not one organisation's:
// an admin of a client organisation does not see this tab.
export default function SettingsSetupPage(props: PageProps<"/admin/setup">) {
  return (
    <Suspense fallback={<p className="text-muted-foreground">Checking…</p>}>
      <Setup searchParams={props.searchParams} />
    </Suspense>
  );
}

async function Setup({ searchParams }: Pick<PageProps<"/admin/setup">, "searchParams">) {
  const { access, failed } = await getCurrentOrg();
  if (failed) return <NoAccess failed />;
  if (!access.platformAdmin) {
    return <p className="text-muted-foreground">Only a platform admin sets up the deployment.</p>;
  }
  return (
    <div className="grid max-w-3xl gap-4">
      <SetupGuide searchParams={searchParams} />
    </div>
  );
}
