import "server-only";

import { timingSafeEqual } from "node:crypto";

import { type RequestFacts, refuseUnlessLocalReturn } from "@/lib/local-request";

// The guard for the two addresses GitHub sends the browser back to (lib/local-request.ts).
export function returnGuard(request: Request): Response | null {
  const facts: RequestFacts = {
    onVercel: Boolean(process.env.VERCEL),
    nodeEnv: process.env.NODE_ENV,
    loopbackOnly: process.env.SETUP_LOOPBACK_ONLY === "1",
    method: request.method,
    host: request.headers.get("host"),
    origin: request.headers.get("origin"),
    contentType: request.headers.get("content-type"),
    fetchSite: request.headers.get("sec-fetch-site"),
  };
  const status = refuseUnlessLocalReturn(facts);
  return status === null ? null : new Response(null, { status });
}

// Where the Setup page shows how connecting GitHub went. Built from the Host the browser used
// (returnGuard has checked it is loopback): the dev server reports request.url as localhost even
// when the browser is on 127.0.0.1, and switching between the two loses the cookies set here.
export function backToSetup(request: Request, params: Record<string, string>): Response {
  const url = new URL("/setup", `http://${request.headers.get("host") ?? "127.0.0.1:3000"}`);
  url.searchParams.set("env", "production");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return Response.redirect(url, 303);
}

export const STATE_COOKIE = "setup_github_state";
export const INSTALL_COOKIE = "setup_github_install";

// One value per step, in an httpOnly cookie scoped to these routes; GitHub hands it back in the
// URL. A page in another tab can send the browser here but cannot know the value.
export const STATE_COOKIE_OPTIONS = { httpOnly: true, sameSite: "lax", path: "/api/setup/github", maxAge: 60 * 60 } as const;

export function sameState(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  // Lengths in bytes, not characters: timingSafeEqual throws on buffers of different length.
  return b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}
