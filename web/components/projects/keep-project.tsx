"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { rememberProject } from "@/lib/project-actions";

// On a project's own pages, reached by a link rather than the picker: make it the current project
// so the header's sections are this project's, not the one picked before.
export function KeepProject({ projectId, currentId }: { projectId: string; currentId: string | null }) {
  const router = useRouter();
  useEffect(() => {
    if (projectId === currentId) return;
    void rememberProject(projectId).then((stored) => stored && router.refresh());
  }, [projectId, currentId, router]);
  return null;
}
