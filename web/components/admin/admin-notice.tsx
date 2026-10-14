import Link from "next/link";

import { NoAccess } from "@/components/no-access";
import type { AdminRefusal } from "@/lib/admin-page";

// What an organisation tab shows instead of its content when it has nothing to work on.
export function AdminNotice({ reason }: { reason: AdminRefusal }) {
  if (reason === "failed" || reason === "no-access") return <NoAccess failed={reason === "failed"} />;
  if (reason === "no-organisation") {
    return (
      <p className="text-muted-foreground">
        There is no organisation yet.{" "}
        <Link href="/admin/organizations" className="text-primary underline-offset-4 hover:underline">
          Create one in Organisations
        </Link>
        .
      </p>
    );
  }
  return (
    <p className="max-w-prose text-muted-foreground">
      Only the admins of an organisation see its admin area. Switch to an organisation you manage,
      or ask one of this one&apos;s admins.
    </p>
  );
}
