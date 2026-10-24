import type { ReactNode } from "react";

// The top of every page: where it sits (a breadcrumb), its title in the display serif, one line on
// what the page is for, and the page's own actions on the trailing side, where the eye ends the
// title. One component so every page reads the same way.
export function PageHeader({
  breadcrumb,
  title,
  description,
  actions,
}: {
  breadcrumb?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="grid gap-2">
      {breadcrumb}
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <h1 className="page-title min-w-0">{title}</h1>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {description ? <p className="max-w-2xl text-[0.9375rem] text-muted-foreground">{description}</p> : null}
    </header>
  );
}
