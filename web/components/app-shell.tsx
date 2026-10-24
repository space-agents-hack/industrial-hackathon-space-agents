"use client";

import { Menu, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, Suspense, useEffect, useRef, useState } from "react";

import { APP_NAME } from "@/lib/config";
import { cn } from "@/lib/utils";

// The frame of every signed-in page: the sidebar on the leading side, the page beside it (HIG,
// Sidebars). From `md` the sidebar is a fixed column; below it, it is a drawer that a menu button in
// a thin top bar opens, because a 16rem column leaves a phone about 130px of page.
//
// The sidebar's content is rendered on the server and passed in, so this component only owns the
// drawer: open and closed, focus, Escape, and the page made inert behind it. One sidebar element
// serves both widths; rendering it twice would read the organisation and its projects twice.
export function AppShell({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const drawer = useRef<HTMLElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const opener = button.current;
    drawer.current?.querySelector<HTMLElement>("a[href], button, select")?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Growing past `md` turns the drawer into the fixed column; nothing is left to close.
    const wide = window.matchMedia("(min-width: 768px)");
    const onWide = () => wide.matches && setOpen(false);
    wide.addEventListener("change", onWide);
    return () => {
      document.body.style.overflow = previous;
      wide.removeEventListener("change", onWide);
      opener?.focus();
    };
  }, [open]);

  return (
    <div className="flex min-h-dvh">
      {/* The path is request data: read outside a Suspense boundary it would take every page out
          of the static shell (Next.js refuses it in development). */}
      <Suspense fallback={null}>
        <CloseOnNavigate close={() => setOpen(false)} />
      </Suspense>
      {open ? <div aria-hidden className="fixed inset-0 z-40 bg-black/30 md:hidden" onClick={() => setOpen(false)} /> : null}
      <aside
        ref={drawer}
        id="app-sidebar"
        aria-label="Navigation"
        onKeyDown={(event) => {
          if (open && event.key === "Escape") setOpen(false);
        }}
        className={cn(
          "fixed inset-y-0 left-0 z-50 w-64 max-w-[85vw] shrink-0 border-r bg-sidebar transition-transform duration-200 md:static md:z-auto md:translate-x-0 md:transition-none",
          open ? "translate-x-0 shadow-xl" : "-translate-x-full max-md:invisible",
        )}
      >
        <button
          type="button"
          aria-label="Close the menu"
          onClick={() => setOpen(false)}
          className="absolute top-3 right-2 flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground md:hidden"
        >
          <X className="size-5" aria-hidden />
        </button>
        {/* The column stretches with the page, so its background runs to the bottom; its content
            stays in view while the page scrolls. */}
        <div className="flex h-dvh flex-col md:sticky md:top-0">{sidebar}</div>
      </aside>
      {/* Behind an open drawer the page cannot be tabbed into or read out. */}
      <div className="flex min-w-0 flex-1 flex-col" inert={open}>
        <div className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b bg-background/85 px-2 backdrop-blur md:hidden">
          <button
            ref={button}
            type="button"
            aria-label="Open the menu"
            aria-expanded={open}
            aria-controls="app-sidebar"
            onClick={() => setOpen(true)}
            className="flex size-10 items-center justify-center rounded-md hover:bg-muted"
          >
            <Menu className="size-5" aria-hidden />
          </button>
          <Link href="/" className="font-display text-xl leading-none">
            {APP_NAME}
          </Link>
        </div>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 pt-6 pb-24 sm:px-8 md:pt-10">{children}</main>
      </div>
    </div>
  );
}

// Following a link closes the drawer: the page it opens is what the person wanted to see.
function CloseOnNavigate({ close }: { close: () => void }) {
  const pathname = usePathname();
  const latest = useRef(close);
  useEffect(() => {
    latest.current = close;
  });
  useEffect(() => {
    latest.current();
  }, [pathname]);
  return null;
}
