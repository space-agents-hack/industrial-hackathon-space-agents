import { guard, supabaseChoices } from "@/lib/setup-commands";
import { readJson } from "@/lib/validation";

// The Supabase organisations and projects the pasted token reaches, so the form can offer them.
// The token goes from this browser to this machine and on to Supabase; nothing is kept.
export async function POST(request: Request) {
  const refused = guard(request);
  if (refused) return refused;
  const body = await readJson(request);
  const token = typeof body === "object" && body !== null ? (body as { token?: unknown }).token : undefined;
  if (typeof token !== "string" || !/^sbp_[\w-]{8,256}$/.test(token.trim())) {
    return Response.json({ ok: false, error: "A Supabase access token starts with sbp_." }, { status: 400 });
  }
  return Response.json(await supabaseChoices(token.trim()), { headers: { "cache-control": "no-store" } });
}
