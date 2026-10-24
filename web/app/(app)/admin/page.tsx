import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminNotice } from "@/components/admin/admin-notice";
import { OrganizationNameForm } from "@/components/admin/organization-name-form";
import { type ProcessId, ProcessModelsForm } from "@/components/admin/process-models-form";
import { SettingsForm } from "@/components/admin/settings-form";
import { isProviderId } from "@/lib/admin";
import { adminPage } from "@/lib/admin-page";
import { agentHealth } from "@/lib/agent-admin";

export const metadata: Metadata = { title: "Models and limits" };

export default function ModelsPage() {
  return (
    <Suspense fallback={<p className="text-muted-foreground">Loading settings…</p>}>
      <Settings />
    </Suspense>
  );
}

async function Settings() {
  const page = await adminPage();
  if (!page.ok) return <AdminNotice reason={page.reason} />;
  const { supabase, org } = page;

  const [settings, connections, health, models] = await Promise.all([
    supabase
      .from("organization_settings")
      .select("model, max_model_requests, monthly_cost_cap_usd")
      .eq("organization_id", org.id)
      .maybeSingle(),
    supabase.from("provider_connections").select("provider").eq("organization_id", org.id),
    agentHealth(),
    supabase.from("organization_models").select("process, model").eq("organization_id", org.id),
  ]);
  if (settings.error || connections.error || models.error) {
    console.error("Admin, models: read failed", settings.error ?? connections.error ?? models.error);
    return (
      <p role="alert" className="text-danger">
        The settings could not be loaded. Check that the database is reachable and reload.
      </p>
    );
  }

  return (
    <div className="grid gap-3">
      <p className="max-w-prose text-muted-foreground">
        What new runs of {org.name} use. Only what you change is stored; an empty field follows the
        deployment&apos;s default, so a new default reaches every organisation that did not choose.
      </p>
      <OrganizationNameForm key={`name-${org.id}`} org={org.id} name={org.name} />
      <SettingsForm
        key={org.id}
        org={org.id}
        stored={{
          model: settings.data?.model ?? null,
          maxModelRequests: settings.data?.max_model_requests ?? null,
          monthlyCostCapUsd: settings.data?.monthly_cost_cap_usd ?? null,
        }}
        defaultModel={health?.model ?? null}
        connected={connections.data.map((c) => c.provider).filter(isProviderId)}
      />
      <section className="grid gap-2" aria-labelledby="process-models-heading">
        <h2 id="process-models-heading" className="text-lg font-semibold tracking-tight">
          Other agents and processes
        </h2>
        <p className="max-w-prose text-muted-foreground">
          The model above writes the requirements. Each process below can use its own; an empty field follows
          the deployment&apos;s default. A member can also pick another writer model for a single run, on the
          part page.
        </p>
        <ProcessModelsForm
          key={org.id}
          org={org.id}
          stored={Object.fromEntries(models.data.map((m) => [m.process, m.model])) as Partial<Record<ProcessId, string>>}
          defaults={health?.processes ?? {}}
          connected={connections.data.map((c) => c.provider)}
        />
      </section>
    </div>
  );
}
