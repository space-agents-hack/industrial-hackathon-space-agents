// Shared by the library page (inside a client component) and the regulation page (on the
// server), so nothing here holds state.
import type { RegulationFigure } from "@/lib/regulation-figures";

// The model that read most of a version's pictures. A version's pictures are normally all read by
// one model, so it is named once, in the heading; a picture read by another (the choice in Admin
// changed between imports) names its own.
export function mainModel(figures: RegulationFigure[]): string | null {
  const counts = new Map<string, number>();
  for (const f of figures)
    if (f.model) counts.set(f.model, (counts.get(f.model) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

// Each picture of a version: its page (a link into the PDF when there is one) and what the vision
// model read in it, or why it was not read.
export function FigureList({
  figures,
  pdfLink,
}: {
  figures: RegulationFigure[];
  pdfLink: string | null;
}) {
  const main = mainModel(figures);
  return (
    <ol className="grid gap-2 py-2">
      {figures.map((f) => (
        <li
          key={`${f.page}-${f.position}`}
          className="grid grid-cols-[3.5rem_1fr] gap-x-2"
        >
          <span className="text-muted-foreground tabular-nums">
            {pdfLink ? (
              <a
                href={`${pdfLink}#page=${f.page}`}
                target="_blank"
                rel="noreferrer"
                className="underline-offset-4 hover:underline"
              >
                p. {f.page}
              </a>
            ) : (
              `p. ${f.page}`
            )}
          </span>
          <span
            className={
              f.description === null
                ? f.error
                  ? "text-danger"
                  : "text-muted-foreground"
                : "whitespace-pre-wrap"
            }
          >
            {f.description ??
              (f.error
                ? `Not read: ${f.error}`
                : "Not read yet: the next import tries again.")}
            {f.model && f.model !== main ? (
              <span className="text-muted-foreground">
                {" "}
                (<span className="font-mono">{f.model}</span>)
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function figureHeading(
  count: number,
  missing: number,
  model: string | null,
) {
  return (
    <>
      <span className="text-muted-foreground">
        Figures
        {model ? (
          <>
            {" "}
            (<span className="font-mono">{model}</span>)
          </>
        ) : null}
        :{" "}
      </span>
      {count} {count === 1 ? "picture" : "pictures"}
      {missing > 0 ? (
        <span className="text-attention">, {missing} not read yet</span>
      ) : null}
    </>
  );
}
