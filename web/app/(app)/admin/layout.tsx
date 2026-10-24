import { Suspense } from "react";

import { AdminTabs } from "@/components/admin/admin-tabs";
import { showsAdmin } from "@/lib/access";
import { getCurrentOrg } from "@/lib/current-org";

// Settings (SYS-37): the current organisation's, plus the deployment's for platform admins. Every
// tab is server-rendered from the database as the signed-in person and checks the role itself
// (lib/admin-page.ts); the forms post to /api/admin/*, which check it again on each request. {children} is not wrapped in a role check
// here: a layout that waits for the request before rendering its children drops every page out
// of the static shell.
export default function AdminLayout({ children }: LayoutProps<"/admin">) {
  return (
    <div className="grid gap-4">
      <Suspense fallback={<h1 className="h-14 text-base font-semibold">Settings</h1>}>
        <Header />
      </Suspense>
      {children}
    </div>
  );
}

async function Header() {
  const { access, current } = await getCurrentOrg();
  if (!showsAdmin(access, current)) return <h1 className="text-base font-semibold">Settings</h1>;
  return (
    <div className="grid gap-2">
      <h1 className="text-base font-semibold">
        Settings{current ? <span className="font-normal text-muted-foreground"> · {current.name}</span> : null}
      </h1>
      <AdminTabs platformAdmin={access.platformAdmin} />
    </div>
  );
}
