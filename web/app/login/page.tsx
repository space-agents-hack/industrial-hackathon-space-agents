import type { Metadata } from "next";
import Link from "next/link";

import { LoginForm } from "@/components/login-form";
import { APP_NAME, LOCAL_DEMO_USER } from "@/lib/config";
import { databaseOf } from "@/lib/setup";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  // Only against a database on this machine. Against the hosted one these values open nothing
  // and showing them would only mislead.
  const local = databaseOf(process.env.NEXT_PUBLIC_SUPABASE_URL) === "local";
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-10">
      <div className="w-full max-w-xs">
        <h1 className="mb-4 text-base font-semibold tracking-tight">{APP_NAME}</h1>
        <div className="rounded-md border bg-card p-4">
          <LoginForm />
        </div>
        {local ? (
          <p className="mt-3 rounded-md border bg-card px-3 py-2 text-xs">
            Local demo user: <code className="font-mono">{LOCAL_DEMO_USER.email}</code> /{" "}
            <code className="font-mono">{LOCAL_DEMO_USER.password}</code>
          </p>
        ) : null}
        {/* SYS-35. An account alone opens nothing: an admin approves who joins an organisation. */}
        <p className="mt-3 text-xs text-muted-foreground">
          New here?{" "}
          <Link href="/signup" className="text-primary underline-offset-4 hover:underline">
            Create an account
          </Link>
          , then ask to join your organisation.
        </p>
      </div>
    </main>
  );
}
