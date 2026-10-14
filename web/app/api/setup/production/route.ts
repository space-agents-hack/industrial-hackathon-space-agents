import { guard, productionStatus } from "@/lib/setup-commands";

// The production addresses, whether they answer, and the latest release, for the Setup page.
export async function GET(request: Request) {
  const refused = guard(request);
  if (refused) return refused;
  return Response.json(await productionStatus(), { headers: { "cache-control": "no-store" } });
}
