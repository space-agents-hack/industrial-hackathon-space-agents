import type { Metadata } from "next";

import { SignUpForm } from "@/components/signup-form";
import { APP_NAME } from "@/lib/config";

export const metadata: Metadata = { title: "Create an account" };

export default function SignUpPage() {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-10">
      <div className="w-full max-w-xs">
        <h1 className="mb-4 text-base font-semibold tracking-tight">{APP_NAME}</h1>
        <div className="rounded-md border bg-card p-4">
          <SignUpForm />
        </div>
      </div>
    </main>
  );
}
