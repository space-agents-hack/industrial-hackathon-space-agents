import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { ControlTokenSteps } from "@/components/admin/control-token-steps";
import { DeploymentForm } from "@/components/admin/deployment-form";
import { NoAccess } from "@/components/no-access";
import { RelativeTime } from "@/components/relative-time";
import { getCurrentOrg } from "@/lib/current-org";
import { EDITABLE_SECRETS, RELEASE_SECRETS } from "@/lib/deployment";
import { deploymentState } from "@/lib/github";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Deployment" };

export default function DeploymentPage() {
  return (
    <Suspense fallback={<p className="text-muted-foreground">Loading the deployment…</p>}>
      <Deployment />
    </Suspense>
  );
}

const LABELS = new Map<string, string>([
  ...EDITABLE_SECRETS.map(({ name, label }) => [name, label] as [string, string]),
  ["AGENT_SHARED_SECRET", "Secret between web and agent"],
  ["VERCEL_ORG_ID", "Vercel team (set at setup)"],
  ["VERCEL_WEB_PROJECT_ID", "Vercel web project (set at setup)"],
  ["VERCEL_AGENT_PROJECT_ID", "Vercel agent project (set at setup)"],
  ["SUPABASE_PROJECT_REF", "Supabase project (set at setup)"],
  ["ADMIN_PASSWORD", "First admin's password (deleted after use)"],
]);

async function Deployment() {
  const { access, failed } = await getCurrentOrg();
  if (failed) return <NoAccess failed />;
  if (!access.platformAdmin) {
    return <p className="text-muted-foreground">Only a platform admin changes the deployment.</p>;
  }

  const state = await deploymentState();
  if (!state.ok) {
    return state.reason === "not-configured" ? (
      <ControlTokenSteps />
    ) : (
      <p role="alert" className="text-danger">
        GitHub refused to show the deployment&apos;s values. {state.detail}
      </p>
    );
  }

  const stored = new Map(state.secrets.map((s) => [s.name, s.updatedAt]));
  const missing = RELEASE_SECRETS.filter((name) => !stored.has(name));
  const supabase = await createClient();
  const { data: changes } = await supabase
    .from("audit_events")
    .select("id, created_at, action, detail")
    .is("organization_id", null)
    .order("id", { ascending: false })
    .limit(8);

  return (
    <div className="grid gap-5">
      <p className="max-w-prose text-muted-foreground">
        The credentials of this deployment live in GitHub
        {state.repo ? ` (${state.repo})` : ""}, in the production environment, where only the
        workflows can read them. Change one here, then apply: a release copies the values to
        Vercel and deploys with them. See{" "}
        <Link href="/admin/releases" className="text-primary underline underline-offset-2">
          Releases
        </Link>{" "}
        for the release itself.
      </p>

      <section className="grid gap-2">
        <h2 className="font-medium">What GitHub holds</h2>
        {missing.length ? (
          <p className="text-danger">Missing, and releases need it: {missing.join(", ")}.</p>
        ) : null}
        <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[16rem_1fr]">
          {[...stored.entries()].map(([name, updatedAt]) => (
            <div key={name} className="contents">
              <dt>
                {LABELS.get(name) ?? name}{" "}
                <code className="font-mono text-xs text-muted-foreground">{name}</code>
              </dt>
              <dd className="text-muted-foreground">
                changed {updatedAt ? <RelativeTime iso={updatedAt} /> : "at an unknown time"}
              </dd>
            </div>
          ))}
          <dt>
            Default model <code className="font-mono text-xs text-muted-foreground">AGENT_MODEL</code>
          </dt>
          <dd className="font-mono text-xs">{state.model ?? "scripted (not set)"}</dd>
        </dl>
      </section>

      <section className="grid gap-2">
        <h2 className="font-medium">Change</h2>
        {state.writable ? (
          <DeploymentForm currentModel={state.model ?? "scripted"} />
        ) : (
          <p className="text-muted-foreground">
            Reading with your <code className="font-mono">gh</code> sign-in. Changes are made in the
            deployed app, which has the control token.
          </p>
        )}
      </section>

      <section className="grid gap-2">
        <h2 className="font-medium">Recent changes</h2>
        {changes?.length ? (
          <ul className="divide-y rounded-md border bg-card text-sm">
            {changes.map((event) => (
              <li key={event.id} className="flex flex-wrap gap-x-3 px-3 py-1.5">
                <RelativeTime iso={event.created_at} className="text-muted-foreground" />
                <span>{describeChange(event.action, event.detail)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">None from this page yet.</p>
        )}
      </section>
    </div>
  );
}

function describeChange(action: string, detail: unknown): string {
  const names =
    typeof detail === "object" && detail !== null && Array.isArray((detail as { names?: unknown }).names)
      ? ((detail as { names: unknown[] }).names.map(String))
      : [];
  const list = names.map((name) => LABELS.get(name) ?? name).join(", ");
  switch (action) {
    case "deployment.values_saved":
      return `Saved ${list || "values"} in GitHub`;
    case "deployment.reconfigure_started":
      return "Applied the settings and started a release";
    case "deployment.release_started":
      return "Started a release";
    default:
      return action;
  }
}
