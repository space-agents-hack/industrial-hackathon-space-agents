"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/", label: "Runs", matches: (path: string) => path === "/" || path.startsWith("/runs/") },
  { href: "/checks", label: "Checks", matches: (path: string) => path.startsWith("/checks") },
  { href: "/setup", label: "Setup", matches: (path: string) => path.startsWith("/setup") },
];

// Only for admins of the current organisation and platform admins (decided on the server, in
// the header). Hiding it is courtesy; the admin pages and routes check the role themselves.
const ADMIN_LINK = { href: "/admin", label: "Admin", matches: (path: string) => path.startsWith("/admin") };

// The header's sections, with the current one marked for sight (weight and a fill) and for screen
// readers (aria-current). Each link is 32px tall: the text alone was a 16px target.
export function NavLinks({ showAdmin }: { showAdmin: boolean }) {
  const pathname = usePathname();
  return <Links current={pathname} showAdmin={showAdmin} />;
}

// Rendered while the pathname is not known yet (a run page's id is only known at request time):
// the same links, none marked.
export function NavLinksFallback() {
  return <Links current={null} showAdmin={false} />;
}

function Links({ current, showAdmin }: { current: string | null; showAdmin: boolean }) {
  return (
    <nav className="flex items-center gap-1 text-sm">
      {(showAdmin ? [...LINKS, ADMIN_LINK] : LINKS).map((link) => {
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
