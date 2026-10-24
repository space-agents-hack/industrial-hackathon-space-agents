"use client";

import Link from "next/link";
import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signUp } from "@/lib/auth-actions";

export function SignUpForm() {
  const [state, action, pending] = useActionState(signUp, null);

  if (state && "sent" in state) {
    return (
      <p role="status">
        Check <span className="font-medium">{state.sent}</span> for a link to confirm the account. It signs you in
        and takes you to choosing your organisation.
      </p>
    );
  }
  return (
    <form action={action} className="grid gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="email" required autoFocus defaultValue={state?.email} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="password">Password</Label>
        <Input id="password" name="password" type="password" autoComplete="new-password" minLength={8} required />
      </div>
      {state?.error ? (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? "Creating the account…" : "Create account"}
      </Button>
      <p className="text-xs text-muted-foreground">
        Next you ask to join your organisation, or ask for a new one. Nothing is visible until an admin approves.{" "}
        <Link href="/login" className="underline underline-offset-2">
          Sign in instead
        </Link>
      </p>
    </form>
  );
}
