"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ROLES, ROLE_DESCRIPTIONS, ROLE_LABELS, type Role, isRole } from "@/lib/access";
import { MIN_PASSWORD_LENGTH, generatePassword } from "@/lib/admin";
import { sendJson } from "@/lib/send-json";

type Added = { email: string; role: Role; password: string | null; created: boolean };
type Suggestion = { email: string; role: string | null; status: string | null };

// Used on People and, with the role fixed to admin, right after creating an organisation. A
// person is one account with a place in each organisation, so an email that already has an
// account is added as it is, with no password. The password field appears only when the email
// has no account yet; that password is shown once, here, because the app sends no email.
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
  const [needsPassword, setNeedsPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<Added | null>(null);
  const suggestions = useSuggestions(org, email);
  const already = suggestions.find((s) => s.email === email.trim().toLowerCase() && s.role !== null);

  async function add() {
    setBusy(true);
    setError(null);
    const chosenRole = fixedRole ?? role;
    const result = await sendJson<{ created: boolean }>("/api/admin/people", "POST", {
      org,
      email,
      role: chosenRole,
      password: needsPassword ? password : null,
    });
    setBusy(false);
    if (!result.ok) {
      // Not a failure: the email is new, and the form now asks for what a new account needs.
      if (result.body.needs_password === true && !needsPassword) {
        setNeedsPassword(true);
        return;
      }
      setError(result.error);
      return;
    }
    setAdded({
      email: email.trim().toLowerCase(),
      role: chosenRole,
      password: needsPassword ? password : null,
      created: result.body.created,
    });
    setEmail("");
    setPassword("");
    setNeedsPassword(false);
    router.refresh();
    onAdded?.();
  }

  const listId = `people-${org}`;

  return (
    <div className="grid gap-2">
      {added ? (
        <div role="status" className="grid gap-1 rounded-md border border-success-border bg-success-surface px-3 py-2 text-success">
          {added.created && added.password ? (
            <>
              <p>
                Created an account for <strong>{added.email}</strong> as {ROLE_LABELS[added.role].toLowerCase()}. Their
                password, shown only now:
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
              <strong>{added.email}</strong> is now {ROLE_LABELS[added.role].toLowerCase()} here, with the account and
              password they already had. They find this organisation in the organisation switcher.
            </p>
          )}
          <Button variant="outline" size="sm" className="w-fit" onClick={() => setAdded(null)}>
            Done
          </Button>
        </div>
      ) : null}

      <form
        className="grid gap-2 sm:grid-cols-[1fr_9rem_auto] sm:items-end"
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
            list={listId}
            required
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              setError(null);
            }}
          />
          <datalist id={listId}>
            {suggestions.map((s) => (
              <option key={s.email} value={s.email}>
                {s.role && isRole(s.role) ? `already ${ROLE_LABELS[s.role].toLowerCase()} here` : "has an account"}
              </option>
            ))}
          </datalist>
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
        <Button type="submit" disabled={busy || (needsPassword && password === "")}>
          {busy ? "Adding…" : needsPassword ? "Create account and add" : submitLabel}
        </Button>

        {needsPassword ? (
          <div className="grid gap-1 sm:col-span-3">
            <Label htmlFor={`password-${org}`}>
              No account has this email yet. Initial password for the new account
            </Label>
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
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setNeedsPassword(false);
                  setPassword("");
                  setError(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
      </form>
      <p className="text-xs text-muted-foreground">
        {fixedRole ? null : <>{ROLE_LABELS[role]}: {ROLE_DESCRIPTIONS[role]}. </>}
        {already && already.role && isRole(already.role) ? (
          <>
            {already.email} is already {ROLE_LABELS[already.role].toLowerCase()} here; adding them again changes the
            role and makes them active.{" "}
          </>
        ) : null}
        Someone with an account (in this or any other organisation) is added with it, no password needed. Only
        a new email asks for an initial password, of at least {MIN_PASSWORD_LENGTH} characters.
      </p>
      {error ? (
        <p role="alert" className="text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// Existing accounts matching what is typed, from GET /api/admin/people/search. Waits for a pause in
// typing and drops an answer that arrives after the next keystroke, so the list never shows the
// matches for an older prefix.
function useSuggestions(org: string, email: string): Suggestion[] {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const query = email.trim().toLowerCase();

  useEffect(() => {
    if (query.length < 2) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/admin/people/search?org=${encodeURIComponent(org)}&q=${encodeURIComponent(query)}`, {
        signal: controller.signal,
      })
        .then((response) => (response.ok ? response.json() : { people: [] }))
        .then((body: { people?: Suggestion[] }) => setSuggestions(Array.isArray(body.people) ? body.people : []))
        .catch(() => {
          // Aborted by the next keystroke, or the search failed: the form works without it.
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [org, query]);

  return query.length < 2 ? [] : suggestions;
}
