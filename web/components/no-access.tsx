// For someone who signed in but belongs to no organisation (or whose memberships are all
// suspended), and for the case where their access could not be read at all.
export function NoAccess({ failed }: { failed: boolean }) {
  if (failed) {
    return (
      <p role="alert" className="text-danger">
        Your access could not be checked. Check that the database is reachable and reload.
      </p>
    );
  }
  return (
    <div className="grid max-w-prose gap-2">
      <h1 className="text-base font-semibold">No access yet</h1>
      <p>
        You are signed in, but you do not belong to any organisation, or your membership is
        suspended.{" "}
        <a href="/welcome" className="text-primary underline-offset-4 hover:underline">
          Ask to join one
        </a>
        , or ask an admin of yours to add you in Settings, People.
      </p>
    </div>
  );
}
