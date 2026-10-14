import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminNotice } from "@/components/admin/admin-notice";
import { type Connection, ProvidersList } from "@/components/admin/providers-list";
import { isProviderId, shortId } from "@/lib/admin";
import { adminPage, peopleById } from "@/lib/admin-page";
import { openRouterResultMessage } from "@/lib/openrouter-oauth";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Providers" };

export default function ProvidersPage(props: PageProps<"/admin/providers">) {
  return (
    <div className="grid gap-3">
      <Suspense fallback={<p className="text-muted-foreground">Loading providers…</p>}>
        <Providers searchParams={props.searchParams} />
      </Suspense>
      <div className="grid max-w-prose gap-1.5 text-xs text-muted-foreground">
        <p>
          A key belongs to the organisation, not to a person. It is stored encrypted in Supabase
          Vault; this page and the browser only ever see its last four characters. The agent reads
          it when a run starts.
        </p>
        <p>
          Why there is no &quot;sign in with Claude&quot; or &quot;sign in with ChatGPT&quot;:
          Anthropic does not allow third-party apps to use Claude.ai plan logins, and OpenAI&apos;s
          ChatGPT sign-in for hosted apps is open to partners only. Connecting OpenRouter is the
          one-click alternative: its key reaches Claude and GPT models, and what they cost is billed
          to the OpenRouter account that approved the connection.
        </p>
      </div>
    </div>
  );
}

async function Providers({ searchParams }: { searchParams: PageProps<"/admin/providers">["searchParams"] }) {
  const page = await adminPage();
  if (!page.ok) return <AdminNotice reason={page.reason} />;
  const { supabase, org } = page;

  const [params, connections, people] = await Promise.all([
    searchParams,
    supabase
      .from("provider_connections")
      .select("provider, last4, source, created_at, created_by")
      .eq("organization_id", org.id),
    peopleById(supabase, org.id),
  ]);
  if (connections.error) {
    console.error("Admin, providers: read failed", connections.error);
    return (
      <p role="alert" className="text-danger">
        The providers could not be loaded. Check that the database is reachable and reload.
      </p>
    );
  }

  const result = openRouterResultMessage(params.openrouter);
  const rows: Connection[] = connections.data
    .filter((c): c is typeof c & { provider: Connection["provider"] } => isProviderId(c.provider))
    .map((c) => ({
      provider: c.provider,
      last4: c.last4,
      source: c.source,
      createdAt: c.created_at,
      // Someone who is not a member (a platform admin) has no email on this page.
      createdBy: c.created_by ? (people.get(c.created_by) ?? shortId(c.created_by)) : null,
    }));

  return (
    <>
      {result ? (
        <p
          role={result.ok ? "status" : "alert"}
          className={cn(
            "rounded-md border px-3 py-2",
            result.ok
              ? "border-success-border bg-success-surface text-success"
              : "border-danger-border bg-danger-surface text-danger",
          )}
        >
          {result.message}
        </p>
      ) : null}
      <ProvidersList org={org.id} connections={rows} />
    </>
  );
}
