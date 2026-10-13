// The two `process.env` reads are written out in full because Next.js inlines NEXT_PUBLIC_
// variables into the browser bundle by matching these exact expressions.
export function supabaseEnv(): { url: string; publishableKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !publishableKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be set (see web/.env.example).",
    );
  }
  return { url, publishableKey };
}
