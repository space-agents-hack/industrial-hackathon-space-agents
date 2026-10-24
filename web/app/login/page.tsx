import type { Metadata } from "next";
import Link from "next/link";

import { AuthFrame } from "@/components/auth-frame";
import { LoginForm } from "@/components/login-form";
import { LOCAL_DEMO_USER } from "@/lib/config";
import { databaseOf } from "@/lib/setup";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  // Only against a database on this machine. Against the hosted one these values open nothing
  // and showing them would only mislead.
  const local = databaseOf(process.env.NEXT_PUBLIC_SUPABASE_URL) === "local";
  return (
    <AuthFrame
      title="Sign in"
      footer={
        <>
          {local ? (
            <p className="rounded-lg border bg-card px-3 py-2 text-xs">
              Local demo user: <code className="font-mono">{LOCAL_DEMO_USER.email}</code> /{" "}
              <code className="font-mono">{LOCAL_DEMO_USER.password}</code>
            </p>
          ) : null}
          {/* SYS-35. An account alone opens nothing: an admin approves who joins an organisation. */}
          <p>
            New here?{" "}
            <Link href="/signup" className="text-tint underline-offset-4 hover:underline">
              Create an account
            </Link>
            , then ask to join your organisation.
          </p>
        </>
      }
    >
      <LoginForm />
    </AuthFrame>
  );
}
