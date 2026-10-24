"""Splitting a regulation PDF into paragraphs with their pages. The PDF is a made-up regulation
rendered the way the challenge's PDFs were (tests/fixtures/regulation/sample.html); the real ones
are confidential and stay out of the repo. How the splitter scores on them is in #3."""

import hashlib
import io
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pypdfium2 as pdfium
import pytest

from agent_service.domain.paragraphs import Extraction, ExtractionProblem, Paragraph, extract

SAMPLE = Path(__file__).parent / "fixtures" / "regulation" / "sample.pdf"


@pytest.fixture(scope="module")
def sample() -> Extraction:
    return extract(SAMPLE.read_bytes())


def by_label(extraction: Extraction, label: str) -> Paragraph:
    [paragraph] = [p for p in extraction.paragraphs if p.label == label]
    return paragraph


def test_every_numbered_paragraph_gets_the_label_a_submission_cites(sample: Extraction) -> None:
    assert [p.label for p in sample.paragraphs] == [
        None,  # the introduction, before any number
        "1",
        "1.1",
        "1.2",
        "1.2.1",
        "1.2.3",  # 1.2.2 was deleted; the gap is kept, not filled
        "2",
        "2.1",
        "2.2",
        "5",
        "5.1",
        "5.1.1",
        "5.1.2",
        "5.2",
        "6",
        "6.1",
        "Annex 1",  # the annex's own text before its first number
        "Annex 1 1",
        "Annex 1 2",
        "Annex 2 Part 1 1",
        "Annex 2 Part 1 1.1",
        "Annex 2 Part 1 2",
        "Annex 2 Part 2 1",
        "Annex 2 Appendix 1 1",
        "Annex 9K 1",  # printed "Annex 9 K"
    ]


def test_the_document_order_is_kept(sample: Extraction) -> None:
    assert [p.position for p in sample.paragraphs] == list(range(len(sample.paragraphs)))


def test_a_paragraph_that_runs_over_a_page_break_keeps_both_pages(sample: Extraction) -> None:
    long = by_label(sample, "5.1.2")
    assert (long.page_start, long.page_end) == (1, 2)
    assert "Point 30 at 29 degrees" in long.text
    # The table after it belongs to it: its rows are not paragraphs "1" and "2".
    assert "Maximum intensity 30 cd" in long.text


def test_pages_are_the_pdf_pages_and_the_footer_is_read_not_kept(sample: Extraction) -> None:
    assert sample.page_count == 3
    assert sample.version_label == "2.1.0"
    assert by_label(sample, "Annex 9K 1").page_start == 3
    assert not any("page 1 of 3" in p.text for p in sample.paragraphs)


def test_a_reference_that_wraps_to_the_start_of_a_line_is_not_a_new_paragraph(
    sample: Extraction,
) -> None:
    text = by_label(sample, "5.1.1").text
    # "paragraph\n5.3. of this Regulation" and "UN Regulation No.\n149. Lamps ...".
    assert "5.3. of this Regulation" in text
    assert "149. Lamps of category T are measured once." in text
    assert not any(p.label in ("5.3", "149") for p in sample.paragraphs)


def test_footnotes_and_the_banner_are_left_out(sample: Extraction) -> None:
    everything = "\n".join(p.text for p in sample.paragraphs)
    assert "As defined in the Consolidated Resolution" not in everything
    assert "rendered by Certivity" not in everything


def test_the_heading_names_what_a_paragraph_is_about(sample: Extraction) -> None:
    assert by_label(sample, "5.1.1").heading == "5. Specifications > 5.1. Photometric requirements"
    assert by_label(sample, "Annex 2 Part 1 1.1").heading == (
        "Annex 2 Test procedures > Part 1 - Resistance to heat > 1. Test procedure"
    )
    # The introduction is not a title above the regulation's text.
    assert by_label(sample, "1.1").heading == "1. Scope"


def test_annex_part_and_appendix_are_also_columns(sample: Extraction) -> None:
    p = by_label(sample, "Annex 2 Part 1 1.1")
    assert (p.annex, p.part, p.appendix, p.number, p.kind) == ("2", "1", None, "1.1", "paragraph")
    q = by_label(sample, "Annex 2 Appendix 1 1")
    assert (q.annex, q.part, q.appendix) == ("2", None, "1")


def test_the_content_hash_is_of_the_text(sample: Extraction) -> None:
    p = by_label(sample, "2.1")
    assert p.text == '2.1. "Test lamp" means a lamp that is tested.'
    assert p.content_hash == hashlib.sha256(p.text.encode()).hexdigest()


def test_the_sample_needs_no_warnings(sample: Extraction) -> None:
    assert sample.warnings == []


def test_a_file_that_is_not_a_pdf_is_refused() -> None:
    with pytest.raises(ExtractionProblem, match="could not be opened"):
        extract(b"%PDF-1.7\nnot really")


def test_a_pdf_without_a_text_layer_is_refused() -> None:
    blank = pdfium.PdfDocument.new()
    for _ in range(2):
        blank.new_page(595, 842)
    buffer = io.BytesIO()
    blank.save(buffer)
    with pytest.raises(ExtractionProblem, match="no text layer"):
        extract(buffer.getvalue())


def test_pdfs_read_in_threads_take_turns_in_pdfium(monkeypatch: pytest.MonkeyPatch) -> None:
    # pdfium is not thread-safe: a sub-goal run read old.pdf and new.pdf in two threads and the
    # agent process died with no error (2026-10-24, agent_service/pdf_lock.py). Every caller that
    # reads PDFs in threads (sub-goal, imports, changes) goes through extract, so that is where
    # the turns are taken.
    active, peak = 0, 0
    real = pdfium.PdfDocument

    def counted(*args: object, **kwargs: object) -> pdfium.PdfDocument:
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        time.sleep(0.02)  # long enough for another thread to try to open its own
        active -= 1
        return real(*args, **kwargs)  # pyright: ignore[reportArgumentType]

    monkeypatch.setattr(pdfium, "PdfDocument", counted)
    data = SAMPLE.read_bytes()
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(extract, [data] * 4))
    assert peak == 1
    assert len({len(r.paragraphs) for r in results}) == 1
