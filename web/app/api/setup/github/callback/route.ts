import { randomBytes } from "node:crypto";

import { cookies } from "next/headers";

import { appSettingsUrl, installUrl, parseCreatedApp } from "@/lib/github-app";
import {
  INSTALL_COOKIE,
  STATE_COOKIE,
  STATE_COOKIE_OPTIONS,
  backToSetup,
  returnGuard,
  sameState,
} from "@/lib/setup-github-guard";
import { repoInfo, storeGithubApp } from "@/lib/setup-commands";

// GitHub sends the browser here after the person pressed Create: `code` is exchanged for the new
// app's ID and key, which go straight into GitHub's production environment, and the browser goes
// on to the install page with this repository already chosen.
export async function GET(request: Request) {
  const refused = returnGuard(request);
  if (refused) return refused;

  const params = new URL(request.url).searchParams;
  const code = params.get("code") ?? "";
  const jar = await cookies();
  const expected = jar.get(STATE_COOKIE)?.value ?? "";
  jar.delete({ name: STATE_COOKIE, path: STATE_COOKIE_OPTIONS.path });
  // Only the browser that pressed Connect GitHub on this page may finish it.
  if (!sameState(params.get("state") ?? "", expected)) return backToSetup(request, { github: "error", reason: "state" });
  if (!/^[\w-]{1,100}$/.test(code)) return backToSetup(request, { github: "error", reason: "code" });

  // The code is the credential here; the endpoint takes no token (GitHub's manifest flow).
  const response = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  const app = response?.ok ? parseCreatedApp(await response.json().catch(() => null)) : null;
  if (!app) return backToSetup(request, { github: "error", reason: "exchange" });

  const repo = await repoInfo();
  if (!repo) return backToSetup(request, { github: "error", reason: "store", slug: app.slug, owner: app.owner });
  // A private app can only be installed by the account that owns it. Signed in to GitHub in this
  // browser as someone else than the repository's owner, the app lands in the wrong account.
  if (app.owner.toLowerCase() !== repo.ownerLogin.toLowerCase()) {
    return backToSetup(request, { github: "error", reason: "owner", slug: app.slug, owner: app.owner, expected: repo.ownerLogin });
  }
  const settings = appSettingsUrl(repo.ownerType, repo.ownerLogin, app.slug);
  if (!(await storeGithubApp(app, repo.fullName, settings))) {
    // The app exists on GitHub but its key is gone with this request: it has to be deleted there.
    return backToSetup(request, { github: "error", reason: "store", slug: app.slug, owner: app.owner, owner_type: repo.ownerType });
  }

  const installState = randomBytes(24).toString("hex");
  jar.set(INSTALL_COOKIE, installState, STATE_COOKIE_OPTIONS);
  return Response.redirect(installUrl(app.slug, repo.ownerId, repo.id, installState), 303);
}
