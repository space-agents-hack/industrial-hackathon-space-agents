import Link from "next/link";
import { Suspense } from "react";

import { ProjectNav, SettingsLink } from "@/components/nav-links";
import { OrgSwitcher } from "@/components/org-switcher";
import { ProjectSwitcher } from "@/components/project-switcher";
import { SignOutButton } from "@/components/sign-out-button";
import { showsAdmin, visibleOrganizations } from "@/lib/access";
import { APP_NAME } from "@/lib/config";
import { getCurrentOrg } from "@/lib/current-org";
import { getCurrentProject } from "@/lib/current-project";
import { createClient, getSessionUser } from "@/lib/supabase/server";

// Two rows. The first says where the person is: organisation › project, then Settings for those who
// manage it. The second holds the project's sections and exists only inside a project (SYS-36): no
// project, no Runs, Regulations, Changes or Checks to offer.
export function AppHeader() {
  return (
    <header className="border-b bg-card">
      <div className="mx-auto flex h-11 w-full max-w-5xl items-center gap-2 px-4">
        <Link href="/" className="shrink-0 font-semibold tracking-tight">
          {APP_NAME}
        </Link>
        {/* Organisation, project and role are request-time; each boundary keeps the rest of the
            header in the static shell. */}
        <Suspense fallback={null}>
          <Where />
        </Suspense>
        <div className="ml-auto flex min-w-0 shrink-0 items-center gap-3">
          <Suspense fallback={null}>
            <Settings />
          </Suspense>
          <Suspense fallback={null}>
            <SignedInAs />
          </Suspense>
          <SignOutButton />
        </div>
      </div>
      <Suspense fallback={null}>
        <ProjectRow />
      </Suspense>
    </header>
  );
}

// The organisation is always named: projects, cases and the regulation library all belong to it,
// and a person who cannot see which one they are in cannot tell whose data they are looking at.
// The switcher appears only when there is another one to switch to.
async function Where() {
  const [{ access, current }, project] = await Promise.all([getCurrentOrg(), getCurrentProject()]);
  if (!current) return null;
  const visible = visibleOrganizations(access);
  const supabase = await createClient();
  const { data: projects } = await supabase
    .from("projects")
    .select("id, name")
    .eq("organization_id", current.id)
    .order("name");
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {visible.length < 2 ? (
        <span className="max-w-40 truncate text-sm text-muted-foreground" title="Organisation">
          {current.name}
        </span>
      ) : (
        <OrgSwitcher organizations={visible} currentId={current.id} />
      )}
      <span aria-hidden className="text-muted-foreground">
        ›
      </span>
      <ProjectSwitcher projects={projects ?? []} currentId={project?.id ?? null} />
    </div>
  );
}

async function Settings() {
  const { access, current } = await getCurrentOrg();
  return showsAdmin(access, current) ? <SettingsLink /> : null;
}

async function ProjectRow() {
  const project = await getCurrentProject();
  if (!project) return null;
  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-1">
      <ProjectNav projectId={project.id} />
    </div>
  );
}

async function SignedInAs() {
  const user = await getSessionUser(await createClient());
  if (!user?.email) return null;
  return <span className="hidden truncate text-xs text-muted-foreground lg:inline">{user.email}</span>;
}
