"use client";

import { ChevronsUpDown } from "lucide-react";
import { useTransition } from "react";

import { switchOrganization } from "@/lib/org-actions";

// A native <select> drawn as a pop-up button: the chevrons, not the border, say it opens a list,
// so the edge can stay as light as the card's. Shared with the project switcher.
export const SWITCHER_SELECT =
  "h-9 w-full min-w-0 appearance-none truncate rounded-md border bg-card pr-7 pl-2.5 text-sm font-medium text-foreground shadow-xs outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 md:h-8";

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
    <label className="relative flex min-w-0 items-center">
      <span className="sr-only">Organisation</span>
      <select
        className={SWITCHER_SELECT}
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
      <ChevronsUpDown aria-hidden className="pointer-events-none absolute right-2 size-3.5 text-muted-foreground" />
    </label>
  );
}
