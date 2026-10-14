import Link from "next/link";
import { Suspense } from "react";

import { NavLinks, NavLinksFallback } from "@/components/nav-links";
import { SignOutButton } from "@/components/sign-out-button";
import { APP_NAME } from "@/lib/config";
import { createClient, getSessionUser } from "@/lib/supabase/server";

export function AppHeader() {
  return (
    <header className="border-b bg-card">
      <div className="mx-auto flex h-11 w-full max-w-5xl items-center gap-3 px-4">
        <Link href="/" className="font-semibold tracking-tight">
          {APP_NAME}
        </Link>
        <Suspense fallback={<NavLinksFallback />}>
          <NavLinks />
        </Suspense>
        <div className="ml-auto flex min-w-0 items-center gap-3">
          {/* Reading the session is request-time work; the boundary keeps the rest of the header
              in the static shell. */}
          <Suspense fallback={null}>
            <SignedInAs />
          </Suspense>
          <SignOutButton />
        </div>
      </div>
    </header>
  );
}

async function SignedInAs() {
  const user = await getSessionUser(await createClient());
  if (!user?.email) return null;
  return <span className="hidden truncate text-xs text-muted-foreground sm:inline">{user.email}</span>;
}
