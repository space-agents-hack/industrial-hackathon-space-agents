import { NextResponse } from "next/server";

import { rememberProject } from "@/lib/project-actions";

// The project picker's links come here: the project is stored before its page renders, so the
// header shows the project's sections on the first paint instead of after a refresh. A project
// the person cannot read sends them back to the list.
export async function GET(request: Request, { params }: RouteContext<"/projects/[id]/open">) {
  const { id } = await params;
  const target = (await rememberProject(id)) ? `/projects/${id}` : "/projects";
  return NextResponse.redirect(new URL(target, request.url), 303);
}
