// Who may use the setup endpoints, decided from plain values so it can be tested.
//
// Those endpoints run commands with the developer's signed-in GitHub, Vercel and Supabase CLIs.
// Three things keep them to the developer's own browser on the developer's own machine:
//   - they exist only under `next dev`, never in a build or on Vercel;
//   - only when the dev server was started listening on 127.0.0.1 alone, which the `dev` script in
//     package.json does and marks with SETUP_LOOPBACK_ONLY=1. A server started any other way may
//     be reachable from the network, where a Host header proves nothing;
//   - the Host header must name the loopback address, which stops DNS rebinding;
//   - a browser request must not come from another site (Sec-Fetch-Site), so a page open in
//     another tab cannot even trigger a read, and a request that changes something must also
//     come from the same origin, as JSON.

export type RequestFacts = {
  onVercel: boolean;
  nodeEnv: string | undefined;
  loopbackOnly: boolean;
  method: string;
  host: string | null;
  origin: string | null;
  contentType: string | null;
  // Sent by every current browser; absent from curl and scripts, which the Host check covers.
  fetchSite: string | null;
};

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1)(:\d{1,5})?$/;
const LOOPBACK_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

export function setupCommandsAvailable(
  onVercel: boolean,
  nodeEnv: string | undefined,
  loopbackOnly: boolean,
): boolean {
  return !onVercel && nodeEnv === "development" && loopbackOnly;
}

// null when allowed; otherwise the status to answer with.
export function refuseUnlessLocal(facts: RequestFacts): 403 | 404 | 415 | null {
  if (!setupCommandsAvailable(facts.onVercel, facts.nodeEnv, facts.loopbackOnly)) return 404;
  if (!facts.host || !LOOPBACK_HOST.test(facts.host)) return 403;
  if (facts.fetchSite && facts.fetchSite !== "same-origin" && facts.fetchSite !== "none") return 403;
  if (facts.method === "GET" || facts.method === "HEAD") return null;
  if (!facts.origin || !LOOPBACK_ORIGIN.test(facts.origin)) return 403;
  if (!facts.contentType?.toLowerCase().startsWith("application/json")) return 415;
  return null;
}
