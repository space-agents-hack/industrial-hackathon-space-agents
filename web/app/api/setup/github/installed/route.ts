import { cookies } from "next/headers";

import { INSTALL_COOKIE, STATE_COOKIE_OPTIONS, backToSetup, returnGuard, sameState } from "@/lib/setup-github-guard";
import { finishInstallation, guard } from "@/lib/setup-commands";
import { readJson } from "@/lib/validation";

// GitHub sends the browser here after the person pressed Install (the app's setup URL). If the
// `state` it hands back is the one this browser was given, the installation is recorded (it ticks
// the step) and, on a deployment that already exists, a release gives the web the app's key.
// Anything else (GitHub not passing `state` on, an update, a page in another tab sending the
// browser here) changes nothing: the Setup page asks for one click to finish instead.
export async function GET(request: Request) {
  const refused = returnGuard(request);
  if (refused) return refused;

  const params = new URL(request.url).searchParams;
  // In an organisation, a member without the right to install only sends a request to an owner.
  if (params.get("setup_action") === "request") return backToSetup(request, { github: "requested" });
  const id = params.get("installation_id") ?? "";
  if (!/^\d{1,20}$/.test(id)) return backToSetup(request, { github: "error", reason: "install" });

  const jar = await cookies();
  const expected = jar.get(INSTALL_COOKIE)?.value ?? "";
  if (!sameState(params.get("state") ?? "", expected)) return backToSetup(request, { github: "returned", installation_id: id });
  jar.delete({ name: INSTALL_COOKIE, path: STATE_COOKIE_OPTIONS.path });

  const result = await finishInstallation(Number(id));
  // Keep the id: the Setup page's one-click finish can try again once gh works.
  if (!result.ok) return backToSetup(request, { github: "returned", installation_id: id });
  return backToSetup(request, { github: "installed", release: result.release });
}

// The one-click finish on the Setup page: a same-origin JSON POST from this machine (guard()).
export async function POST(request: Request) {
  const refused = guard(request);
  if (refused) return refused;
  const body = await readJson(request);
  const id = typeof body === "object" && body !== null ? Number((body as { installation_id?: unknown }).installation_id) : NaN;
  if (!Number.isSafeInteger(id) || id <= 0) return Response.json({ error: "That is not an installation id." }, { status: 400 });
  const result = await finishInstallation(id);
  if (!result.ok) return Response.json({ error: "The installation could not be recorded. Is gh signed in?" }, { status: 502 });
  return Response.json(result);
}
