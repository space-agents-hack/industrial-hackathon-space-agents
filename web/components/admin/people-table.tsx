"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { RelativeTime } from "@/components/relative-time";
import { ToneBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type MemberStatus, ROLES, ROLE_LABELS, type Role, isRole } from "@/lib/access";
import { MIN_PASSWORD_LENGTH, generatePassword } from "@/lib/admin";
import { sendJson } from "@/lib/send-json";
import { cn } from "@/lib/utils";

export type Person = {
  userId: string;
  email: string;
  role: string;
  status: string;
  lastSignInAt: string | null;
  canResetPassword: boolean;
  isYou: boolean;
};

export function PeopleTable({ org, people }: { org: string; people: Person[] }) {
  if (people.length === 0) {
    return <p className="rounded-xl border border-dashed px-3 py-6 text-center text-muted-foreground">Nobody yet.</p>;
  }
  return (
    <ul className="divide-y overflow-hidden rounded-xl border bg-card">
      {people.map((person) => (
        <PersonRow key={person.userId} org={org} person={person} />
      ))}
    </ul>
  );
}

function PersonRow({ org, person }: { org: string; person: Person }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [passwordMode, setPasswordMode] = useState(false);
  const [password, setPassword] = useState("");
  const [shownPassword, setShownPassword] = useState<string | null>(null);
  const suspended = person.status === "suspended";

  async function setMember(role: Role, status: MemberStatus) {
    setBusy(true);
    setMessage(null);
    const result = await sendJson("/api/admin/people", "PATCH", { org, user_id: person.userId, role, status });
    setBusy(false);
    if (!result.ok) {
      // The database's own sentence, e.g. "This would leave the organisation without an admin."
      setMessage({ ok: false, text: result.error });
      return;
    }
    router.refresh();
  }

  // Removing takes the person out of this organisation only; their account and their other
  // organisations stay. Removing yourself ends your access here, so the page you are on would be
  // refused: go to the start instead.
  async function remove() {
    const where = person.isYou ? "You will lose access to this organisation." : "Their account and other organisations stay.";
    if (!window.confirm(`Remove ${person.email} from this organisation? ${where}`)) return;
    setBusy(true);
    setMessage(null);
    const result = await sendJson("/api/admin/people", "DELETE", { org, user_id: person.userId });
    setBusy(false);
    if (!result.ok) {
      setMessage({ ok: false, text: result.error });
      return;
    }
    if (person.isYou) router.push("/");
    else router.refresh();
  }

  async function savePassword() {
    setBusy(true);
    setMessage(null);
    const result = await sendJson("/api/admin/people/password", "POST", {
      org,
      user_id: person.userId,
      password,
    });
    setBusy(false);
    if (!result.ok) {
      setMessage({ ok: false, text: result.error });
      return;
    }
    setShownPassword(password);
    setPassword("");
    setPasswordMode(false);
  }

  const role: Role = isRole(person.role) ? person.role : "viewer";

  return (
    <li className="grid gap-2 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className={cn("min-w-0 flex-1 basis-56 truncate", suspended && "text-muted-foreground line-through")}>
          {person.email}
          {person.isYou ? <span className="ml-1.5 text-xs text-muted-foreground no-underline">(you)</span> : null}
        </span>
        {suspended ? <ToneBadge tone="amber">Suspended</ToneBadge> : null}
        <span className="text-xs text-muted-foreground">
          {person.lastSignInAt ? (
            <>
              Signed in <RelativeTime iso={person.lastSignInAt} />
            </>
          ) : (
            "Never signed in"
          )}
        </span>
        <label className="sr-only" htmlFor={`role-${person.userId}`}>
          Role of {person.email}
        </label>
        <select
          id={`role-${person.userId}`}
          className="h-7 rounded-md border border-input bg-card px-1.5 text-sm"
          value={role}
          disabled={busy}
          onChange={(event) => void setMember(event.target.value as Role, suspended ? "suspended" : "active")}
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void setMember(role, suspended ? "active" : "suspended")}
        >
          {suspended ? "Reactivate" : "Suspend"}
        </Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void remove()}>
          Remove
        </Button>
        {person.canResetPassword && !passwordMode ? (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => setPasswordMode(true)}>
            Set password
          </Button>
        ) : null}
      </div>

      {passwordMode ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void savePassword();
          }}
        >
          <label htmlFor={`password-${person.userId}`} className="sr-only">
            New password for {person.email}
          </label>
          <Input
            id={`password-${person.userId}`}
            autoComplete="new-password"
            spellCheck={false}
            minLength={MIN_PASSWORD_LENGTH}
            placeholder={`New password, ${MIN_PASSWORD_LENGTH}+ characters`}
            className="min-w-0 flex-1 basis-56 font-mono"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <Button type="button" variant="outline" size="sm" onClick={() => setPassword(generatePassword())}>
            Generate
          </Button>
          <Button type="submit" size="sm" disabled={busy || password === ""}>
            {busy ? "Saving…" : "Set password"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => {
              setPassword("");
              setPasswordMode(false);
            }}
          >
            Cancel
          </Button>
        </form>
      ) : null}

      {shownPassword ? (
        <div role="status" className="flex flex-wrap items-center gap-2 rounded-md border border-success-border bg-success-surface px-2 py-1.5 text-success">
          <span>New password, shown only now:</span>
          <code className="rounded-sm border border-success-border bg-card px-1.5 py-0.5 font-mono text-foreground select-all">
            {shownPassword}
          </code>
          <span className="text-xs">Share it privately; the app sends no email.</span>
          <Button variant="outline" size="sm" className="ml-auto" onClick={() => setShownPassword(null)}>
            Done
          </Button>
        </div>
      ) : null}

      {message ? (
        <p role="alert" className={cn("text-xs", message.ok ? "text-success" : "text-danger")}>
          {message.text}
        </p>
      ) : null}
    </li>
  );
}
