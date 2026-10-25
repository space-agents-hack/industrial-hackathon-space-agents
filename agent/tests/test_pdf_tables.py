"""Bordered tables read as rows under their headers (#52). The PDF is a made-up regulation
rendered by headless Chrome like the challenge's PDFs (tests/fixtures/regulation/tables.html).
How the reader does on the real ones is on #52: 2,464 tables, every label and page unchanged."""

from pathlib import Path

import pytest

from agent_service.domain.paragraphs import EXTRACTOR, Extraction, extract

TABLES = Path(__file__).parent / "fixtures" / "regulation" / "tables.pdf"


@pytest.fixture(scope="module")
def tables() -> Extraction:
    return extract(TABLES.read_bytes())


def text(extraction: Extraction, label: str) -> list[str]:
    [paragraph] = [p for p in extraction.paragraphs if p.label == label]
    return paragraph.text.splitlines()


def test_each_row_is_one_line_with_its_column_headers(tables: Extraction) -> None:
    # A wrapped cell stays in its row, merged header cells name every column under them, a
    # reference over two rows is repeated in both, and empty cells are left out.
    assert text(tables, "5.1")[2:] == [
        "Reference: Annex 2; Test: Heat: 48 h at 65 °C visual inspection; "
        "Samples a: x x; Samples b: x x",
        "Reference: 5.3.; Test: Colour; Samples a: x; Samples c: x",
        "Reference: 5.3.; Test: Photometry; Samples b: x; Samples c: x",
    ]


def test_the_caption_above_the_table_stays_above_its_rows(tables: Extraction) -> None:
    assert text(tables, "5.1")[:2] == [
        "5.1. The tests shall be made in the following order:",
        "Table 1 Order of tests",
    ]


def test_a_cell_that_starts_with_a_number_does_not_start_a_paragraph(
    tables: Extraction,
) -> None:
    # "5.3." in the Reference column would follow 5.2 as the next paragraph if it were text.
    labels = [p.label for p in tables.paragraphs]
    assert labels == ["1", "1.1", "5", "5.1", "5.2", "5.3", "5.4", "5.5", "5.6", "5.7"]


def test_a_title_across_the_whole_table_is_written_once(tables: Extraction) -> None:
    assert text(tables, "5.2")[1:] == [
        "Limits expressed in cd",
        "Point: HV; Minimum: 0.3; Maximum: 30",
        "Point: 10 U; Minimum: 0.1; Maximum: 5",
    ]


def test_a_long_table_gives_its_headers_once_and_keeps_empty_cells(tables: Extraction) -> None:
    lines = text(tables, "5.3")
    assert lines[1] == "Time s; Speed per cent"
    assert lines[2] == "1; 0"
    # The empty cell keeps its place, so 81 is still read as row 15's speed.
    assert lines[15:17] == ["14; ", "15; 81"]
    assert len(lines) == 2 + 22


def test_up_to_twenty_rows_every_value_keeps_its_column_name(tables: Extraction) -> None:
    lines = text(tables, "5.6")
    assert lines[1] == "No.: 1; Point: Point P01"
    assert len(lines) == 1 + 18


def test_a_table_without_borders_stays_as_lines(tables: Extraction) -> None:
    assert text(tables, "5.4")[1:] == ["Red R", "Amber A"]


def test_headers_over_empty_cells_are_kept(tables: Extraction) -> None:
    # A form left for the manufacturer: no row has a value, the headers are still the content.
    assert text(tables, "5.5")[1:] == ["Rear (m); Front (m)"]


def test_the_extractor_version_says_tables_are_read() -> None:
    # Bumped so every stored version is split again (regulations.py, `EXTRACTOR`).
    assert EXTRACTOR == "paragraphs-2"


def test_pages_are_unchanged_by_reading_tables(tables: Extraction) -> None:
    pages = {p.label: (p.page_start, p.page_end) for p in tables.paragraphs}
    assert pages["5.3"] == (1, 1)
    assert pages["5.4"] == (2, 2)
