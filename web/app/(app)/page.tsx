import { redirect } from "next/navigation";
import { Suspense } from "react";

import { NoAccess } from "@/components/no-access";
import { hasNoAccess } from "@/lib/access";
import { getCurrentOrg } from "@/lib/current-org";
import { getCurrentProject } from "@/lib/current-project";

// Where the app opens, and where sign-in lands (SYS-35, SYS-36): no organisation yet, the
// onboarding page; no project picked, the picker; otherwise the project's cases.
export default function HomePage() {
  return (
    <Suspense fallback={<p className="text-muted-foreground">Opening…</p>}>
      <Home />
    </Suspense>
  );
}

async function Home() {
  const [{ access, failed }, project] = await Promise.all([getCurrentOrg(), getCurrentProject()]);
  if (failed) return <NoAccess failed />;
  if (hasNoAccess(access)) redirect("/welcome");
  redirect(project ? `/projects/${project.id}` : "/projects");
}
