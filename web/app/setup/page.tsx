import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { SetupGuide } from "@/components/setup/setup-guide";
import { SignOutButton } from "@/components/sign-out-button";
import { APP_NAME } from "@/lib/config";
import { showsAdmin } from "@/lib/access";
import { getCurrentOrg } from "@/lib/current-org";
import { createClient, getSessionUser } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Setup" };

// The steps to a local or a production environment. On a developer's machine this page needs
// nothing: no database, no sign-in, no agent (`make dev` on a fresh clone). It sits outside the (app) group for
// that reason, and proxy.ts lets it through. What you type into its production form goes from this
// browser to this machine and on to GitHub, Vercel and Supabase; nothing is kept here.
export default function SetupPage(props: PageProps<"/setup">) {
  return (
    <>
      <SetupHeader />
      <main className="mx-auto grid w-full max-w-3xl flex-1 content-start gap-4 px-4 py-5">
        <Suspense fallback={<p className="text-muted-foreground">Checking…</p>}>
          <SetupGuide searchParams={props.searchParams} />
        </Suspense>
        <p className="text-xs text-muted-foreground">
          What you type here goes from this browser to this machine and on to GitHub, Vercel and
          Supabase; nothing is saved on this machine. GitHub keeps the production values where only
          the workflows can read them; this page sees only their names.
        </p>
      </main>
    </>
  );
}

// The same frame as the app's header, always rendered as it is; only the parts that depend on
// the session are filled in per request, each inside its own Suspense. Rendering the whole header
// from one per-request component made the development server reload the page in a loop.
function SetupHeader() {
  return (
    <header className="border-b bg-card">
      <div className="mx-auto flex h-11 w-full max-w-5xl items-center gap-3 px-4">
        <Link href="/" className="font-semibold tracking-tight">
          {APP_NAME}
        </Link>
        <span className="text-sm text-muted-foreground">Setup</span>
        <Suspense fallback={null}>
          <SetupNav />
        </Suspense>
        <div className="ml-auto flex min-w-0 items-center gap-3">
          <Suspense fallback={null}>
            <SetupAccount />
          </Suspense>
        </div>
      </div>
    </header>
  );
}

// Without the Supabase variables there is no session to look for, and asking would throw.
async function sessionUser() {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) {
    return null;
  }
  return getSessionUser(await createClient()).catch(() => null);
}

// The same steps are in Settings, Setup (SYS-37). This page stays for a fresh clone, where there
// is no database and no sign-in yet, and for the GitHub callbacks, which return here.
async function SetupNav() {
  if (!(await sessionUser())) return null;
  const { access, current } = await getCurrentOrg();
  if (!showsAdmin(access, current)) return null;
  return (
    <Link href="/admin" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
      Back to Settings
    </Link>
  );
}

async function SetupAccount() {
  const user = await sessionUser();
  if (!user) {
    // /login, not /: signed out, / comes straight back here.
    return (
      <Link
        href="/login"
        className="inline-flex h-8 items-center rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        Sign in
      </Link>
    );
  }
  return (
    <>
      {user.email ? (
        <span className="hidden truncate text-xs text-muted-foreground md:inline">{user.email}</span>
      ) : null}
      <SignOutButton />
    </>
  );
}
