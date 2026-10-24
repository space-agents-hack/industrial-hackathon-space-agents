import { LogOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import { signOut } from "@/lib/auth-actions";

// In the sidebar's foot it is a symbol beside the email, where a word would push the email out.
export function SignOutButton({ iconOnly = false }: { iconOnly?: boolean }) {
  return (
    <form action={signOut}>
      {iconOnly ? (
        <Button type="submit" variant="ghost" size="icon-sm" aria-label="Sign out" title="Sign out">
          <LogOut aria-hidden />
        </Button>
      ) : (
        <Button type="submit" variant="outline" size="sm">
          Sign out
        </Button>
      )}
    </form>
  );
}
