"""A case's files parsed once and stored, parser first and a model only where it fails."""

from uuid import uuid4

import pytest
from pydantic_ai import BinaryContent

from agent_service import runner
from agent_service.domain import case_ingest
from tests.test_ingest import ANSWERS, LONG, pdf, png

pytestmark = pytest.mark.anyio

MODEL = "model:test-transcriber"


class FakeTranscriber:
    def __init__(self) -> None:
        self.seen: list[str] = []

    async def __call__(self, content: BinaryContent, what: str) -> str:
        self.seen.append(str(content.identifier))
        return f"Transcribed {content.identifier}"


async def ingest(store, case_id, transcribe=None, max_model_pages: int = 12) -> dict[str, int]:
    return await case_ingest.ingest_case(
        store, case_id, transcribe=transcribe, parser_name=MODEL, max_model_pages=max_model_pages
    )


async def test_text_is_parsed_once_and_stored_as_blocks(store) -> None:
    case_id = uuid4()
    file_id = store.add_case_file(case_id, "spec.md", "md", b"# Rear lamp\nM1")

    assert await ingest(store, case_id) == {"parsed": 1, "failed": 0}

    [block] = store.blocks[file_id]
    assert (block.kind, block.text, block.parser) == ("text", "# Rear lamp\nM1", "text")
    assert store.case_file(file_id).status == "parsed"
    # A second request finds nothing pending and parses nothing again.
    assert await ingest(store, case_id) == {"parsed": 0, "failed": 0}


async def test_a_drawing_page_is_rendered_stored_and_transcribed_by_the_model(store) -> None:
    case_id = uuid4()
    file_id = store.add_case_file(case_id, "sheet.pdf", "pdf", pdf([LONG, ""]))
    model = FakeTranscriber()

    await ingest(store, case_id, model)

    kinds = [(b.kind, b.page, b.parser) for b in store.blocks[file_id]]
    assert kinds == [
        ("text", 1, "pypdf"),
        ("image", 2, "pdfium-render"),
        ("text", 2, MODEL),
    ]
    image = store.blocks[file_id][1]
    assert image.image_path is not None and "/blocks/" in image.image_path
    assert image.image_path in store.objects
    assert model.seen == ["sheet.pdf, page 2"]


async def test_pictures_go_to_the_figure_model_and_a_broken_file_to_the_transcriber(
    store,
) -> None:
    # Admin's figure model reads every picture, the part's included (#52); the transcription
    # model keeps the files no parser can read.
    case_id = uuid4()
    sheet = store.add_case_file(case_id, "sheet.pdf", "pdf", pdf([LONG, ""]))
    broken = store.add_case_file(case_id, "broken.pdf", "pdf", b"%PDF-1.4 not really")
    transcriber, figures = FakeTranscriber(), FakeTranscriber()

    await case_ingest.ingest_case(
        store,
        case_id,
        transcribe=transcriber,
        parser_name=MODEL,
        describe=figures,
        describer_name="model:figures",
        max_model_pages=12,
    )

    assert figures.seen == ["sheet.pdf, page 2"]
    assert transcriber.seen == ["broken.pdf"]
    assert store.blocks[sheet][-1].parser == "model:figures"
    assert store.blocks[broken][0].parser == MODEL


async def test_a_file_the_parser_fails_on_goes_to_the_model_whole(store) -> None:
    case_id = uuid4()
    file_id = store.add_case_file(case_id, "broken.pdf", "pdf", b"%PDF-1.4 not really")
    model = FakeTranscriber()

    assert await ingest(store, case_id, model) == {"parsed": 1, "failed": 0}

    [block] = store.blocks[file_id]
    assert block.parser == MODEL and block.text == "Transcribed broken.pdf"
    assert any("Transcribed by" in n for n in store.case_file(file_id).notes)


async def test_without_a_model_a_failed_parse_is_a_failed_file_with_its_reason(store) -> None:
    case_id = uuid4()
    file_id = store.add_case_file(case_id, "broken.pdf", "pdf", b"not a pdf")

    assert await ingest(store, case_id) == {"parsed": 0, "failed": 1}

    assert (store.case_file(file_id).error or "").startswith("Could not be read")


async def test_the_model_is_asked_at_most_the_limit_per_file(store) -> None:
    case_id = uuid4()
    file_id = store.add_case_file(case_id, "scan.pdf", "pdf", pdf([""] * 4))
    model = FakeTranscriber()

    await ingest(store, case_id, model, max_model_pages=2)

    assert len(model.seen) == 2
    assert any("Not transcribed" in n for n in store.case_file(file_id).notes)


async def test_a_small_picture_is_stored_once_as_the_upload_itself(store) -> None:
    case_id = uuid4()
    file_id = store.add_case_file(case_id, "view.png", "png", png(400, 300))

    await ingest(store, case_id, FakeTranscriber())

    image, description = store.blocks[file_id]
    assert image.image_path == store.case_file(file_id).storage_path
    assert description.parser == MODEL


async def test_a_run_on_a_case_reads_the_stored_blocks_not_the_files(store, settings) -> None:
    case_id = uuid4()
    store.add_case_file(case_id, "spec.md", "md", b"Vehicle category M1.")
    pending = store.add_case_file(case_id, "late.pdf", "pdf", pdf([LONG]))
    await ingest(store, case_id)
    # Uploaded after the parse: the run starts without it, and says so.
    store.cases[case_id][1] = store.case_file(pending).model_copy(update={"status": "pending"})
    run_id = store.add_run("Find the requirements.", case_id=case_id)

    plan = await runner.prepare(store, settings, run_id)
    await runner.execute(store, settings, plan)

    spec, late = store.payloads(run_id, "case_file")
    assert spec["characters"] == len("Vehicle category M1.") and spec["error"] is None
    assert "Not parsed yet" in late["error"]
    saved = str(store.conversations[run_id])
    assert "Vehicle category M1." in saved
    assert "The rear lamp housing" not in saved


async def test_an_answer_key_in_a_part_is_never_read_by_a_run(store, settings) -> None:
    # Certivity's case folder holds expected.json beside the inputs (SYS-42).
    case_id = uuid4()
    key = store.add_case_file(case_id, "expected.json", "json", ANSWERS.encode())
    store.add_case_file(case_id, "spec.md", "md", b"Vehicle category M1.")

    assert await ingest(store, case_id, FakeTranscriber()) == {"parsed": 1, "failed": 1}
    assert "not given to the run" in (store.case_file(key).error or "")
    assert key not in store.blocks or store.blocks[key] == []

    run_id = store.add_run("Find the requirements.", case_id=case_id)
    plan = await runner.prepare(store, settings, run_id)
    await runner.execute(store, settings, plan)
    saved = str(store.conversations[run_id])
    assert "Vehicle category M1." in saved
    assert "The part shall be marked" not in saved


async def test_an_answer_key_stored_before_the_guard_is_not_read_either(store) -> None:
    case_id = uuid4()
    key = store.add_case_file(case_id, "expected.json", "json", b"{}")
    await ingest(store, case_id)
    # As a parse from before the guard left it: parsed, its text stored as a block.
    [block] = store.blocks[key]
    store.blocks[key] = [block.model_copy(update={"text": ANSWERS})]

    content = await case_ingest.case_content(store, case_id)

    assert "not given to the run" in (content.reports[0].error or "")
    assert "The part shall be marked" not in str(content.parts)


async def test_a_model_that_fails_leaves_the_parsed_file_parsed_and_says_why(store) -> None:
    case_id = uuid4()
    file_id = store.add_case_file(case_id, "sheet.pdf", "pdf", pdf([LONG, ""]))

    async def down(content: BinaryContent, what: str) -> str:
        raise RuntimeError("provider unreachable")

    assert await ingest(store, case_id, down) == {"parsed": 1, "failed": 0}

    assert [b.kind for b in store.blocks[file_id]] == ["text", "image"]
    assert any("transcription failed" in n for n in store.case_file(file_id).notes)
