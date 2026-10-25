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

// What the sidebar holds, top to bottom, in the order a person narrows down: which organisation,
// which project, which section of it. Then Settings for those who manage the organisation, and the
// account. This replaces the two header rows: the second one changed with the project and pushed
// the page down, and a sidebar keeps "where am I" visible on every page (HIG, Sidebars).
export function AppSidebar() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-4 pt-5 pb-4">
        <Link href="/" className="font-display text-2xl leading-none tracking-tight">
          {APP_NAME}
        </Link>
      </div>
      {/* Organisation, project and role are request-time; each boundary keeps the rest of the
          sidebar in the static shell. */}
      <Suspense fallback={<div className="h-28" />}>
        <Where />
      </Suspense>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        <Suspense fallback={null}>
          <Sections />
        </Suspense>
      </div>
      <div className="grid gap-1 border-t px-2 py-3">
        <Suspense fallback={null}>
          <Settings />
        </Suspense>
        <div className="flex items-center gap-2 px-2.5 pt-1">
          <Suspense fallback={<span className="flex-1" />}>
            <SignedInAs />
          </Suspense>
          <SignOutButton iconOnly />
        </div>
      </div>
    </div>
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
    <div className="grid gap-3 px-4">
      <div className="grid gap-1">
        <span className="text-xs font-medium text-muted-foreground">Organisation</span>
        {visible.length < 2 ? (
          <span className="truncate text-sm font-medium" title={current.name}>
            {current.name}
          </span>
        ) : (
          <OrgSwitcher organizations={visible} currentId={current.id} />
        )}
        {current.readOnly ? (
          <span className="text-xs text-muted-foreground">
            Read-only: everything can be opened, nothing can be changed, and no model is called.
          </span>
        ) : null}
      </div>
      <div className="grid gap-1">
        <span className="text-xs font-medium text-muted-foreground">Project</span>
        <ProjectSwitcher projects={projects ?? []} currentId={project?.id ?? null} />
      </div>
    </div>
  );
}

async function Sections() {
  const project = await getCurrentProject();
  if (!project) {
    return (
      <p className="px-2.5 py-1 text-sm text-muted-foreground">
        Pick a project to see its parts, draft requirements and regulations.
      </p>
    );
  }
  return <ProjectNav projectId={project.id} />;
}

async function Settings() {
  const { access, current } = await getCurrentOrg();
  return showsAdmin(access, current) ? <SettingsLink /> : null;
}

async function SignedInAs() {
  const user = await getSessionUser(await createClient());
  if (!user?.email) return <span className="flex-1" />;
  return (
    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={user.email}>
      {user.email}
    </span>
  );
}
