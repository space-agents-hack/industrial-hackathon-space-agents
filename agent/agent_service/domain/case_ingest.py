"""Parse a case's files once, at upload, and store the result (ADR-0006; docs/se SYS-27, IF-1).

Parser first, model second (Clemente, 2026-10-24). The parsers in `ingest.py` read what has
structure: text, tables, PDF text layers, CAD headers. A small model is asked only for what they
cannot read:
- a file a parser fails on (a damaged PDF, an odd image), if the model can take its bytes;
- a PDF page with almost no text (a drawing, a scan), from the page rendered as an image;
- a picture, for a written description, so a run on a model without vision still has something.

Every block records who made it (`parser`), and a model's block is labelled as a transcription in
the run's message: a citation of it has to be checked against the source.

What this does NOT do: accept new formats. The allowlist stays (run_files and case_files check it);
a model cannot read .pptx or .zip bytes any better than we can.
"""

import asyncio
import hashlib
import logging
from collections.abc import Awaitable, Callable
from uuid import UUID

from pydantic_ai import Agent, BinaryContent

from agent_service.domain import ingest
from agent_service.records import CaseFile, CaseFileBlock
from agent_service.store import RunStore

log = logging.getLogger(__name__)

# What the model is told. Describe, do not conclude: the requirements step decides what applies.
# Why the drawing part: the first version asked only for labels, and an exploded view without
# callouts came back nearly empty, so whatever only the drawing shows (a component inside, how
# many of them) reached the requirements step as an image alone, which a model without vision or
# a writer skimming 20 images does not read.
_INSTRUCTIONS = """You transcribe engineering documents for a requirements engineer.
Write down what the image or document shows, faithfully and completely: all text, numbers, units,
part names, labels, callouts, table contents and title-block fields.
For a drawing, an exploded view or a photo, also describe what is drawn, even where nothing is
labelled: every distinct component you can see, how many of each, how they are arranged and
which sits in front of, behind or inside which (for example several identical small parts in a
row, a separate compartment, an opening in a cover, a connector or cable). Name a component by
what it visibly is; when you are not sure, describe its shape and say that you are not sure.
Do not add what is not shown: no materials, functions or regulations the image does not state.
If something is unreadable, write [unreadable]."""

# The model is given bytes it can read natively: images, and PDFs for providers that take them.
_MODEL_READS = {
    "png": "image/png",
    "jpeg": "image/jpeg",
    "webp": "image/webp",
    "pdf": "application/pdf",
}

Transcriber = Callable[[BinaryContent, str], Awaitable[str]]


def transcriber(model: object) -> Transcriber:
    """A function that sends one image or document to `model` and returns its transcription."""
    agent = Agent(output_type=str, instructions=_INSTRUCTIONS)

    async def transcribe(content: BinaryContent, what: str) -> str:
        result = await agent.run([what, content], model=model)  # pyright: ignore[reportArgumentType]
        return result.output

    return transcribe


async def ingest_case(
    store: RunStore,
    case_id: UUID,
    *,
    transcribe: Transcriber | None,
    parser_name: str,
    max_model_pages: int,
) -> dict[str, int]:
    """Parse every pending file of the case. Returns how many ended parsed and failed.

    A file is claimed (pending -> parsing) before it is read, so two requests for one case do not
    both parse it. A file left `parsing` by a request that died stays so; uploading it again is
    the way out, which is cheap compared with parsing everything twice by accident.
    """
    counts = {"parsed": 0, "failed": 0}
    for file in await store.case_files(case_id):
        if file.status != "pending":
            continue
        if not await store.set_case_file(file.id, "parsing", only_if="pending"):
            continue
        try:
            status = await _ingest_file(store, file, transcribe, parser_name, max_model_pages)
        except Exception as exc:
            log.exception("case file %s failed", file.id)
            await store.set_case_file(
                file.id, "failed", only_if="parsing", error=f"{type(exc).__name__}: {exc}"[:2000]
            )
            status = "failed"
        counts[status] += 1
    return counts


async def _ingest_file(
    store: RunStore,
    file: CaseFile,
    transcribe: Transcriber | None,
    parser_name: str,
    max_model_pages: int,
) -> str:
    fmt = ingest.format_of(f"x.{file.format}")
    if fmt is None:
        await store.set_case_file(
            file.id, "failed", only_if="parsing", error=f"No reader for {file.format!r}."
        )
        return "failed"
    data = await store.download(file.storage_path)
    notes: list[str] = []
    if file.sha256 and hashlib.sha256(data).hexdigest() != file.sha256:
        notes.append("The stored file differs from the one the browser hashed at upload.")

    # Parsing is CPU work; in a thread, so a long PDF does not stall other requests.
    parsed = await asyncio.to_thread(ingest.parse, ingest.CaseFile(file.filename, fmt, data))
    notes += parsed.report.notes
    blocks: list[ingest.Block] = list(parsed.blocks)
    model_pages = 0

    if parsed.report.error is not None:
        # The parser gave up on the whole file. The model gets the file itself if it can read it.
        media_type = _MODEL_READS.get(fmt)
        if transcribe is None or media_type is None:
            await store.set_case_file(
                file.id, "failed", only_if="parsing", notes=notes, error=parsed.report.error
            )
            return "failed"
        try:
            text = await transcribe(
                BinaryContent(data, media_type=media_type, identifier=file.filename),
                f"Transcribe this file: {file.filename}",
            )
        except Exception as exc:
            error = f"{parsed.report.error} The model could not read it either: {_why(exc)}"
            await store.set_case_file(
                file.id, "failed", only_if="parsing", notes=notes, error=error[:2000]
            )
            return "failed"
        blocks = [ingest.Block(text, "transcription", None, parser_name)]
        notes.append(f"{parsed.report.error} Transcribed by {parser_name} instead.")
        model_pages = 1

    rows: list[CaseFileBlock] = []
    left_untranscribed: list[str] = []
    for block in blocks:
        content = block.content
        if isinstance(content, ingest.PdfPage):
            content = await asyncio.to_thread(ingest.render, content)
        if isinstance(content, str):
            rows.append(_text_row(file, len(rows), block, content))
            continue
        # An image: store it, then ask the model what it shows.
        if block.parser == "pillow" and content.data == data:
            path = file.storage_path  # the upload itself, already small enough; no copy
        else:
            path = f"{file.organization_id}/{file.case_id}/blocks/{file.id}/{len(rows)}"
            await store.upload(path, content.data, content.media_type)
        rows.append(
            CaseFileBlock(
                file_id=file.id,
                seq=len(rows),
                kind="image",
                page=block.page,
                label=block.label,
                image_path=path,
                media_type=content.media_type,
                parser=block.parser,
            )
        )
        if transcribe is None:
            continue
        if model_pages >= max_model_pages:
            left_untranscribed.append(block.label or "image")
            continue
        model_pages += 1
        what = f"{file.filename}, {block.label}" if block.label else file.filename
        try:
            text = await transcribe(
                BinaryContent(content.data, media_type=content.media_type, identifier=what),
                f"Transcribe this image from {what}.",
            )
        except Exception as exc:
            # The image is stored and still reaches a vision model in a run; only the written
            # transcription is missing. Not a reason to fail a file the parser read.
            notes.append(f"{block.label or 'Image'}: model transcription failed: {_why(exc)}")
            continue
        rows.append(
            _text_row(
                file, len(rows), ingest.Block(text, block.label, block.page, parser_name), text
            )
        )

    if transcribe is None and any(r.kind == "image" for r in rows):
        notes.append("No model configured for transcription; images are stored but not described.")
    if left_untranscribed:
        notes.append(
            f"Not transcribed (limit of {max_model_pages} per file): "
            f"{', '.join(left_untranscribed)}."
        )
    await store.replace_blocks(file.id, file.organization_id, rows)
    await store.set_case_file(
        file.id, "parsed", only_if="parsing", notes=notes, pages=parsed.report.pages
    )
    return "parsed"


def _why(exc: Exception) -> str:
    return f"{type(exc).__name__}: {exc}"[:300]


def _text_row(file: CaseFile, seq: int, block: ingest.Block, text: str) -> CaseFileBlock:
    return CaseFileBlock(
        file_id=file.id,
        seq=seq,
        kind="text",
        page=block.page,
        label=block.label,
        text=text,
        parser=block.parser,
    )


async def case_content(store: RunStore, case_id: UUID) -> ingest.CaseContent:
    """The stored blocks of a case, as the parts of a run's first message. Files not parsed yet,
    or failed, are reported so the run's trace says the agent did not have them."""
    files = await store.case_files(case_id)
    blocks = await store.case_blocks(case_id)
    by_file: dict[UUID, list[CaseFileBlock]] = {}
    for b in blocks:
        by_file.setdefault(b.file_id, []).append(b)

    parsed_files: list[ingest.ParsedFile] = []
    for f in files:
        report = ingest.FileReport(
            f.filename, f.format, f.bytes, pages=f.pages, notes=list(f.notes)
        )
        out: list[ingest.Block] = []
        if f.status != "parsed":
            # Blocks of a file being re-parsed may be half written; none is better than half.
            report.error = f.error or f"Not parsed yet ({f.status}); not given to the agent."
            parsed_files.append(ingest.ParsedFile(f.filename, f.format, report, out))
            continue
        for b in by_file.get(f.id, []):
            if b.kind == "text" and b.text is not None:
                out.append(ingest.Block(b.text, b.label, b.page, b.parser))
            elif b.image_path is not None:
                data = await store.download(b.image_path)
                media_type = b.media_type or "image/png"
                out.append(
                    ingest.Block(ingest.ImageData(data, media_type), b.label, b.page, b.parser)
                )
        parsed_files.append(ingest.ParsedFile(f.filename, f.format, report, out))
    return ingest.assemble(parsed_files)
