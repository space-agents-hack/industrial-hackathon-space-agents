import { AppHeader } from "@/components/app-header";

// Everything in this group needs a session. proxy.ts enforces that; this layout only adds the
// header that the login page does not have.
export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      <AppHeader />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-5">{children}</main>
    </>
  );
}
