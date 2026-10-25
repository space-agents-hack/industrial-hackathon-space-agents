import { NextResponse } from "next/server";

import { pdfAtPage, pickVersion, readCitation } from "@/lib/requirement-source";
import { fetchRun } from "@/lib/runs";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/validation";

// A requirement's citation, opened (SYS-12, #58): the run's organisation's stored PDF of the cited
// regulation version, at the cited page. Read as the person, so RLS decides: a run or a regulation
// they cannot read is unknown here, and the PDF is signed only if storage lets them read it.
// Same validity as the Regulations page's links; it is signed at the click, so only a reload of
// the PDF tab an hour later fails.
const LINK_SECONDS = 60 * 60;

export async function GET(request: Request, ctx: RouteContext<"/runs/[id]/source">) {
  const { id } = await ctx.params;
  const citation = readCitation(new URL(request.url).searchParams);
  const library = new URL("/regulations", request.url);
  if (!isUuid(id) || !citation) return NextResponse.redirect(library, 303);

  const supabase = await createClient();
  const run = await fetchRun(supabase, id).catch(() => null);
  if (!run?.organization_id) return NextResponse.redirect(new URL("/runs", request.url), 303);

  // Codes are unique per organisation and kept exactly as the index writes them, which is also
  // what the submission cites (SYS-5), so the code finds the regulation without normalising.
  const { data: regulation, error } = await supabase
    .from("regulations")
    .select("id, regulation_versions(version_label, role, pdf_path)")
    .eq("organization_id", run.organization_id)
    .eq("code", citation.regulation)
    .maybeSingle();
  if (error) console.error(`GET /runs/${id}/source: regulation read failed`, error);
  // Not in the library (deleted since the run, or a citation the checks would flag): the library
  // is where the person can see what is there.
  if (!regulation) return NextResponse.redirect(library, 303);

  const regulationPage = new URL(`/regulations/${regulation.id}`, request.url);
  const version = pickVersion(regulation.regulation_versions, citation.version);
  if (!version) return NextResponse.redirect(regulationPage, 303);
  const signed = await supabase.storage.from("regulations").createSignedUrl(version.pdf_path, LINK_SECONDS);
  if (!signed.data?.signedUrl) {
    console.error(`GET /runs/${id}/source: signing failed`, signed.error);
    return NextResponse.redirect(regulationPage, 303);
  }
  return NextResponse.redirect(pdfAtPage(signed.data.signedUrl, citation.page), 303);
}
