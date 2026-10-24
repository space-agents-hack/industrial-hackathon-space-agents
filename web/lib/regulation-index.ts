// The search index of a regulation library, as the Regulations page shows it (#37; SYS-28): the
// vectors and scope summaries the agent's indexer writes (agent domain/regulation_search.py), and
// the answer of one indexing slice. No React, Supabase or Next.js imports, so `node --test` runs
// them directly.

// What the indexer uses when the organisation chose no embedding model (EMBEDDING_MODEL in
// agent/agent_service/settings.py), when the agent's /health cannot be read. Stored vectors are
// keyed "provider:model@dimensions" (regulation_search.EmbeddingModel.key).
export const DEFAULT_EMBEDDING_MODEL = "openai:text-embedding-3-small";
export const DIMENSIONS = 1024;

export function vectorKey(model: string): string {
  return `${model}@${DIMENSIONS}`;
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// One version's row of regulation_index_status.
export type VersionIndex = {
  paragraphs: number;
  keyed: number;
  // Vectors per embedding model key.
  vectors: Record<string, number>;
  lastEmbeddedAt: string | null;
};

export function parseIndexStatus(rows: readonly Record<string, unknown>[]): Map<string, VersionIndex> {
  const out = new Map<string, VersionIndex>();
  for (const r of rows) {
    if (typeof r.version_id !== "string") continue;
    const vectors: Record<string, number> = {};
    if (r.vectors && typeof r.vectors === "object" && !Array.isArray(r.vectors)) {
      for (const [model, n] of Object.entries(r.vectors as Record<string, unknown>)) vectors[model] = num(n);
    }
    out.set(r.version_id, {
      paragraphs: num(r.paragraphs),
      keyed: num(r.keyed),
      vectors,
      lastEmbeddedAt: typeof r.last_embedded_at === "string" ? r.last_embedded_at : null,
    });
  }
  return out;
}

// A version's scope summary, from its own columns (migration 20261024210000).
export type VersionSummary = {
  summary: string | null;
  keywords: string[];
  model: string | null;
  summarizedAt: string | null;
  // The summary was written from another file than the one stored now: the indexer writes it again.
  stale: boolean;
};

export function versionSummary(v: {
  scope_summary: string | null;
  scope_keywords: string[] | null;
  summary_model: string | null;
  summarized_at: string | null;
  summary_sha256: string | null;
  sha256: string;
}): VersionSummary {
  return {
    summary: v.scope_summary,
    keywords: v.scope_keywords ?? [],
    model: v.summary_model,
    summarizedAt: v.summarized_at,
    stale: v.scope_summary !== null && v.summary_sha256 !== null && v.summary_sha256 !== v.sha256,
  };
}

export type LibraryIndex = {
  paragraphs: number;
  // Paragraphs with a vector of the model searches use now.
  embedded: number;
  // Paragraphs the indexer has not seen since they were extracted: an import added them.
  unkeyed: number;
  versions: number;
  summarized: number;
};

export function libraryIndex(
  status: ReadonlyMap<string, VersionIndex>,
  summaries: readonly VersionSummary[],
  model: string,
): LibraryIndex {
  const key = vectorKey(model);
  let paragraphs = 0;
  let embedded = 0;
  let unkeyed = 0;
  for (const v of status.values()) {
    paragraphs += v.paragraphs;
    embedded += Math.min(v.paragraphs, v.vectors[key] ?? 0);
    unkeyed += Math.max(0, v.paragraphs - v.keyed);
  }
  return {
    paragraphs,
    embedded,
    unkeyed,
    versions: summaries.length,
    summarized: summaries.filter((s) => s.summary !== null && !s.stale).length,
  };
}

export function indexComplete(index: LibraryIndex): boolean {
  return index.embedded >= index.paragraphs && index.summarized >= index.versions;
}

// What searches do with the library as it is: the sentence a person needs before reading results.
export function describeSearch(index: LibraryIndex): { text: string; tone: "ok" | "attention" } {
  if (index.paragraphs === 0) return { text: "No paragraphs yet: nothing to search.", tone: "attention" };
  if (index.embedded === 0) {
    return {
      text: "Not indexed: searches match words only, so a question worded differently from the regulation finds nothing.",
      tone: "attention",
    };
  }
  if (index.embedded < index.paragraphs) {
    return {
      text: `Partly indexed: ${index.paragraphs - index.embedded} paragraphs are found by words only until the indexer reaches them.`,
      tone: "attention",
    };
  }
  return { text: "Indexed: searches match by meaning and by words.", tone: "ok" };
}

// ---------------------------------------------------------------------------------------------
// One slice of indexing (agent POST /regulations/index/{org}/advance)
// ---------------------------------------------------------------------------------------------

export type IndexSlice =
  | {
      status: "finished" | "paused";
      embedded: number;
      summarized: number;
      pruned: number;
      keysChanged: number;
      notes: string[];
    }
  | { status: "failed"; error: string };

// The agent streams one JSON object per line and ends with {"event": "done", ...}.
export function parseIndexStream(text: string): IndexSlice | null {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  for (let i = lines.length - 1; i >= 0; i--) {
    let line: unknown;
    try {
      line = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!line || typeof line !== "object") continue;
    const l = line as Record<string, unknown>;
    if (l.event !== "done") continue;
    if (l.status === "failed") return { status: "failed", error: String(l.error ?? "The indexer failed.") };
    return {
      status: l.finished === true ? "finished" : "paused",
      embedded: num(l.embedded),
      summarized: num(l.summarized),
      pruned: num(l.pruned),
      keysChanged: num(l.keys_changed),
      notes: Array.isArray(l.notes) ? l.notes.map(String) : [],
    };
  }
  return null;
}

// Whether to send the next slice. A slice that wrote nothing will not write anything the next
// time either (no key, no summary model, an unreadable PDF): asking again would loop forever.
export function shouldContinue(slice: IndexSlice): boolean {
  return slice.status === "paused" && slice.embedded + slice.summarized > 0;
}
