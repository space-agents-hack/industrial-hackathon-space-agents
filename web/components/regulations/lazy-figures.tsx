"use client";

import { useState } from "react";

import {
  FigureList,
  figureHeading,
  mainModel,
} from "@/components/regulations/figure-parts";
import { type RegulationFigure, readFigures } from "@/lib/regulation-figures";
import { createClient } from "@/lib/supabase/client";

// The list inside the library's per-regulation details, read only when opened: the whole
// library's descriptions are a few megabytes, which every visit to the page would otherwise load.
export function LazyFigures({
  org,
  versionId,
  count,
  missing,
  pdfLink,
}: {
  org: string;
  versionId: string;
  count: number;
  missing: number;
  pdfLink: string | null;
}) {
  const [state, setState] = useState<
    "closed" | "loading" | { figures: RegulationFigure[]; failed: boolean }
  >("closed");
  if (count === 0) {
    return (
      <span>
        <span className="text-muted-foreground">Figures: </span>none
      </span>
    );
  }
  const loaded = typeof state === "object" ? state : null;
  return (
    <details
      onToggle={(event) => {
        if (!event.currentTarget.open || state !== "closed") return;
        setState("loading");
        void readFigures(createClient(), org, versionId).then(setState);
      }}
    >
      <summary className="cursor-pointer">
        {figureHeading(
          count,
          missing,
          loaded ? mainModel(loaded.figures) : null,
        )}
      </summary>
      {state === "loading" ? (
        <p className="py-2 text-muted-foreground">Loading the figures…</p>
      ) : loaded?.failed && loaded.figures.length === 0 ? (
        <p role="alert" className="py-2 text-danger">
          The figures could not be loaded.
        </p>
      ) : loaded ? (
        <FigureList figures={loaded.figures} pdfLink={pdfLink} />
      ) : null}
    </details>
  );
}
