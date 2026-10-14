import { cliStatus, guard } from "@/lib/setup-commands";

// Which of the three CLIs are signed in, and which GitHub repository this checkout belongs to.
export async function GET(request: Request) {
  const refused = guard(request);
  if (refused) return refused;
  return Response.json(await cliStatus());
}
