import { forgetSaved, guard, readSaved } from "@/lib/setup-commands";

// What the form saved last time, to fill it in again. The values go back to the same browser
// that typed them, on the same machine; see lib/local-request.ts.
export async function GET(request: Request) {
  const refused = guard(request);
  if (refused) return refused;
  return Response.json(await readSaved(), { headers: { "cache-control": "no-store" } });
}

export async function DELETE(request: Request) {
  const refused = guard(request);
  if (refused) return refused;
  await forgetSaved();
  return Response.json({ saved: false });
}
