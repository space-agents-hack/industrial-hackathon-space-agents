"use client";

import { useTransition } from "react";

import { switchOrganization } from "@/lib/org-actions";

// Shown only when the person can see more than one organisation (the header decides). A plain
// <select>: keyboard, screen readers and phones already know how to use it.
export function OrgSwitcher({
  organizations,
  currentId,
}: {
  organizations: { id: string; name: string }[];
  currentId: string;
}) {
  const [pending, startTransition] = useTransition();
  return (
    <label className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <span className="sr-only sm:not-sr-only">Organisation</span>
      <select
        className="h-7 max-w-44 min-w-0 truncate rounded-md border border-input bg-card px-1.5 text-sm text-foreground disabled:opacity-60"
        value={currentId}
        disabled={pending}
        onChange={(event) => {
          const id = event.target.value;
          startTransition(() => switchOrganization(id));
        }}
      >
        {organizations.map((organization) => (
          <option key={organization.id} value={organization.id}>
            {organization.name}
          </option>
        ))}
      </select>
    </label>
  );
}
