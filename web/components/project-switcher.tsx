"use client";

import { ChevronsUpDown } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { SWITCHER_SELECT } from "@/components/org-switcher";
import { rememberProject } from "@/lib/project-actions";

// The project in the sidebar (SYS-36): its name, and a plain <select> to move to another project of
// the same organisation. The choice is stored before the project's page is opened, so the sidebar's
// sections are the new project's. "All projects" is the picker, where a new one is created.
export function ProjectSwitcher({
  projects,
  currentId,
}: {
  projects: { id: string; name: string }[];
  currentId: string | null;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  if (currentId === null) {
    return (
      <Link href="/projects" className="truncate text-sm font-medium text-tint underline-offset-4 hover:underline">
        Choose a project
      </Link>
    );
  }
  return (
    <label className="relative flex min-w-0 items-center">
      <span className="sr-only">Project</span>
      <select
        className={SWITCHER_SELECT}
        value={currentId}
        disabled={pending}
        onChange={(event) => {
          const id = event.target.value;
          if (id === "") {
            router.push("/projects");
            return;
          }
          setPending(true);
          void rememberProject(id).then((stored) => {
            setPending(false);
            router.push(stored ? `/projects/${id}` : "/projects");
          });
        }}
      >
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
        <option value="">All projects…</option>
      </select>
      <ChevronsUpDown aria-hidden className="pointer-events-none absolute right-2 size-3.5 text-muted-foreground" />
    </label>
  );
}
