import { AppHeader } from "@/components/app-header";

// Everything in this group needs a session. proxy.ts enforces that; this layout only adds the
// header that the login page does not have.
//
// Who belongs to no organisation is decided by each page inside its own Suspense boundary
// (components/no-access.tsx), not here: a layout that waits for the request before rendering
// {children} drops every page out of the static shell, and Next.js flags it in development.
export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      <AppHeader />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-5">{children}</main>
    </>
  );
}
