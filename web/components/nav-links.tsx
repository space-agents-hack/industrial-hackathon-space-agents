"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/", label: "Runs", matches: (path: string) => path === "/" || path.startsWith("/runs/") },
  { href: "/setup", label: "Setup", matches: (path: string) => path.startsWith("/setup") },
];

// The header's sections, with the current one marked for sight (weight and a fill) and for screen
// readers (aria-current). Each link is 32px tall: the text alone was a 16px target.
export function NavLinks() {
  const pathname = usePathname();
  return <Links current={pathname} />;
}

// Rendered while the pathname is not known yet (a run page's id is only known at request time):
// the same links, none marked.
export function NavLinksFallback() {
  return <Links current={null} />;
}

function Links({ current }: { current: string | null }) {
  return (
    <nav className="flex items-center gap-1 text-sm">
      {LINKS.map((link) => {
        const active = current !== null && link.matches(current);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "inline-flex h-8 items-center rounded-md px-2 hover:bg-muted hover:text-foreground",
              active ? "bg-muted font-medium text-foreground" : "text-muted-foreground",
            )}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
