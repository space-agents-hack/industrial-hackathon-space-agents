import { Suspense } from "react";

import { AppHeader } from "@/components/app-header";
import { Assistant } from "@/components/assistant";
import { getCurrentProject } from "@/lib/current-project";

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
      <Suspense fallback={null}>
        <ProjectAssistant />
      </Suspense>
    </>
  );
}

// The assistant's bubble, on every page once the person is inside a project (SYS-39, #31). Keyed
// by project: switching project starts that project's own conversation.
async function ProjectAssistant() {
  const project = await getCurrentProject();
  if (!project) return null;
  return <Assistant key={project.id} projectId={project.id} projectName={project.name} />;
}
