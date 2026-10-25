import type { Metadata } from "next";
import { Plus } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";

import { NoAccess } from "@/components/no-access";
import { PageHeader } from "@/components/page-header";
import { NoProject } from "@/components/projects/no-project";
import { RelativeTime } from "@/components/relative-time";
import { buttonVariants } from "@/components/ui/button";
import { ClearLibrary, DeleteRegulation } from "@/components/regulations/delete-regulations";
import { type ImportView, ImportPanel } from "@/components/regulations/import-panel";
import { IndexPanel } from "@/components/regulations/index-panel";
import { LazyFigures } from "@/components/regulations/lazy-figures";
import { hasNoAccess } from "@/lib/access";
import { agentHealth } from "@/lib/agent-admin";
import { getCurrentOrg } from "@/lib/current-org";
import { getCurrentProject } from "@/lib/current-project";
import { countFigures, pictureHashes } from "@/lib/regulation-figures";
import {
  DEFAULT_EMBEDDING_MODEL,
  DIMENSIONS,
  type VersionIndex,
  type VersionSummary,
  libraryIndex,
  parseIndexStatus,
  vectorKey,
  versionSummary,
} from "@/lib/regulation-index";
import {
  ACTIVE_IMPORT,
  type ImportStatus,
  type LibraryPart,
  countFiles,
  countPictures,
  countSplit,
  formatBytes,
} from "@/lib/regulations";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Regulations" };

// A signed link to a PDF lasts this long. Long enough to read a document opened from the page,
// short enough that a link pasted into a chat stops working the same day.
const LINK_SECONDS = 60 * 60;

export default function RegulationsPage() {
  return (
    <div className="grid gap-4">
      <PageHeader
        title="Regulations"
        description="What this project's parts are checked against: the organisation's library, or the part of it the project chose."
        actions={
          <Suspense fallback={null}>
            <AddRegulations />
          </Suspense>
        }
      />
      <Suspense fallback={<p className="text-muted-foreground">Loading the library…</p>}>
        <Regulations />
      </Suspense>
    </div>
  );
}

// The page's main action, at the end of its title (Clemente, 2026-10-24: "Add regulations"). Only for
// those who may import into the library; it jumps to the import, which is on this page.
async function AddRegulations() {
  const { permissions } = await getCurrentOrg();
  if (!permissions.manage) return null;
  return (
    <a href="#import" className={buttonVariants({ size: "lg" })}>
      <Plus aria-hidden />
      Add regulations
    </a>
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
  summary: VersionSummary;
  // Pictures in the PDF (regulation_figures), and how many of them the vision model has not read.
  figures: number;
  figuresMissing: number;
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
  const [{ data, error }, scope, indexStatus, chosenEmbedding, health, latestImport, citations, figureCounts] = await Promise.all([
    supabase
      .from("regulations")
      .select(
        "id, code, kind, title, regulation_versions(id, version_label, role, status, size_bytes, pdf_path, paragraph_count, extraction_error, extracted_with, figures_missing, sha256, scope_summary, scope_keywords, summary_model, summarized_at, summary_sha256)",
      )
      .eq("organization_id", current.id),
    supabase
      .from("projects")
      .select("all_regulations, project_regulations(regulation_id)")
      .eq("id", project.id)
      .maybeSingle(),
    // Counts per version, from the agent's own tables (#37): what the search index holds.
    supabase.rpc("regulation_index_status", { org: current.id }),
    supabase
      .from("organization_models")
      .select("model")
      .eq("organization_id", current.id)
      .eq("process", "embedding")
      .maybeSingle(),
    agentHealth(),
    supabase
      .from("regulation_imports")
      .select("status")
      .eq("organization_id", current.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    // For the delete confirmations only: how many requirements lose their link (SYS-46).
    permissions.manage
      ? supabase.rpc("regulation_citation_counts", { org: current.id })
      : Promise.resolve({ data: [], error: null }),
    countFigures(supabase, current.id),
  ]);
  if (citations.error) console.error("Regulations: counting citations failed", citations.error);
  if (indexStatus.error) console.error("Regulations: reading the index status failed", indexStatus.error);
  if (error || scope.error) {
    console.error("Regulations: read failed", error);
    return (
      <p role="alert" className="text-danger">
        The library could not be loaded. Check that the database is reachable and reload.
      </p>
    );
  }

  // The model searches use now: the organisation's choice, else the deployment's (the agent's
  // /health), else the code's default. Vectors of another model are not counted: a search never
  // compares them with the query.
  const embeddingModel = chosenEmbedding.data?.model ?? health?.processes.embedding ?? DEFAULT_EMBEDDING_MODEL;
  const status = parseIndexStatus(indexStatus.data ?? []);
  const index = libraryIndex(
    status,
    data.flatMap((r) => r.regulation_versions.map((v) => versionSummary(v))),
    embeddingModel,
  );
  const importActive = latestImport.data ? ACTIVE_IMPORT.includes(latestImport.data.status as ImportStatus) : false;
  // delete_regulations refuses during an import too; this only says why before anyone presses.
  const deleteBlocked = importActive ? "An import is in progress: delete once it finishes or is cancelled." : null;
  const cited = new Map((citations.data ?? []).map((c) => [c.regulation_id, c.requirements]));
  const partOf = (r: (typeof data)[number]): LibraryPart => ({
    regulations: 1,
    versions: r.regulation_versions.length,
    paragraphs: r.regulation_versions.reduce((n, v) => n + (v.paragraph_count ?? 0), 0),
    requirements: cited.get(r.id) ?? 0,
  });
  const library = data.map(partOf).reduce(
    (a, b) => ({
      regulations: a.regulations + b.regulations,
      versions: a.versions + b.versions,
      paragraphs: a.paragraphs + b.paragraphs,
      requirements: a.requirements + b.requirements,
    }),
    { regulations: 0, versions: 0, paragraphs: 0, requirements: 0 },
  );

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
      <section className="grid gap-2">
        <h2 className="text-base font-semibold">Regulations of {project.name}</h2>
        <p className="text-sm text-muted-foreground">
          {all
            ? `All ${data.length} regulations in the library of ${current.name}, including any imported later.`
            : `${regulations.length} of the ${data.length} regulations in the library of ${current.name}.`}{" "}
          <Link href={`/projects/${project.id}#regulations-heading`} className="text-tint underline-offset-4 hover:underline">
            Change the choice
          </Link>
        </p>
        {data.length === 0 ? (
          <p className="rounded-xl border border-dashed px-3 py-6 text-center text-muted-foreground">
            The library is empty.{" "}
            {permissions.manage ? "Import an index file below." : "An admin of this organisation fills it from an index file."}
          </p>
        ) : regulations.length === 0 ? (
          <p className="rounded-xl border border-dashed px-3 py-6 text-center text-danger">
            This project has chosen no regulation, so a draft on it has nothing to cite.
          </p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              {regulations.length} regulations, {paths.length} PDFs. Answers cite the version label and the page
              of these exact files. Open a regulation to read and search its paragraphs.
            </p>
            <ul className="divide-y overflow-hidden rounded-xl border bg-card">
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
                    summary: versionSummary(v),
                    figures: figureCounts.get(v.id) ?? 0,
                    figuresMissing: v.figures_missing,
                  }))
                  .sort((a, b) => a.versionLabel.localeCompare(b.versionLabel, "en", { numeric: true }));
                return (
                  <li key={regulation.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3">
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
                    {permissions.manage ? (
                      <DeleteRegulation
                        org={current.id}
                        orgName={current.name}
                        regulationId={regulation.id}
                        code={regulation.code}
                        part={partOf(regulation)}
                        projectHref={`/projects/${project.id}#regulations-heading`}
                        blocked={deleteBlocked}
                      />
                    ) : null}
                    <IndexDetails
                      org={current.id}
                      versions={versions}
                      links={links}
                      status={status}
                      model={embeddingModel}
                    />
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>
      {data.length > 0 ? (
        <IndexPanel
          org={current.id}
          index={index}
          model={embeddingModel}
          canManage={permissions.manage}
          // An import added paragraphs the indexer has not seen yet, and is no longer adding more.
          autoStart={!importActive && index.unkeyed > 0}
          importing={importActive}
        />
      ) : null}
      {/* Last: the library is what people come to read, and "Add regulations" at the top of the
          page jumps here. Imports fill the organisation's library, shared by all its projects. */}
      {permissions.manage ? (
        <div id="import" className="scroll-mt-6">
          <Imports
            org={current.id}
            versions={data.flatMap((r) => r.regulation_versions)}
            extractor={health?.extractor ?? null}
            defaultFigureModel={health?.processes.figures ?? null}
          />
        </div>
      ) : null}
      {permissions.manage && data.length > 0 ? (
        <ClearLibrary org={current.id} orgName={current.name} part={library} blocked={deleteBlocked} />
      ) : null}
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
    <a href={href} target="_blank" rel="noreferrer" title={detail} className="text-tint underline-offset-4 hover:underline">
      {label}
    </a>
  );
}

// What the agent knows about each version before it opens one: the scope summary and keywords it
// reads to choose regulations, what the vision model read in the PDF's pictures (#52), and how much
// of the version vector search can find (#37), each with the model that made it. Collapsed: 92
// summaries open at once would bury the list.
function IndexDetails({
  org,
  versions,
  links,
  status,
  model,
}: {
  org: string;
  versions: Version[];
  links: ReadonlyMap<string, string>;
  status: ReadonlyMap<string, VersionIndex>;
  model: string;
}) {
  const key = vectorKey(model);
  return (
    <details className="w-full text-xs">
      <summary className="cursor-pointer text-muted-foreground">Summary, keywords, figures and search index</summary>
      <div className="mt-2 grid gap-3">
        {versions.map((version) => {
          const s = version.summary;
          const v = status.get(version.id);
          const embedded = v ? Math.min(v.paragraphs, v.vectors[key] ?? 0) : 0;
          const others = v ? Object.entries(v.vectors).filter(([k]) => k !== key) : [];
          return (
            <div key={version.id} className="grid gap-1 border-l-2 pl-3">
              <span className="font-medium">
                {version.versionLabel}
                {version.role ? ` ${version.role}` : ""}
              </span>
              {/* The keywords are written in the same call as the summary (agent
                  regulation_search.py), so one model name covers both. */}
              <span>
                <span className="text-muted-foreground">
                  Scope summary and keywords
                  {s.summary !== null ? (
                    <>
                      {" "}
                      (<span className="font-mono">{s.model ?? "unknown model"}</span>
                      {s.summarizedAt ? (
                        <>
                          , <RelativeTime iso={s.summarizedAt} />
                        </>
                      ) : null}
                      {s.stale ? ", from an older file: written again at the next indexing" : ""})
                    </>
                  ) : null}
                  :{" "}
                </span>
                {s.summary === null ? (
                  <span className="text-attention">none yet. The agent sees only the code and title.</span>
                ) : (
                  s.summary
                )}
              </span>
              {s.keywords.length > 0 ? (
                <span>
                  <span className="text-muted-foreground">Keywords: </span>
                  {s.keywords.join(", ")}
                </span>
              ) : null}
              <LazyFigures
                org={org}
                versionId={version.id}
                count={version.figures}
                missing={version.figuresMissing}
                pdfLink={links.get(version.pdfPath) ?? null}
              />
              <span>
                <span className="text-muted-foreground">Vectors: </span>
                {v ? (
                  <span className={embedded < v.paragraphs ? "text-attention" : ""}>
                    {embedded} of {v.paragraphs} paragraphs
                  </span>
                ) : (
                  "no paragraphs"
                )}{" "}
                <span className="text-muted-foreground">
                  (<span className="font-mono">{model}</span>, {DIMENSIONS} dimensions
                  {v?.lastEmbeddedAt ? (
                    <>
                      , last <RelativeTime iso={v.lastEmbeddedAt} />
                    </>
                  ) : null}
                  )
                </span>
                {others.length > 0 ? (
                  <span className="text-muted-foreground">
                    {" "}
                    Also kept, unused by search: {others.map(([k, n]) => `${n} of ${k}`).join(", ")}.
                  </span>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>
    </details>
  );
}

function describeParagraphs(version: Version): string {
  if (version.extractionError) return `not split into paragraphs: ${version.extractionError}`;
  if (version.paragraphCount === null) return "not split into paragraphs yet";
  return `${version.paragraphCount} paragraphs`;
}

// Admins of the organisation (and platform admins): the import form, the latest import's progress
// and the ones before it.
async function Imports({
  org,
  versions,
  extractor,
  defaultFigureModel,
}: {
  org: string;
  versions: { extracted_with: string | null }[];
  extractor: string | null;
  defaultFigureModel: string | null;
}) {
  const supabase = await createClient();
  const [{ data: imports, error }, hashes, figureChoice] = await Promise.all([
    supabase
      .from("regulation_imports")
      .select("id, status, source_name, error, created_at, updated_at, finished_at")
      .eq("organization_id", org)
      .order("created_at", { ascending: false })
      .limit(6),
    pictureHashes(supabase, org),
    supabase.from("organization_models").select("model").eq("organization_id", org).eq("process", "figures").maybeSingle(),
  ]);
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
      steps: {
        split: countSplit(versions, extractor),
        pictures: {
          ...countPictures(hashes.placed, hashes.described),
          model: figureChoice.data?.model ?? defaultFigureModel,
        },
      },
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
