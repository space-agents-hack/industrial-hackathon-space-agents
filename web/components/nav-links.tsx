"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { SETTINGS_TAB, type Tab, projectTabs } from "@/lib/navigation";
import { cn } from "@/lib/utils";

// The project's sections, in the header's second row (SYS-36). They exist only once a project is
// picked; without one the header has no second row, and the page is the project picker. Each link
// is 32px tall: the text alone was a 16px target.
export function ProjectNav({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Project sections" className="flex items-center gap-1 overflow-x-auto text-sm">
      {projectTabs(projectId).map((tab) => (
        <TabLink key={tab.href} tab={tab} current={pathname} />
      ))}
    </nav>
  );
}

// Settings (Setup and Admin joined, SYS-37): only for admins of the current organisation and
// platform admins, decided on the server in the header. Hiding it is courtesy; the pages and
// routes check the role themselves.
export function SettingsLink() {
  const pathname = usePathname();
  return <TabLink tab={SETTINGS_TAB} current={pathname} />;
}

function TabLink({ tab, current }: { tab: Tab; current: string | null }) {
  const active = current !== null && tab.matches(current);
  return (
    <Link
      href={tab.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "inline-flex h-8 shrink-0 items-center rounded-md px-2 text-sm hover:bg-muted hover:text-foreground",
        active ? "bg-muted font-medium text-foreground" : "text-muted-foreground",
      )}
    >
      {tab.label}
    </Link>
  );
}
