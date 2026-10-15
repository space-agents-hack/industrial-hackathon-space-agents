// Shown on Releases and Deployment when this deployment has no GitHub App yet (ADR-0005).
export function GithubAppMissing() {
  return (
    <div className="grid max-w-prose gap-2 rounded-md border bg-card p-3">
      <p className="font-medium">Connect GitHub to see and manage releases here</p>
      <p>
        On a machine with the repository, run <code className="font-mono">make dev</code>, open Setup,
        Deploy to production, and press <strong>Connect GitHub</strong>: two clicks on GitHub (Create,
        Install). A release then gives this app its own key, limited to this repository.
      </p>
    </div>
  );
}
