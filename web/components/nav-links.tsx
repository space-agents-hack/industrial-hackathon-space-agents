"use client";

import {
  ClipboardCheck,
  FileDiff,
  FilePen,
  Package,
  type LucideIcon,
  Scale,
  Settings,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { SETTINGS_TAB, type Tab, projectTabs } from "@/lib/navigation";
import { cn } from "@/lib/utils";

// One symbol per section, in one stroke weight, so the eye finds a section before reading it (HIG,
// Sidebars: "familiar symbols"). Keyed by label because lib/navigation.ts stays free of React.
const ICONS: Record<string, LucideIcon> = {
  Parts: Package,
  "Draft requirements": FilePen,
  Regulations: Scale,
  "Review requirements": FileDiff,
  Checks: ClipboardCheck,
  Settings,
};

// The project's sections (SYS-36). They exist only once a project is picked; without one the
// sidebar says so and the page is the project picker. Rows are 32px on a laptop and 40px in the
// phone drawer, where a finger replaces the pointer.
export function ProjectNav({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Project sections">
      <ul className="grid gap-0.5">
        {projectTabs(projectId).map((tab) => (
          <li key={tab.href}>
            <TabLink tab={tab} current={pathname} />
          </li>
        ))}
      </ul>
    </nav>
  );
}

// Settings (Setup and Admin joined, SYS-37): only for admins of the current organisation and
// platform admins, decided on the server. Hiding it is courtesy; the pages and routes check the
// role themselves.
export function SettingsLink() {
  const pathname = usePathname();
  return <TabLink tab={SETTINGS_TAB} current={pathname} />;
}

function TabLink({ tab, current }: { tab: Tab; current: string | null }) {
  const active = current !== null && tab.matches(current);
  const Icon = ICONS[tab.label];
  return (
    <Link
      href={tab.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-10 items-center gap-2.5 rounded-md px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring md:h-8",
        active ? "bg-secondary font-medium text-foreground" : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
      )}
    >
      {Icon ? <Icon aria-hidden className={cn("size-4 shrink-0", active ? "text-tint" : "")} strokeWidth={1.75} /> : null}
      {tab.label}
    </Link>
  );
}
