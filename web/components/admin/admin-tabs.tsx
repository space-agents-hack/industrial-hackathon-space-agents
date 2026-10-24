"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { settingsTabs } from "@/lib/navigation";
import { cn } from "@/lib/utils";

export function AdminTabs({ platformAdmin }: { platformAdmin: boolean }) {
  const pathname = usePathname();
  const tabs = settingsTabs(platformAdmin);
  return (
    <nav aria-label="Admin sections" className="flex flex-wrap gap-1 border-b pb-2 text-sm">
      {tabs.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "inline-flex h-7 items-center rounded-md px-2 hover:bg-muted hover:text-foreground",
              active ? "bg-muted font-medium text-foreground" : "text-muted-foreground",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
