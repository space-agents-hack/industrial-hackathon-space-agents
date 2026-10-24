import Link from "next/link";

// A project's section opened without a project that is still yours (SYS-36): the cookie names one
// that was deleted, or one in another organisation. proxy.ts already sends a person with no
// project at all to the picker.
export function NoProject() {
  return (
    <p className="text-muted-foreground">
      This section belongs to a project.{" "}
      <Link href="/projects" className="text-tint underline-offset-4 hover:underline">
        Choose a project
      </Link>
    </p>
  );
}
