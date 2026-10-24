import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { NoAccess } from "@/components/no-access";
import { Breadcrumb } from "@/components/projects/breadcrumb";
import { hasNoAccess } from "@/lib/access";
import { getAccess } from "@/lib/current-org";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/validation";

export const metadata: Metadata = { title: "Regulation" };

// One regulation of the library: its versions, and the paragraphs the import split it into, with
// their labels and pages exactly as a requirement cites them (SYS-6, IF-3). What the agent can
// cite is what is listed here, so this is the page to check a citation against.
const SHOWN = 400;
const LINK_SECONDS = 60 * 60;

export default function RegulationPage(props: PageProps<"/regulations/[id]">) {
  return (
    <div className="grid gap-4">
      <Suspense fallback={<p className="text-muted-foreground">Loading the regulation…</p>}>
        <Regulation {...props} />
      </Suspense>
    </div>
  );
}

function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

async function Regulation({ params, searchParams }: PageProps<"/regulations/[id]">) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  if (!isUuid(id)) return <Missing />;
  const supabase = await createClient();
  const [{ access, failed }, { data: regulation, error }] = await Promise.all([
    getAccess(),
    supabase
      .from("regulations")
      .select(
        "id, code, title, organization_id, organizations(name), regulation_versions(id, version_label, role, status, pdf_path, paragraph_count, extraction_error)",
      )
      .eq("id", id)
      .maybeSingle(),
  ]);
  if (failed || hasNoAccess(access)) return <NoAccess failed={failed} />;
  if (error) {
    console.error("Regulation: read failed", error);
    return (
      <p role="alert" className="text-danger">
        The regulation could not be loaded. Check that the database is reachable and reload.
      </p>
    );
  }
  if (!regulation) return <Missing />;

  const versions = [...regulation.regulation_versions].sort((a, b) =>
    a.version_label.localeCompare(b.version_label, "en", { numeric: true }),
  );
  // The base version first: it is the one a Certivity submission cites (SYS-5).
  const wanted = one(query.v);
  const version =
    versions.find((v) => v.id === wanted) ?? versions.find((v) => v.role === "base") ?? versions.at(0) ?? null;
  const q = one(query.q).trim().slice(0, 200);

  let paragraphs: { id: string; label: string | null; heading: string; text: string; page_start: number; page_end: number }[] = [];
  let readError = false;
  let pdfLink: string | null = null;
  if (version) {
    let request = supabase
      .from("regulation_paragraphs")
      .select("id, label, heading, text, page_start, page_end")
      .eq("version_id", version.id)
      // Superseded rows are kept for the requirements written from them, not shown as the library.
      .is("superseded_at", null);
    // The import's full-text index: labels weigh most, then headings, then the text.
    if (q) request = request.textSearch("fts", q, { type: "websearch", config: "english" });
    const [{ data, error: e }, signed] = await Promise.all([
      request.order("position").limit(SHOWN),
      supabase.storage.from("regulations").createSignedUrl(version.pdf_path, LINK_SECONDS),
    ]);
    if (e) {
      console.error("Regulation: paragraphs read failed", e);
      readError = true;
    }
    paragraphs = data ?? [];
    pdfLink = signed.data?.signedUrl ?? null;
  }

  return (
    <>
      <div className="grid gap-1">
        <Breadcrumb
          items={[
            { label: regulation.organizations?.name ?? "Organisation" },
            { label: "Regulations", href: "/regulations" },
            { label: regulation.code },
          ]}
        />
        <h1 className="text-lg font-semibold">
          {regulation.code}
          {regulation.title ? <span className="font-normal text-muted-foreground"> · {regulation.title}</span> : null}
        </h1>
      </div>

      {versions.length > 1 ? (
        <nav aria-label="Versions" className="flex flex-wrap gap-1 text-sm">
          {versions.map((v) => (
            <Link
              key={v.id}
              href={`/regulations/${regulation.id}?v=${v.id}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
              aria-current={v.id === version?.id ? "page" : undefined}
              className={`inline-flex h-8 items-center rounded-md border px-2 ${v.id === version?.id ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted"}`}
            >
              {v.version_label}
              {v.role ? ` (${v.role})` : ""}
            </Link>
          ))}
        </nav>
      ) : null}

      {!version ? (
        <p className="text-muted-foreground">No version of this regulation is stored yet.</p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Version {version.version_label}
            {version.status ? `, ${version.status}` : ""}.{" "}
            {version.extraction_error
              ? `Not split into paragraphs: ${version.extraction_error}`
              : version.paragraph_count === null
                ? "Not split into paragraphs yet."
                : `${version.paragraph_count} paragraphs.`}{" "}
            {pdfLink ? (
              <a href={pdfLink} target="_blank" rel="noreferrer" className="text-primary underline-offset-4 hover:underline">
                Open the PDF
              </a>
            ) : null}
          </p>
          <form className="flex gap-2" action={`/regulations/${regulation.id}`}>
            <input type="hidden" name="v" value={version.id} />
            <input
              type="search"
              name="q"
              defaultValue={q}
              aria-label="Search the paragraphs"
              placeholder="Search, e.g. 6.2.1 or photometric"
              className="h-8 w-full max-w-md rounded-md border border-input bg-card px-2 text-sm"
            />
            <button type="submit" className="h-8 rounded-md border px-3 text-sm hover:bg-muted">
              Search
            </button>
          </form>
          {readError ? (
            <p role="alert" className="text-danger">
              The paragraphs could not be loaded.
            </p>
          ) : paragraphs.length === 0 ? (
            <p className="text-muted-foreground">{q ? `No paragraph matches "${q}".` : "No paragraphs stored."}</p>
          ) : (
            <>
              {paragraphs.length === SHOWN ? (
                <p className="text-xs text-muted-foreground">
                  The first {SHOWN} {q ? "matches" : "paragraphs"}. Search to narrow them.
                </p>
              ) : null}
              <ol className="divide-y rounded-md border bg-card">
                {paragraphs.map((p) => (
                  <li key={p.id} className="grid gap-1 px-3 py-2">
                    <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                      <span className="font-mono font-medium">{p.label ?? "(no label)"}</span>
                      {p.heading ? <span className="text-muted-foreground">{p.heading}</span> : null}
                      <span className="ml-auto text-xs whitespace-nowrap text-muted-foreground">
                        {pdfLink ? (
                          <a
                            href={`${pdfLink}#page=${p.page_start}`}
                            target="_blank"
                            rel="noreferrer"
                            className="underline-offset-4 hover:underline"
                          >
                            {p.page_end > p.page_start ? `pages ${p.page_start}–${p.page_end}` : `page ${p.page_start}`}
                          </a>
                        ) : p.page_end > p.page_start ? (
                          `pages ${p.page_start}–${p.page_end}`
                        ) : (
                          `page ${p.page_start}`
                        )}
                      </span>
                    </p>
                    <p className="text-sm whitespace-pre-wrap">{p.text}</p>
                  </li>
                ))}
              </ol>
            </>
          )}
        </>
      )}
    </>
  );
}

function Missing() {
  return (
    <p className="text-muted-foreground">
      This regulation is not in the library of an organisation you are in.{" "}
      <Link href="/regulations" className="text-primary underline-offset-4 hover:underline">
        The library
      </Link>
    </p>
  );
}
