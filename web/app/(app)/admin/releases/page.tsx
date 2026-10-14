import type { Metadata } from "next";
import { Suspense } from "react";

import { NoAccess } from "@/components/no-access";
import { ReleaseProgress } from "@/components/release-progress";
import { APP_NAME } from "@/lib/config";
import { getCurrentOrg } from "@/lib/current-org";
import { releasesTokenUrl } from "@/lib/releases";

export const metadata: Metadata = { title: "Releases" };

export default function ReleasesPage() {
  return (
    <Suspense fallback={<p className="text-muted-foreground">Loading releases…</p>}>
      <Releases />
    </Suspense>
  );
}

async function Releases() {
  const { access, failed } = await getCurrentOrg();
  if (failed) return <NoAccess failed />;
  if (!access.platformAdmin) {
    return <p className="text-muted-foreground">Only a platform admin sees the deployment&apos;s releases.</p>;
  }
  return (
    <div className="grid gap-3">
      <p className="max-w-prose text-muted-foreground">
        Every push to main runs the checks, then releases: migrations, agent, web, each
        smoke-tested before it goes live. A failed step leaves the previous version in place.
      </p>
      <ReleaseProgress endpoint="/api/admin/releases" notConfigured={<TokenSteps />} />
    </div>
  );
}

// The repository is fixed at build time (next.config.ts); the token is the one thing to add.
function TokenSteps() {
  const repo = process.env.RELEASES_GITHUB_REPO ?? "";

  return (
    <div className="grid max-w-prose gap-2 rounded-md border bg-card p-3">
      <p className="font-medium">To see releases here, give the app a read-only GitHub token</p>
      <ol className="ml-5 grid list-decimal gap-1">
        <li>
          <a href={releasesTokenUrl(repo, APP_NAME)} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
            Create a fine-grained token
          </a>{" "}
          with access to {repo ? <code className="font-mono">{repo}</code> : "this repository"} only and
          Actions set to read. It can see runs and logs; it cannot start, stop or change anything.
        </li>
        <li>
          In Vercel, open the web project, Settings, Environment Variables, and add{" "}
          <code className="font-mono">RELEASES_GITHUB_TOKEN</code> for Production. (Or paste it in
          the Connect form of the local Setup page, which does the same.)
        </li>
        <li>Release once (push, or re-run the Deploy workflow): a new variable reaches only new deployments.</li>
      </ol>
      {repo ? null : (
        <p className="text-xs text-muted-foreground">
          This build does not know its repository: it was not built by the Deploy workflow. Set{" "}
          <code className="font-mono">RELEASES_GITHUB_REPO</code> (owner/name) as well.
        </p>
      )}
    </div>
  );
}
