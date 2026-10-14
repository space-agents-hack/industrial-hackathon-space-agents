"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ROLES, ROLE_DESCRIPTIONS, ROLE_LABELS, type Role } from "@/lib/access";
import { MIN_PASSWORD_LENGTH, generatePassword } from "@/lib/admin";
import { sendJson } from "@/lib/send-json";

type Added = { email: string; password: string; created: boolean };

// Used on People and, with the role fixed to admin, right after creating an organisation. The
// password is shown once, here, because the app sends no email: the admin passes it on.
export function AddPersonForm({
  org,
  fixedRole,
  submitLabel = "Add person",
  onAdded,
}: {
  org: string;
  fixedRole?: Role;
  submitLabel?: string;
  onAdded?: () => void;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>(fixedRole ?? "member");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<Added | null>(null);

  async function add() {
    setBusy(true);
    setError(null);
    const result = await sendJson<{ created: boolean }>("/api/admin/people", "POST", {
      org,
      email,
      role: fixedRole ?? role,
      password,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setAdded({ email: email.trim().toLowerCase(), password, created: result.body.created });
    setEmail("");
    setPassword("");
    router.refresh();
    onAdded?.();
  }

  return (
    <div className="grid gap-2">
      {added ? (
        <div role="status" className="grid gap-1 rounded-md border border-success-border bg-success-surface px-3 py-2 text-success">
          {added.created ? (
            <>
              <p>
                Added <strong>{added.email}</strong>. Their password, shown only now:
              </p>
              <code className="w-fit rounded-sm border border-success-border bg-card px-1.5 py-0.5 font-mono text-foreground select-all">
                {added.password}
              </code>
              <p className="text-xs">
                Share it privately (not in a shared channel). The app sends no email. They can sign
                in right away.
              </p>
            </>
          ) : (
            <p>
              <strong>{added.email}</strong> already had an account and was added with it. Their
              password was not changed; the one typed here does not apply.
            </p>
          )}
          <Button variant="outline" size="sm" className="w-fit" onClick={() => setAdded(null)}>
            Done
          </Button>
        </div>
      ) : null}

      <form
        className="grid gap-2 sm:grid-cols-[1fr_9rem_1fr_auto] sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <div className="grid gap-1">
          <Label htmlFor={`email-${org}`}>Email</Label>
          <Input
            id={`email-${org}`}
            type="email"
            autoComplete="off"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`role-${org}`}>Role</Label>
          {fixedRole ? (
            <p id={`role-${org}`} className="flex h-8 items-center">
              {ROLE_LABELS[fixedRole]}
            </p>
          ) : (
            <select
              id={`role-${org}`}
              className="h-8 rounded-md border border-input bg-card px-2 text-sm"
              value={role}
              onChange={(event) => setRole(event.target.value as Role)}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`password-${org}`}>Initial password</Label>
          <div className="flex gap-1.5">
            <Input
              id={`password-${org}`}
              autoComplete="new-password"
              spellCheck={false}
              minLength={MIN_PASSWORD_LENGTH}
              required
              className="font-mono"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <Button type="button" variant="outline" onClick={() => setPassword(generatePassword())}>
              Generate
            </Button>
          </div>
        </div>
        <Button type="submit" disabled={busy}>
          {busy ? "Adding…" : submitLabel}
        </Button>
      </form>
      <p className="text-xs text-muted-foreground">
        {fixedRole ? null : <>{ROLE_LABELS[role]}: {ROLE_DESCRIPTIONS[role]}. </>}
        At least {MIN_PASSWORD_LENGTH} characters. If the email already has an account, that
        account is added and keeps its password.
      </p>
      {error ? (
        <p role="alert" className="text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
