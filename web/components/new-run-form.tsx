"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  ACCEPT,
  CASE_FILES_BUCKET,
  MAX_FILES,
  type UploadedFile,
  describeSize,
  formatOf,
  refusal,
  storagePath,
} from "@/lib/case-files";
import { createClient } from "@/lib/supabase/client";
import { TASK_MAX_LENGTH } from "@/lib/validation";

// The run's task is what the engineer types, with nothing added. What the agent does with it
// (find the UN Regulation requirements, cite regulation, version, page and paragraph) belongs in
// agent/agent_service/domain/prompt.md, so the instruction lives in one place.
//
// Case files (spec, exploded view, PDFs, Word, Excel, CAD) go from the browser straight to the
// private Storage bucket, as the signed-in user, and only their paths go to /api/runs. A Vercel
// function refuses request bodies over 4.5 MB, so one ordinary datasheet would not fit through
// the API (issue #8).

async function sha256(file: File): Promise<string | null> {
  // Recorded so a run can later be matched to the exact file it read. Optional: a browser
  // without SubtleCrypto (plain http on a LAN address) still uploads.
  if (!globalThis.crypto?.subtle) return null;
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function NewRunForm({ organizationId }: { organizationId: string }) {
  const router = useRouter();
  const [spec, setSpec] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const trimmed = spec.trim();
  const canStart = (trimmed !== "" || files.length > 0) && pending === null;

  function addFiles(list: FileList | null) {
    if (!list) return;
    const added: File[] = [];
    const problems: string[] = [];
    for (const file of Array.from(list)) {
      const reason = refusal(file);
      if (reason) problems.push(reason);
      else added.push(file);
    }
    const next = [...files, ...added];
    if (next.length > MAX_FILES) problems.push(`At most ${MAX_FILES} files per run.`);
    setFiles(next.slice(0, MAX_FILES));
    setError(problems.length ? problems.join(" ") : null);
  }

  async function upload(): Promise<UploadedFile[]> {
    const supabase = createClient();
    const uploadId = crypto.randomUUID();
    const uploaded: UploadedFile[] = [];
    for (const [index, file] of files.entries()) {
      setPending(`Uploading ${file.name} (${index + 1} of ${files.length})…`);
      const path = storagePath(organizationId, uploadId, index, file.name);
      const { error: uploadError } = await supabase.storage
        .from(CASE_FILES_BUCKET)
        .upload(path, file, { contentType: file.type || "application/octet-stream", upsert: false });
      if (uploadError) throw new Error(`${file.name} could not be uploaded: ${uploadError.message}`);
      uploaded.push({
        storage_path: path,
        filename: file.name,
        // refusal() let only known formats into the list.
        format: formatOf(file.name)!,
        media_type: file.type || null,
        bytes: file.size,
        sha256: await sha256(file),
      });
    }
    return uploaded;
  }

  async function startRun() {
    if (!canStart) return;
    setError(null);
    try {
      const uploaded = await upload();
      setPending("Starting…");
      const response = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task: trimmed, organization_id: organizationId, files: uploaded }),
      });
      const body: { id?: string; warning?: string; error?: string } = await response
        .json()
        .catch(() => ({}));
      if (!response.ok || !body.id) {
        setError(body.error ?? `The run could not be started (${response.status}).`);
        return;
      }
      setSpec("");
      setFiles([]);
      // With a warning the run exists but the agent never heard of it; the run page says so and
      // offers Send to agent.
      router.push(`/runs/${body.id}${body.warning ? "?agent=unreachable" : ""}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The run could not be started: the server did not answer.");
    } finally {
      setPending(null);
    }
  }

  return (
    <form
      className="grid gap-3 rounded-md border bg-card p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void startRun();
      }}
    >
      <div className="grid gap-1">
        <h2 className="text-sm font-semibold">Find the requirements for a product</h2>
        <p className="text-xs text-muted-foreground">
          Attach the case: specification, exploded view, datasheets, drawings, BOM or CAD files.
          The agent lists the requirements the product must fulfil under the UN Regulations, each
          with its regulation, page and paragraph.
        </p>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="case-files">Case files</Label>
        <input
          id="case-files"
          type="file"
          multiple
          accept={ACCEPT}
          className="text-xs"
          onChange={(event) => {
            addFiles(event.target.files);
            // Cleared so that choosing the same file again, after removing it, adds it back.
            event.target.value = "";
          }}
        />
        <p className="text-xs text-muted-foreground">
          .md .txt .csv .json, .png .jpg .webp, .pdf, .docx, .xlsx, CAD .step .iges .stl. Up to{" "}
          {MAX_FILES} files, 25 MB each. CAD files are read for part names and structure, not
          geometry.
        </p>
        {files.length > 0 ? (
          <ul className="grid gap-1 text-xs">
            {files.map((file, index) => (
              <li key={`${index}-${file.name}`} className="flex items-center gap-2">
                <span className="truncate font-mono">{file.name}</span>
                <span className="text-muted-foreground">{describeSize(file.size)}</span>
                <button
                  type="button"
                  className="ml-auto text-muted-foreground underline"
                  disabled={pending !== null}
                  onClick={() => setFiles(files.filter((_, i) => i !== index))}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="spec">Notes or pasted specification (optional with files)</Label>
        <Textarea
          id="spec"
          name="spec"
          rows={5}
          maxLength={TASK_MAX_LENGTH}
          placeholder="Anything the files do not say, or paste the specification here."
          className="max-h-96 font-mono text-xs"
          value={spec}
          onChange={(event) => setSpec(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void startRun();
            }
          }}
        />
      </div>

      <div className="flex items-center gap-2">
        {pending ? <span className="text-xs text-muted-foreground">{pending}</span> : null}
        <Button type="submit" className="ml-auto" disabled={!canStart}>
          {pending ? "Working…" : "Find requirements"}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </form>
  );
}
