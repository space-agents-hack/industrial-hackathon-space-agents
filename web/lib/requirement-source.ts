// A requirement's citation as a link to its source page (SYS-12, #58): the brief's demo criterion
// asks that "every requirement links to its source page".
//
// The link goes to a route of the run, not to a signed PDF URL. Signing on click means a list of
// thousands of requirements signs nothing nobody opens, and a page left open overnight still opens
// the PDF (a signed URL written into the page would have expired). It never points at Certivity's
// index.json links: those expire after the event, the week Certivity would try the tool (#6).

export type Citation = { regulation: string; version: string; page: number };

// Codes are at most 100 characters in the library (regulations.code); the longest regulation in
// the challenge has a few hundred pages, so a page in the tens of thousands is a broken citation.
const MAX_CODE = 100;
const MAX_PAGE = 99_999;

// Null when there is nothing to open: no regulation or no page. The paragraph is not part of the
// link: a PDF viewer opens at a page, not at a paragraph label.
export function sourceHref(
  runId: string,
  citation: { regulation: string; version: string; page: number | null },
): string | null {
  if (!citation.regulation || !citation.page) return null;
  const query = new URLSearchParams({ regulation: citation.regulation, page: String(citation.page) });
  if (citation.version) query.set("version", citation.version);
  return `/runs/${runId}/source?${query.toString()}`;
}

export function readCitation(params: URLSearchParams): Citation | null {
  const regulation = (params.get("regulation") ?? "").trim();
  const version = (params.get("version") ?? "").trim();
  const page = Number(params.get("page"));
  if (!regulation || regulation.length > MAX_CODE || version.length > MAX_CODE) return null;
  if (!Number.isInteger(page) || page < 1 || page > MAX_PAGE) return null;
  return { regulation, version, page };
}

// The version the citation names, else the base one: a submission cites the base version (SYS-5),
// so a citation without a version, or with one the library does not hold, means that one.
export function pickVersion<V extends { version_label: string; role: string | null }>(
  versions: V[],
  label: string,
): V | null {
  return versions.find((v) => v.version_label === label) ?? versions.find((v) => v.role === "base") ?? null;
}

// `#page=N` is what the browsers' built-in PDF viewers read (Chrome, Edge, Firefox); the
// Regulations page uses the same. A viewer that ignores it opens the PDF at its first page.
export function pdfAtPage(signedUrl: string, page: number): string {
  return `${signedUrl.split("#")[0]}#page=${page}`;
}
