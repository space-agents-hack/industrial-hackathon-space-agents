import type { Metadata } from "next";

import { LoginForm } from "@/components/login-form";
import { APP_NAME } from "@/lib/config";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-10">
      <div className="w-full max-w-xs">
        <h1 className="mb-4 text-base font-semibold tracking-tight">{APP_NAME}</h1>
        <div className="rounded-md border bg-card p-4">
          <LoginForm />
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Accounts are created by an administrator. There is no sign-up.
        </p>
      </div>
    </main>
  );
}
