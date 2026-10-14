import Link from "next/link";
import { Suspense } from "react";

import { NavLinks, NavLinksFallback } from "@/components/nav-links";
import { OrgSwitcher } from "@/components/org-switcher";
import { SignOutButton } from "@/components/sign-out-button";
import { showsAdmin, visibleOrganizations } from "@/lib/access";
import { APP_NAME } from "@/lib/config";
import { getCurrentOrg } from "@/lib/current-org";
import { createClient, getSessionUser } from "@/lib/supabase/server";

export function AppHeader() {
  return (
    <header className="border-b bg-card">
      <div className="mx-auto flex h-11 w-full max-w-5xl items-center gap-3 px-4">
        <Link href="/" className="font-semibold tracking-tight">
          {APP_NAME}
        </Link>
        {/* The Admin link depends on the role, which is request-time; the boundary keeps the rest
            of the header in the static shell. */}
        <Suspense fallback={<NavLinksFallback />}>
          <Nav />
        </Suspense>
        <div className="ml-auto flex min-w-0 items-center gap-3">
          <Suspense fallback={null}>
            <Organisation />
          </Suspense>
          <Suspense fallback={null}>
            <SignedInAs />
          </Suspense>
          <SignOutButton />
        </div>
      </div>
    </header>
  );
}

async function Nav() {
  const { access, current } = await getCurrentOrg();
  return <NavLinks showAdmin={showsAdmin(access, current)} />;
}

// One organisation (the usual case for a clone) shows nothing: there is nothing to switch to,
// and the name would only take room.
async function Organisation() {
  const { access, current } = await getCurrentOrg();
  const visible = visibleOrganizations(access);
  if (!current || visible.length < 2) return null;
  return <OrgSwitcher organizations={visible} currentId={current.id} />;
}

async function SignedInAs() {
  const user = await getSessionUser(await createClient());
  if (!user?.email) return null;
  return <span className="hidden truncate text-xs text-muted-foreground md:inline">{user.email}</span>;
}
