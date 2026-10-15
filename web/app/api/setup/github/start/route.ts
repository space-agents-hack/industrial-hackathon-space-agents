import { randomBytes } from "node:crypto";

import { cookies } from "next/headers";

import { appManifest, appName, manifestAction } from "@/lib/github-app";
import { STATE_COOKIE, STATE_COOKIE_OPTIONS } from "@/lib/setup-github-guard";
import { guard, repoInfo } from "@/lib/setup-commands";

// "Connect GitHub" on the Setup page: the manifest of a new GitHub App for this repository and
// where to post it. The page posts it from the browser (GitHub's manifest flow needs the person to
// press Create there); `state` ties GitHub's answer to this browser.
export async function POST(request: Request) {
  const refused = guard(request);
  if (refused) return refused;

  const repo = await repoInfo();
  if (!repo) return Response.json({ error: "gh could not read this repository. Run gh auth login." }, { status: 409 });

  // The browser's own address, which guard() has already checked is this machine.
  const origin = request.headers.get("origin") ?? new URL(request.url).origin;
  const state = randomBytes(24).toString("hex");
  (await cookies()).set(STATE_COOKIE, state, STATE_COOKIE_OPTIONS);
  const manifest = appManifest(repo.fullName, origin, appName(repo.name, randomBytes(3).toString("hex")));
  return Response.json({ action: manifestAction(repo.ownerType, repo.ownerLogin, state), manifest: JSON.stringify(manifest) });
}
