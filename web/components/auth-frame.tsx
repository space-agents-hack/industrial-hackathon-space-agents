import type { ReactNode } from "react";

import { APP_NAME } from "@/lib/config";

// Sign-in and sign-up: the product's name in the display serif and one sentence on what it does,
// then the form. The only screen a juror or a new client sees before an organisation exists, so
// it says what the product is instead of only asking for a password.
export function AuthFrame({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <main className="flex flex-1 items-center justify-center bg-background px-4 py-12">
      <div className="grid w-full max-w-sm gap-7">
        <div className="grid gap-3 text-center">
          <p className="font-display text-5xl leading-none">{APP_NAME}</p>
          <p className="text-[0.9375rem] text-balance text-muted-foreground">
            From a product&apos;s specification and drawings to the regulatory requirements its engineers must meet,
            each one linked to the paragraph it comes from.
          </p>
        </div>
        <div className="rounded-2xl border bg-card p-6 shadow-sm">
          <h1 className="mb-4 text-lg font-semibold tracking-tight">{title}</h1>
          {children}
        </div>
        {footer ? <div className="grid gap-3 text-center text-sm text-muted-foreground">{footer}</div> : null}
      </div>
    </main>
  );
}
