"use client";

import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { CASE_FILES_BUCKET, displayType, textPreview, viewOf } from "@/lib/case-files";
import type { CaseFileView } from "@/lib/cases";
import { createClient } from "@/lib/supabase/client";

// Headings, lists and tables of a rendered .md file. Written here rather than with a typography
// plugin: it is the only markdown the app shows.
const MARKDOWN =
  "grid gap-2 text-sm [&_a]:text-tint [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_code]:font-mono [&_code]:text-xs [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-semibold [&_h4]:font-medium [&_hr]:border-border [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-2 [&_table]:w-full [&_table]:border-collapse [&_table]:text-xs [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_td]:align-top [&_th]:border [&_th]:bg-muted [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_ul]:list-disc [&_ul]:pl-5";

const CANNOT_SHOW: Record<string, string> = {
  docx: "a Word document",
  xlsx: "an Excel workbook",
  step: "a CAD model",
  iges: "a CAD model",
  stl: "a CAD model",
};

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; url: string; text: string | null; cut: boolean };

// One case file as it was uploaded (SYS-31, #45), next to "What was read" from it. The bytes are
// read as the signed-in person, so the bucket's policy decides who sees them, as for the rows.
export function UploadedFile({ file }: { file: Pick<CaseFileView, "filename" | "format" | "storage_path"> }) {
  const view = viewOf(file.format, file.filename);
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let live = true;
    let objectUrl: string | null = null;
    const bucket = createClient().storage.from(CASE_FILES_BUCKET);

    async function load(): Promise<State> {
      if (view === "download") {
        // Nothing to show, so the bytes are not fetched: a link that downloads under the file's name.
        const { data, error } = await bucket.createSignedUrl(file.storage_path, 60 * 60, { download: file.filename });
        if (error) throw error;
        return { kind: "ready", url: data.signedUrl, text: null, cut: false };
      }
      const { data, error } = await bucket.download(file.storage_path);
      if (error) throw error;
      // Retyped before it is shown: the stored type is often application/octet-stream
      // (lib/case-files.ts, displayType), which the browser would download instead of showing.
      objectUrl = URL.createObjectURL(new Blob([data], { type: displayType(view, file.format, file.filename) }));
      if (view === "image" || view === "pdf") return { kind: "ready", url: objectUrl, text: null, cut: false };
      const { text, cut } = textPreview(view, await data.text());
      return { kind: "ready", url: objectUrl, text, cut };
    }

    load()
      .then((next) => {
        if (live) setState(next);
      })
      .catch((caught: unknown) => {
        if (live) {
          const reason = caught instanceof Error ? caught.message : String(caught);
          setState({ kind: "error", message: `The file could not be opened: ${reason}` });
        }
      });
    return () => {
      live = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [view, file.storage_path, file.filename, file.format]);

  if (state.kind === "loading") return <p className="text-sm text-muted-foreground">Opening the file…</p>;
  if (state.kind === "error") return <p className="text-sm text-danger">{state.message}</p>;

  const download = (
    <a href={state.url} download={file.filename} className="text-xs text-tint underline-offset-4 hover:underline">
      Download {file.filename}
    </a>
  );

  return (
    <div className="grid gap-2 rounded-md border bg-background p-2">
      {view === "download" ? (
        <p className="text-sm text-muted-foreground">
          The browser cannot show {CANNOT_SHOW[file.format] ?? "this file"}. Download it, or open What was read to see
          the text and pages taken from it.
        </p>
      ) : null}
      {view === "image" ? (
        // A local blob of the upload, not a static asset: next/image would try to optimise it.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={state.url} alt={file.filename} className="max-h-[40rem] w-auto max-w-full rounded border" />
      ) : null}
      {view === "pdf" ? <iframe src={state.url} title={file.filename} className="h-[40rem] w-full rounded border" /> : null}
      {view === "markdown" && state.text !== null ? (
        <div className={`max-h-[40rem] overflow-y-auto ${MARKDOWN}`}>
          <Markdown
            remarkPlugins={[remarkGfm]}
            components={{
              // A link leaves the app in a new tab, without telling the other site where it came from.
              a: ({ href, children }) => (
                <a href={href} target="_blank" rel="noopener noreferrer">
                  {children}
                </a>
              ),
              // An image in a specification points to a file that was not uploaded with it, or to a
              // web address that would learn who opened this confidential file. Its text stays.
              img: ({ alt }) => <span className="text-muted-foreground">[image{alt ? `: ${alt}` : ""}]</span>,
            }}
          >
            {state.text}
          </Markdown>
        </div>
      ) : null}
      {(view === "text" || view === "json") && state.text !== null ? (
        <pre className="max-h-[40rem] overflow-auto font-mono text-xs whitespace-pre-wrap">{state.text}</pre>
      ) : null}
      {state.cut ? (
        <p className="text-xs text-muted-foreground">Only the beginning is shown here; the download has all of it.</p>
      ) : null}
      <div>{download}</div>
    </div>
  );
}
