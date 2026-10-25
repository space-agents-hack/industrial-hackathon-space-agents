import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

// The pictures of a regulation version and what the vision model read in each (#52; agent
// domain/figures.py). The descriptions are kept per organisation by picture, not by version (the
// same picture in two versions is read once), so they are joined here rather than through a
// foreign key.

// More pictures than any of the challenge's PDFs has (the most is under 200).
export const FIGURES_SHOWN = 500;
// PostgREST's max_rows (supabase/config.toml): a longer list comes back cut, silently.
const PAGE = 1000;

export type RegulationFigure = {
  page: number;
  position: number;
  width_pt: number;
  height_pt: number;
  description: string | null;
  error: string | null;
  model: string | null;
};

export async function readFigures(
  supabase: SupabaseClient<Database>,
  org: string,
  version: string,
): Promise<{ figures: RegulationFigure[]; failed: boolean }> {
  const { data: placed, error } = await supabase
    .from("regulation_figures")
    .select("page, position, image_sha256, width_pt, height_pt")
    .eq("version_id", version)
    .order("page")
    .order("position")
    .limit(FIGURES_SHOWN);
  if (error) {
    console.error("Regulation figures: read failed", error);
    return { figures: [], failed: true };
  }
  if (!placed?.length) return { figures: [], failed: false };
  const shas = [...new Set(placed.map((f) => f.image_sha256))];
  const { data: described, error: e } = await supabase
    .from("regulation_figure_descriptions")
    .select("image_sha256, description, error, model")
    .eq("organization_id", org)
    .in("image_sha256", shas);
  if (e) console.error("Regulation figures: descriptions read failed", e);
  const bySha = new Map((described ?? []).map((d) => [d.image_sha256, d]));
  const figures = placed.map(({ image_sha256, ...f }) => {
    const d = bySha.get(image_sha256);
    return {
      ...f,
      description: d?.description ?? null,
      error: d?.error ?? null,
      model: d?.model ?? null,
    };
  });
  return { figures, failed: Boolean(e) };
}

// How many pictures each version of the organisation's library has, for the list of regulations.
// Ids only, in pages: the descriptions are read when someone opens a version's figures.
export async function countFigures(
  supabase: SupabaseClient<Database>,
  org: string,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("regulation_figures")
      .select("version_id")
      .eq("organization_id", org)
      .order("version_id")
      .order("page")
      .order("position")
      .range(from, from + PAGE - 1);
    if (error) {
      console.error("Regulation figures: counting failed", error);
      return counts;
    }
    for (const row of data)
      counts.set(row.version_id, (counts.get(row.version_id) ?? 0) + 1);
    if (data.length < PAGE) return counts;
  }
}

// Every picture hash in the organisation's split versions, and the hashes the model has read or
// refused, for the import's progress (#52). Hashes only: about 2,600 and 1,600 for the challenge's
// library, read in pages.
export async function pictureHashes(
  supabase: SupabaseClient<Database>,
  org: string,
): Promise<{ placed: string[]; described: Set<string> }> {
  const placed: string[] = [];
  const described = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("regulation_figures")
      .select("image_sha256")
      .eq("organization_id", org)
      .order("version_id")
      .order("page")
      .order("position")
      .range(from, from + PAGE - 1);
    if (error) console.error("Regulation figures: reading hashes failed", error);
    placed.push(...(data ?? []).map((row) => row.image_sha256));
    if (!data || data.length < PAGE) break;
  }
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("regulation_figure_descriptions")
      .select("image_sha256")
      .eq("organization_id", org)
      .order("image_sha256")
      .range(from, from + PAGE - 1);
    if (error) console.error("Regulation figures: reading descriptions failed", error);
    for (const row of data ?? []) described.add(row.image_sha256);
    if (!data || data.length < PAGE) break;
  }
  return { placed, described };
}
