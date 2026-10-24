"""Split a regulation PDF into numbered paragraphs with their pages (docs/regulations-store.md, #3).

A submission cites `regulation`, `version`, `page` and optionally `paragraph`, and the platform
scores the full page range of each expected paragraph. So each paragraph here carries the label a
submission would write ("Annex 6 Part 1 3", "5.1.4.4.1") and the first and last PDF page its text
is on. The page is the PDF page index counted from 1; in the challenge's PDFs it equals the `n` of
the footer `UN R150, version 1.2.1 | page n of N`, and `extract` checks that on every page.

How it reads the PDF. The challenge's PDFs were rendered from HTML by headless Chrome, so they have
a real text layer and the HTML's styles survive as font sizes and weights:

  body text    the size most characters are set in (14 pt)
  headings     about 1.2 x body (17.3 pt): "1. Scope", "Annex 6 Environmental Testing",
               "Annex 9K - Appendix 1 ...". A long one wraps onto a second heading line.
  bold body    "Part 1 - Resistance to heat" inside an annex, but also table headers
  tables       smaller than body (12.7 pt); footnotes smaller still (9.4 pt)

A paragraph starts at a body or heading line that begins with a number ("5.6.1.1.1. The system
...", "7.1.1.5 The tibia ..."). Wrapped text also starts lines with numbers ("paragraph\\n5.1.3.2.2.
of this Regulation"), so a number is accepted only if it can follow the previous paragraph: its
parent must be on the current path (after 5.6.1.1.4 come 5.6.1.1.5, 5.6.1.2, 5.7 or 6, never
5.1.3.2.2), it must come later, and it may skip at most a few numbers: deleted paragraphs leave
gaps (1.2.2, 1.2.4), a wrapped "No.\n149." does not.

Numbering restarts in every annex, appendix and part, which is why the label carries them.

Measured on the challenge's 92 PDFs and the sub-goal's two on 2026-10-24 (see "Extraction" in
docs/regulations-store.md): 17 s for 5,532 pages, and every (regulation, version, page,
paragraph) cited by the dev case and the sub-goal is found with its page inside the paragraph's
range, except the two that cite a table ("5.1.4.4.1. Table 3"), whose paragraph is found under its
plain label.

What this does NOT do:
  - split tables out of their paragraph. A table's text stays in the paragraph it follows, so its
    pages count for that paragraph; a citation "5.1.4.4.1. Table 3" finds "5.1.4.4.1".
  - read text inside pictures (no OCR), or keep the pictures.
  - work on scanned PDFs. A PDF without a text layer raises ExtractionProblem.
  - understand other layouts. A PDF from another source still gets paragraphs if it numbers them
    the UNECE way, but annex and part headings are recognised by their size and weight.
"""

import hashlib
import re
from collections import Counter
from dataclasses import dataclass, field, replace
from typing import Literal

from agent_service.pdf_lock import PDFIUM

# Stored with each version's paragraphs. Changing how paragraphs are split means changing this, so
# the import extracts every version again instead of keeping paragraphs cut the old way.
EXTRACTOR = "paragraphs-1"

Kind = Literal["paragraph", "text"]


@dataclass(frozen=True)
class Paragraph:
    position: int
    # What a submission cites: "5.4.2.3", "Annex 3 1.2", "Annex 4 Part 1 1.2",
    # "Annex 1 Part 1 Appendix 2 3". None only for text before the first numbered paragraph of the
    # document (an introduction).
    label: str | None
    annex: str | None
    appendix: str | None
    part: str | None
    # "5.4.2.3", without the dot the regulation prints after it. None for unnumbered text.
    number: str | None
    # The titles above this paragraph: "Annex 6 Environmental Testing > Part 1 - Resistance to
    # heat", "5. Specific technical requirements > 5.1. Retro-reflectors". What makes "shall not
    # exceed 30 cd" findable by what it applies to.
    heading: str
    # "paragraph": numbered. "text": the unnumbered text under a heading (an introduction, an
    # annex's communication form) before its first numbered paragraph.
    kind: Kind
    # As printed, number included, lines joined with newlines, footers and footnotes removed.
    text: str
    page_start: int
    page_end: int

    @property
    def content_hash(self) -> str:
        # Of the text alone: equal in base and latest means the paragraph did not change, which is
        # what the sub-goal's diff and the embeddings (one per distinct text) both rely on.
        return hashlib.sha256(self.text.encode()).hexdigest()


@dataclass(frozen=True)
class Extraction:
    page_count: int
    # From the page footers ("version 1.2.1"). None if the PDF has none.
    version_label: str | None
    paragraphs: list[Paragraph]
    # Things a person should look at, none of which stopped the extraction.
    warnings: list[str] = field(default_factory=list)


class ExtractionProblem(Exception):
    """The PDF cannot be split. The message is for the person who imported it."""


# ------------------------------------------------------------------------------------------
# Lines with their style
# ------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class _Line:
    page: int
    text: str
    size: float
    bold: bool


_FOOTER = re.compile(
    r"^(?P<doc>.+?), version (?P<version>\S+) \| page (?P<page>\d+) of (?P<of>\d+)$"
)
# Certivity's banner on the first page of every PDF. Not regulation text, and it would otherwise
# become part of the introduction.
_BANNER = re.compile(
    r"^(Consolidated text of this version|the bottom of every page|Role in the hackathon:)"
)
# Chrome writes a hyphen that falls at a line break as U+FFFE in the text layer.
_BROKEN_HYPHEN = "￾"


def _read_lines(data: bytes) -> tuple[list[_Line], int, list[str], list[str]]:
    """(lines, page count, footer version labels, warnings), footers removed."""
    # pdfium is not thread-safe, and callers read PDFs in threads (agent_service/pdf_lock.py).
    with PDFIUM:
        return _read_lines_alone(data)


def _read_lines_alone(data: bytes) -> tuple[list[_Line], int, list[str], list[str]]:
    import pypdfium2 as pdfium
    import pypdfium2.raw as pdfium_c

    try:
        pdf = pdfium.PdfDocument(data)
    except pdfium.PdfiumError as exc:
        raise ExtractionProblem(f"The file could not be opened as a PDF ({exc}).") from None
    lines: list[_Line] = []
    versions: list[str] = []
    warnings: list[str] = []
    empty = 0
    try:
        page_count = len(pdf)
        for index in range(page_count):
            number = index + 1
            page = pdf[index]
            textpage = page.get_textpage()
            try:
                raw = textpage.get_text_range()
                if not raw.strip():
                    empty += 1
                    continue
                page_lines: list[_Line] = []
                offset = 0
                for text in raw.split("\r\n"):
                    start = offset
                    offset += len(text) + 2
                    stripped = text.replace(_BROKEN_HYPHEN, "-").strip()
                    if not stripped:
                        continue
                    # Style of the first visible character: the line's own, not a superscript's.
                    lead = start + (len(text) - len(text.lstrip()))
                    size = pdfium_c.FPDFText_GetFontSize(textpage.raw, lead)
                    weight = pdfium_c.FPDFText_GetFontWeight(textpage.raw, lead)
                    page_lines.append(_Line(number, stripped, round(size, 1), weight >= 700))
                # The footer comes first in the text layer of the challenge's PDFs and last in
                # other renders of the same kind; it is never part of a paragraph.
                for edge in {0, len(page_lines) - 1}:
                    footer = _FOOTER.match(page_lines[edge].text) if page_lines else None
                    if footer is None:
                        continue
                    versions.append(footer["version"])
                    if int(footer["page"]) != number or int(footer["of"]) != page_count:
                        warnings.append(
                            f"Page {number}: the footer says page {footer['page']} of "
                            f"{footer['of']}; the PDF page index is used."
                        )
                    page_lines[edge] = replace(page_lines[edge], text="")
                lines += [line for line in page_lines if line.text]
            finally:
                textpage.close()
                page.close()
    finally:
        pdf.close()
    if page_count == 0:
        raise ExtractionProblem("The PDF has no pages.")
    if empty > page_count / 2:
        raise ExtractionProblem(
            f"{empty} of {page_count} pages have no text layer; scanned PDFs are not supported."
        )
    if empty:
        warnings.append(f"{empty} page(s) have no text.")
    return lines, page_count, versions, warnings


# ------------------------------------------------------------------------------------------
# Splitting
# ------------------------------------------------------------------------------------------

# "5.6.1.1.1. The", "7.1.1.5 The", "1. Scope", "A.8.1.1. System" (R49's appendices put a letter
# before the number) and "6.3.6.1.2.2.The" (R48 drops the space once). Groups: the letter, the
# number without its dot, and the dot in either of its two places.
_NUMBERED = re.compile(
    r"^(?:([A-Z])\.)?(\d{1,3}(?:\.\d{1,3})*)(?:(\.)(?=[A-Z\"'(])|(\.?)(?:\s+|$))"
)
# "Annex 9K", also printed "Annex 9 K Fire resistance" (R100); roman numerals in some regulations.
_ANNEX = re.compile(
    r"^annex\s+(\d{1,3}(?:\s?[A-Z](?=[\s.:\-\u2010-\u2014]|$))?|[IVX]{1,5})\b\.?", re.IGNORECASE
)
# R3 prints Annex 13 as "Annex 1 3 RESISTANCE TO IMPACT": the second digit, if it makes the next
# annex.
_ANNEX_SPLIT_DIGIT = re.compile(r"^\s(\d)\b")
_APPENDIX = re.compile(r"\bappendix\b\s*(\d{1,3}[A-Z]?)?", re.IGNORECASE)
_PART = re.compile(r"\bpart\s+(\d{1,3}[A-Z]?|[IVX]{1,5}|[A-Z])\b", re.IGNORECASE)
_PART_HEADING = re.compile(r"^part\s+(\d{1,3}[A-Z]?|[IVX]{1,5}|[A-Z])\b", re.IGNORECASE)
# "Part 1 - Resistance to heat" in body type is a part heading even when the PDF does not say the
# font is bold (pdfium reads the weight from the font, and not every font declares it).
_PART_TITLE = re.compile(
    r"^part\s+(\d{1,3}[A-Z]?|[IVX]{1,5}|[A-Z])\s*[-\u2010-\u2014]\s", re.IGNORECASE
)
_APPENDIX_HEADING = re.compile(r"^appendix\b\s*(\d{1,3}[A-Z]?)?", re.IGNORECASE)
# A line that ends like this goes on with a reference: "the requirements specified in paragraph\n8."
# (GTR 9) or "UN Regulation No.\n149." (R48). The number at the start of the next line is not a new
# paragraph.
_REFERENCE_BEFORE = re.compile(
    r"(\bparagraphs?|\bpara\.|\bannex|\bappendix|\bitem|\bno\.|\band|\bor|\bto|\bof|\bin|\bsee)$",
    re.IGNORECASE,
)
# How far a number may jump from the sibling before it. Deleted paragraphs leave gaps of one or
# two (R79 goes from 1.2.2 to 1.2.4); a jump of 143 was a wrapped reference ("No.\n149.") that
# swallowed 50 pages of R48.
_MAX_GAP = 5
# "I. Statement of technical rationale", "B. Text of the Regulation": a part of the whole document.
_DOCUMENT_PART = re.compile(r"^([IVX]{1,5}|[A-Z])\.\s")
# A title is short and not a sentence. Longer first lines are the start of a requirement.
_MAX_TITLE = 90

_Key = tuple[str | None, tuple[int, ...]]


@dataclass
class _Open:
    """The paragraph being read."""

    label: str | None
    annex: str | None
    appendix: str | None
    part: str | None
    number: str | None
    heading: str
    kind: Kind
    section: str | None
    lines: list[str]
    page_start: int
    page_end: int


class _Splitter:
    def __init__(self, body_size: float) -> None:
        self.body = body_size
        self.done: list[_Open] = []
        self.annex: str | None = None
        # "" for an appendix without a number ("Annex 1 - Appendix").
        self.appendix: str | None = None
        self.part: str | None = None
        # Which holds which: R107's "Annex 1 - Part 1 - Appendix 1" has appendices in parts, R164's
        # Annex 3 Appendix 1 has parts in the appendix. The label follows the document.
        self.part_in_appendix = False
        # An unnumbered heading outside the annexes ("Introduction", "I. Statement of technical
        # rationale"). Only used to tell apart two paragraphs with the same number (see finish).
        self.section: str | None = None
        # Titles of the containers: the annex heading, then the part's or the appendix's.
        self.container_titles: list[str] = []
        # Where the numbering is: the letter before it (R49's "A.8.1") and the last number.
        self.prefix: str | None = None
        self.path: tuple[int, ...] = ()
        # Titles of numbered paragraphs in the current container, for the headings below them.
        self.titles: dict[_Key, str] = {}
        # Whether the regulation's own text has started with a numbered heading ("1. Scope"). From
        # then on, a top-level number outside the annexes is a heading, and "1." in body text is a
        # list item (R43's introduction lists "1. Manual operation ..." inside 0.1.2).
        self.headed = False
        self.open: _Open | None = None
        self.last_was_heading = False

    # Style classes, relative to the body size so another renderer's scale still works.

    def is_heading(self, line: _Line) -> bool:
        return 1.1 * self.body <= line.size < 1.45 * self.body

    def is_title(self, line: _Line) -> bool:
        return line.size >= 1.45 * self.body

    def is_body(self, line: _Line) -> bool:
        return abs(line.size - self.body) <= 0.05 * self.body

    def is_footnote(self, line: _Line) -> bool:
        return line.size < 0.72 * self.body

    def container(self) -> str:
        """The label of the container: "Annex 4 Part 1", "Annex 1 Part 1 Appendix 2", or ""."""
        levels = []
        if self.annex is not None:
            levels.append(f"Annex {self.annex}")
        if self.part is not None:
            levels.append(f"Part {self.part}")
        if self.appendix is not None:
            appendix = f"Appendix {self.appendix}".strip()
            levels.insert(1 if self.part_in_appendix else len(levels), appendix)
        return " ".join(levels)

    def feed(self, line: _Line) -> None:
        heading = self.last_was_heading
        self.last_was_heading = False
        if self.is_title(line) or self.is_footnote(line):
            return
        if line.page == 1 and not self.done and self.open is None and _BANNER.match(line.text):
            return
        if self.is_heading(line):
            self.last_was_heading = True
            self.heading_line(line, after_heading=heading)
            return
        part = _PART_HEADING.match(line.text) if line.bold else _PART_TITLE.match(line.text)
        if self.is_body(line) and part and self.annex is not None:
            # Parts inside an appendix stay in it (R164 Annex 3 Appendix 1 has Parts 1 to 3).
            self.enter(annex=self.annex, part=part[1], appendix=self.appendix, title=line.text,
                       page=line.page, keep_annex_title=True,
                       part_in_appendix=self.appendix is not None)  # fmt: skip
            return
        if self.is_body(line) and self.try_number(line, heading=False):
            return
        self.append(line)

    def heading_line(self, line: _Line, *, after_heading: bool) -> None:
        text = line.text
        annex = _ANNEX.match(text)
        appendix = _APPENDIX_HEADING.match(text)
        part = _PART_HEADING.match(text)
        if annex:
            name = annex[1].replace(" ", "")
            name = name if name[0].isdigit() else name.upper()
            rest = text[annex.end() :]
            split = _ANNEX_SPLIT_DIGIT.match(rest)
            if (
                split
                and name.isdigit()
                and self.annex
                and self.annex.isdigit()
                and int(name + split[1]) == int(self.annex) + 1
            ):
                name, rest = name + split[1], rest[split.end() :]
            part_in = _PART.search(rest)
            appendix_in = _APPENDIX.search(rest)
            self.enter(
                annex=name,
                part=part_in[1] if part_in else None,
                appendix=(appendix_in[1] or "") if appendix_in else None,
                title=text,
                page=line.page,
                part_in_appendix=bool(
                    part_in and appendix_in and appendix_in.start() < part_in.start()
                ),
            )
        elif appendix:
            self.enter(annex=self.annex, part=self.part, appendix=appendix[1] or "", title=text,
                       page=line.page, keep_annex_title=self.annex is not None)  # fmt: skip
        elif part and self.annex is not None:
            self.enter(annex=self.annex, part=part[1], appendix=None, title=text,
                       page=line.page, keep_annex_title=True)  # fmt: skip
        elif self.try_number(line, heading=True):
            pass
        elif after_heading:
            self.continue_heading(line)
        else:
            # An unnumbered heading ("Introduction", "I. Statement of technical rationale"):
            # the text under it is one unnumbered block, and numbering starts again below it.
            self.close()
            if self.annex is None:
                self.section = text
                self.container_titles = [text]
            else:
                self.container_titles = [*self.container_titles[:1], text]
            self.prefix, self.path, self.titles = None, (), {}
            self.start(None, None, "text", [], line.page)

    def continue_heading(self, line: _Line) -> None:
        # A heading that wrapped: the second line belongs to the title above it.
        current = self.open
        if current is not None and current.number is not None and len(current.lines) == 1:
            current.lines[0] += " " + line.text
            current.page_end = line.page
            key = (self.prefix, self.path)
            if key in self.titles:
                self.titles[key] += " " + line.text
        elif self.container_titles:
            self.container_titles[-1] += " " + line.text
            if current is not None and current.number is None and not current.lines:
                current.heading = " > ".join(self.container_titles)
            if current is not None and current.section is not None and self.annex is None:
                self.section = current.section = self.container_titles[-1]

    def enter(
        self,
        *,
        annex: str | None,
        part: str | None,
        appendix: str | None,
        title: str,
        page: int,
        keep_annex_title: bool = False,
        part_in_appendix: bool = False,
    ) -> None:
        self.close()
        self.annex, self.part, self.appendix = annex, part, appendix
        self.part_in_appendix = part_in_appendix
        self.container_titles = [*self.container_titles[:1], title] if keep_annex_title else [title]
        self.prefix, self.path, self.titles = None, (), {}
        # The container's own text before its first numbered paragraph (a form, a caption).
        self.start(None, None, "text", [], page)

    def try_number(self, line: _Line, *, heading: bool) -> bool:
        match = _NUMBERED.match(line.text)
        if not match:
            return False
        prefix = match[1]
        number = tuple(int(n) for n in match[2].split("."))
        rest = line.text[match.end() :]
        main_text = self.annex is None and self.appendix is None
        if main_text and len(number) == 1 and prefix is None:
            if heading:
                self.headed = True
            elif self.headed:
                return False
        # "1. Scope" ends an introduction: it is not a title above the regulation's text. A part
        # of the document ("II. Text of the Regulation" in GTR 9) is, and stays.
        if (
            main_text
            and heading
            and number == (1,)
            and prefix is None
            and self.section is not None
            and not _DOCUMENT_PART.match(self.section)
        ):
            self.section = None
            self.container_titles = []
        if not self.acceptable(prefix, number, has_dot=bool(match[3] or match[4]), rest=rest):
            # "1. Scope" after an introduction that numbers its own paragraphs (R171): the
            # regulation's text starts here and its numbering with it.
            if not (heading and number == (1,) and prefix is None):
                return False
            if self.annex is None:
                self.section = None
            self.titles = {}
        self.close()
        self.prefix, self.path = prefix, number
        printed = (f"{prefix}." if prefix else "") + ".".join(str(n) for n in number)
        if heading or _is_title(rest):
            self.titles[(prefix, number)] = f"{printed}. {rest}".strip()
        self.start(printed, (prefix, number), "paragraph", [line.text], line.page)
        return True

    def acceptable(
        self, prefix: str | None, number: tuple[int, ...], *, has_dot: bool, rest: str
    ) -> bool:
        if rest[:1].islower():
            # "5.1.3.2.2. of this Regulation": a reference that wrapped to the start of a line.
            return False
        current = self.open
        if current is not None and current.lines and _REFERENCE_BEFORE.search(current.lines[-1]):
            return False
        if not has_dot and len(number) == 1:
            # "2 ground plane" in a figure legend. A bare top-level number only counts as the
            # next one in sequence.
            expected = (self.path[0] + 1,) if self.path else (1,)
            if number != expected:
                return False
        if not self.path:
            return True
        if prefix != self.prefix:
            return False
        parent = number[:-1]
        if self.path[: len(parent)] != parent or number <= self.path:
            return False
        sibling = self.path[len(parent)] if len(self.path) > len(parent) else 0
        return number[-1] - sibling <= _MAX_GAP

    def start(
        self, printed: str | None, key: _Key | None, kind: Kind, lines: list[str], page: int
    ) -> None:
        container = self.container()
        if printed is None:
            label = container or None
        else:
            label = f"{container} {printed}" if container else printed
        crumbs = list(self.container_titles)
        if key is not None:
            prefix, number = key
            crumbs += [
                self.titles[(prefix, number[:k])]
                for k in range(1, len(number))
                if (prefix, number[:k]) in self.titles
            ]
        self.open = _Open(
            label=label,
            annex=self.annex,
            appendix=self.appendix,
            part=self.part,
            number=printed,
            heading=" > ".join(crumbs),
            kind=kind,
            section=self.section if self.annex is None else None,
            lines=lines,
            page_start=page,
            page_end=page,
        )

    def append(self, line: _Line) -> None:
        if self.open is None:
            self.start(None, None, "text", [], line.page)
        assert self.open is not None
        if not self.open.lines:
            self.open.page_start = line.page
        self.open.lines.append(line.text)
        self.open.page_end = line.page

    def close(self) -> None:
        current, self.open = self.open, None
        if current is not None and current.lines:
            self.done.append(current)

    def finish(self) -> list[Paragraph]:
        self.close()
        # The same number in two sections outside the annexes: an introduction or a statement of
        # rationale that numbers its own paragraphs (R171, GTR 9). The regulation's text comes
        # last and keeps the plain label, which is what submissions cite; the others get their
        # section's name in front ("Introduction 10").
        last_section: dict[str, str | None] = {}
        sections: dict[str, set[str | None]] = {}
        for p in self.done:
            if p.kind == "paragraph" and p.annex is None and p.label:
                last_section[p.label] = p.section
                sections.setdefault(p.label, set()).add(p.section)
        result: list[Paragraph] = []
        for p in self.done:
            label = p.label
            if (
                label
                and p.kind == "paragraph"
                and p.annex is None
                and len(sections[label]) > 1
                and p.section != last_section[label]
                and p.section
            ):
                label = f"{p.section} {label}"
            result.append(
                Paragraph(
                    position=len(result),
                    label=label,
                    annex=p.annex,
                    appendix=p.appendix,
                    part=p.part,
                    number=p.number,
                    heading=p.heading,
                    kind=p.kind,
                    text="\n".join(p.lines),
                    page_start=p.page_start,
                    page_end=p.page_end,
                )
            )
        return result


def _is_title(rest: str) -> bool:
    rest = rest.strip()
    return 0 < len(rest) <= _MAX_TITLE and not rest.endswith((".", ";", ":", ","))


def extract(pdf: bytes) -> Extraction:
    """The paragraphs of a regulation PDF in document order, or ExtractionProblem."""
    lines, page_count, versions, warnings = _read_lines(pdf)
    if not lines:
        raise ExtractionProblem("The PDF has no text.")
    # The body size is the one most text is set in. Counted in characters, not lines: R40 has more
    # table lines (12.7 pt) than body lines (14 pt), and counting lines made every body line a
    # heading.
    sizes: Counter[float] = Counter()
    for line in lines:
        sizes[line.size] += len(line.text)
    body = sizes.most_common(1)[0][0]
    splitter = _Splitter(body)
    for line in lines:
        splitter.feed(line)
    paragraphs = splitter.finish()

    labels = Counter(p.label for p in paragraphs if p.kind == "paragraph")
    repeated = sorted(label for label, n in labels.items() if label and n > 1)
    if repeated:
        shown = ", ".join(repeated[:5]) + (" and more" if len(repeated) > 5 else "")
        warnings.append(f"{len(repeated)} label(s) appear more than once: {shown}.")
    distinct = sorted(set(versions))
    if len(distinct) > 1:
        warnings.append(f"The footers name more than one version: {', '.join(distinct)}.")
    return Extraction(
        page_count=page_count,
        version_label=distinct[0] if len(distinct) == 1 else None,
        paragraphs=paragraphs,
        warnings=warnings,
    )
