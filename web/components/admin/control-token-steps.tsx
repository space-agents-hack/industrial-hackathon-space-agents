import { APP_NAME } from "@/lib/config";
import { CONTROL_TOKEN_PERMISSIONS, controlTokenUrl } from "@/lib/deployment";

// What to do when production has no GitHub control token yet (ADR-0005). Shown on Releases and
// Deployment, which both need it.
export function ControlTokenSteps() {
  // Fixed at build time (next.config.ts).
  const repo = process.env.GITHUB_REPO ?? "";
  return (
    <div className="grid max-w-prose gap-2 rounded-md border bg-card p-3">
      <p className="font-medium">Give the app its GitHub control token</p>
      <ol className="ml-5 grid list-decimal gap-1">
        <li>
          <a
            href={controlTokenUrl(repo, APP_NAME)}
            target="_blank"
            rel="noreferrer"
            className="text-primary underline underline-offset-2"
          >
            Create a fine-grained token
          </a>{" "}
          for {repo ? <code className="font-mono">{repo}</code> : "this repository"} only, with{" "}
          {CONTROL_TOKEN_PERMISSIONS}. It can store values in GitHub without reading them back and
          start workflows; it cannot change code or read your Vercel and Supabase tokens.
        </li>
        <li>
          In Vercel, open the web project, Settings, Environment Variables, and add{" "}
          <code className="font-mono">GITHUB_CONTROL_TOKEN</code> for Production. (Setup gives it to
          the app when you paste it there.)
        </li>
        <li>Release once (push, or Run workflow on Deploy in GitHub): a new variable reaches only new deployments.</li>
      </ol>
      {repo ? null : (
        <p className="text-xs text-muted-foreground">
          This build does not know its repository: it was not built by the Deploy workflow. Set{" "}
          <code className="font-mono">GITHUB_REPO</code> (owner/name) as well.
        </p>
      )}
    </div>
  );
}
