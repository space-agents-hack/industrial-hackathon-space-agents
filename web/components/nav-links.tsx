"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

// The product first, in the order of the hierarchy (projects hold cases, runs read cases, runs
// cite regulations), then the tools that act on a file or a library.
const LINKS = [
  { href: "/projects", label: "Projects", matches: (path: string) => path.startsWith("/projects") },
  { href: "/", label: "Runs", matches: (path: string) => path === "/" || path.startsWith("/runs/") },
  { href: "/regulations", label: "Regulations", matches: (path: string) => path.startsWith("/regulations") },
  { href: "/changes", label: "Changes", matches: (path: string) => path.startsWith("/changes") },
  { href: "/checks", label: "Checks", matches: (path: string) => path.startsWith("/checks") },
];

// Deployment steps (GitHub, Vercel, Supabase): for whoever runs the deployment, not for an engineer
// of a client organisation. The page itself works without sign-in on a developer's machine.
const SETUP_LINK = { href: "/setup", label: "Setup", matches: (path: string) => path.startsWith("/setup") };

// Only for admins of the current organisation and platform admins (decided on the server, in
// the header). Hiding it is courtesy; the admin pages and routes check the role themselves.
const ADMIN_LINK = { href: "/admin", label: "Admin", matches: (path: string) => path.startsWith("/admin") };

// The header's sections, with the current one marked for sight (weight and a fill) and for screen
// readers (aria-current). Each link is 32px tall: the text alone was a 16px target.
export function NavLinks({ showAdmin, showSetup }: { showAdmin: boolean; showSetup: boolean }) {
  const pathname = usePathname();
  return <Links current={pathname} showAdmin={showAdmin} showSetup={showSetup} />;
}

// Rendered while the pathname is not known yet (a run page's id is only known at request time):
// the same links, none marked.
export function NavLinksFallback() {
  return <Links current={null} showAdmin={false} showSetup={false} />;
}

function Links({ current, showAdmin, showSetup }: { current: string | null; showAdmin: boolean; showSetup: boolean }) {
  const links = [...LINKS, ...(showSetup ? [SETUP_LINK] : []), ...(showAdmin ? [ADMIN_LINK] : [])];
  return (
    <nav className="flex items-center gap-1 overflow-x-auto text-sm">
      {links.map((link) => {
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
