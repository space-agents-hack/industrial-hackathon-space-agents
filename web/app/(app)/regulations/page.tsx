import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { NoAccess } from "@/components/no-access";
import { NoProject } from "@/components/projects/no-project";
import { type ImportView, ImportPanel } from "@/components/regulations/import-panel";
import { hasNoAccess } from "@/lib/access";
import { getCurrentOrg } from "@/lib/current-org";
import { getCurrentProject } from "@/lib/current-project";
import { type ImportStatus, countFiles, formatBytes } from "@/lib/regulations";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Regulations" };

// A signed link to a PDF lasts this long. Long enough to read a document opened from the page,
// short enough that a link pasted into a chat stops working the same day.
const LINK_SECONDS = 60 * 60;

export default function RegulationsPage() {
  return (
    <div className="grid gap-4">
      <h1 className="text-base font-semibold">Regulations</h1>
      <Suspense fallback={<p className="text-muted-foreground">Loading the library…</p>}>
        <Regulations />
      </Suspense>
    </div>
  );
}

type Version = {
  id: string;
  versionLabel: string;
  role: string | null;
  status: string | null;
  sizeBytes: number;
  pdfPath: string;
  // Null until the import splits the file (agent domain/paragraphs.py).
  paragraphCount: number | null;
  extractionError: string | null;
};

async function Regulations() {
  const [{ access, failed, current, permissions }, project] = await Promise.all([
    getCurrentOrg(),
    getCurrentProject(),
  ]);
  if (failed || hasNoAccess(access)) return <NoAccess failed={failed} />;
  if (!current || !project) return <NoProject />;
  const supabase = await createClient();

  // Each organisation has its own library (ADR-0006); a project uses all of it or a chosen part
  // (SYS-32), and this page shows that part (SYS-36). RLS lets a platform admin read every library,
  // so the filter is what keeps this page to the organisation in the header.
  const [{ data, error }, scope] = await Promise.all([
    supabase
      .from("regulations")
      .select(
        "id, code, kind, title, regulation_versions(id, version_label, role, status, size_bytes, pdf_path, paragraph_count, extraction_error)",
      )
      .eq("organization_id", current.id),
    supabase
      .from("projects")
      .select("all_regulations, project_regulations(regulation_id)")
      .eq("id", project.id)
      .maybeSingle(),
  ]);
  if (error || scope.error) {
    console.error("Regulations: read failed", error);
    return (
      <p role="alert" className="text-danger">
        The library could not be loaded. Check that the database is reachable and reload.
      </p>
    );
  }

  const all = scope.data?.all_regulations ?? true;
  const chosen = new Set(scope.data?.project_regulations.map((r) => r.regulation_id) ?? []);
  // "UN R3" before "UN R10": numeric order, not alphabetical.
  const regulations = data
    .filter((r) => all || chosen.has(r.id))
    .sort((a, b) => a.code.localeCompare(b.code, "en", { numeric: true }));
  const paths = regulations.flatMap((r) => r.regulation_versions.map((v) => v.pdf_path));
  const links = new Map<string, string>();
  if (paths.length > 0) {
    // As the signed-in person: the storage policy decides, the same as for the rows.
    const { data: signed, error: signError } = await supabase.storage.from("regulations").createSignedUrls(paths, LINK_SECONDS);
    if (signError) console.error("Regulations: signing links failed", signError);
    for (const item of signed ?? []) {
      if (item.path && item.signedUrl) links.set(item.path, item.signedUrl);
    }
  }

  return (
    <div className="grid gap-6">
      {/* First, so an import's progress is in view right after uploading. Imports fill the
          organisation's library, shared by all its projects. */}
      {permissions.manage ? <Imports org={current.id} /> : null}
      <section className="grid gap-2">
        <h2 className="text-sm font-semibold">Regulations of {project.name}</h2>
        <p className="text-sm text-muted-foreground">
          {all
            ? `All ${data.length} regulations in the library of ${current.name}, including any imported later.`
            : `${regulations.length} of the ${data.length} regulations in the library of ${current.name}.`}{" "}
          <Link href={`/projects/${project.id}#regulations-heading`} className="text-primary underline-offset-4 hover:underline">
            Change the choice
          </Link>
        </p>
        {data.length === 0 ? (
          <p className="rounded-md border border-dashed px-3 py-6 text-center text-muted-foreground">
            The library is empty.{" "}
            {permissions.manage ? "Import an index file above." : "An admin of this organisation fills it from an index file."}
          </p>
        ) : regulations.length === 0 ? (
          <p className="rounded-md border border-dashed px-3 py-6 text-center text-danger">
            This project has chosen no regulation, so a run on it has nothing to cite.
          </p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              {regulations.length} regulations, {paths.length} PDFs. Answers cite the version label and the page
              of these exact files. Open a regulation to read and search its paragraphs.
            </p>
            <ul className="divide-y rounded-md border bg-card">
              {regulations.map((regulation) => {
                const versions: Version[] = regulation.regulation_versions
                  .map((v) => ({
                    id: v.id,
                    versionLabel: v.version_label,
                    role: v.role,
                    status: v.status,
                    sizeBytes: v.size_bytes,
                    pdfPath: v.pdf_path,
                    paragraphCount: v.paragraph_count,
                    extractionError: v.extraction_error,
                  }))
                  .sort((a, b) => a.versionLabel.localeCompare(b.versionLabel, "en", { numeric: true }));
                return (
                  <li key={regulation.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2">
                    <span className="min-w-0 flex-1 basis-64">
                      <Link href={`/regulations/${regulation.id}`} className="font-medium underline-offset-4 hover:underline">
                        {regulation.code}
                      </Link>
                      {regulation.title ? <span className="text-muted-foreground"> · {regulation.title}</span> : null}
                    </span>
                    <span className="flex flex-wrap gap-2 text-xs">
                      {versions.map((version) => (
                        <VersionLink key={version.id} version={version} href={links.get(version.pdfPath)} />
                      ))}
                    </span>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}

function VersionLink({ version, href }: { version: Version; href: string | undefined }) {
  const label = `${version.versionLabel}${version.role ? ` ${version.role}` : ""}`;
  const detail = [version.status, formatBytes(version.sizeBytes), describeParagraphs(version)]
    .filter(Boolean)
    .join(", ");
  if (version.extractionError) {
    // Still citable by page, but the agent cannot search it: say so where the file is listed.
    return (
      <span className="text-danger" title={detail}>
        {href ? (
          <a href={href} target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline">
            {label}
          </a>
        ) : (
          label
        )}{" "}
        (not split)
      </span>
    );
  }
  if (!href) {
    return (
      <span className="text-muted-foreground" title={detail}>
        {label}
      </span>
    );
  }
  return (
    <a href={href} target="_blank" rel="noreferrer" title={detail} className="text-primary underline-offset-4 hover:underline">
      {label}
    </a>
  );
}

function describeParagraphs(version: Version): string {
  if (version.extractionError) return `not split into paragraphs: ${version.extractionError}`;
  if (version.paragraphCount === null) return "not split into paragraphs yet";
  return `${version.paragraphCount} paragraphs`;
}

// Admins of the organisation (and platform admins): the import form, the latest import's progress
// and the ones before it.
async function Imports({ org }: { org: string }) {
  const supabase = await createClient();
  const { data: imports, error } = await supabase
    .from("regulation_imports")
    .select("id, status, source_name, error, created_at, updated_at, finished_at")
    .eq("organization_id", org)
    .order("created_at", { ascending: false })
    .limit(6);
  if (error) {
    console.error("Regulations: reading imports failed", error);
    return (
      <p role="alert" className="text-danger">
        The imports could not be loaded.
      </p>
    );
  }

  const [latest, ...earlier] = imports;
  let latestView: ImportView | null = null;
  if (latest) {
    // Statuses only, for the counts; at most 2000 files per import (the agent's limit), read in
    // two pages because PostgREST returns 1000 rows per request.
    const statuses: string[] = [];
    for (let from = 0; from < 2000; from += 1000) {
      const { data: page } = await supabase
        .from("regulation_import_files")
        .select("status")
        .eq("import_id", latest.id)
        .order("position")
        .range(from, from + 999);
      statuses.push(...(page ?? []).map((row) => row.status));
      if (!page || page.length < 1000) break;
    }
    const { data: failedFiles } = await supabase
      .from("regulation_import_files")
      .select("regulation_code, version_label, error")
      .eq("import_id", latest.id)
      .eq("status", "failed")
      .order("position")
      .limit(50);
    latestView = {
      id: latest.id,
      status: latest.status as ImportStatus,
      sourceName: latest.source_name,
      error: latest.error,
      createdAt: latest.created_at,
      updatedAt: latest.updated_at,
      counts: countFiles(statuses),
      failedFiles: (failedFiles ?? []).map((f) => ({
        name: `${f.regulation_code} ${f.version_label}`,
        error: f.error ?? "",
      })),
    };
  }

  return (
    <ImportPanel
      org={org}
      latest={latestView}
      earlier={earlier.map((i) => ({
        id: i.id,
        status: i.status as ImportStatus,
        sourceName: i.source_name,
        createdAt: i.created_at,
        error: i.error,
      }))}
    />
  );
}
