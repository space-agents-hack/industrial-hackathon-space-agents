"""Writing a case's requirements from the regulation paragraphs, and checking them (#4; docs/se
SYS-25, SYS-28, SYS-29; design: requirements-writer.md in the project files).

Three agents, all on the run's model:
- the orchestrator (domain/__init__.py) chooses the regulations and drives the steps;
- writers each read one window of about 15 pages of one regulation, in parallel, and propose
  requirements that cite a paragraph of that window by its number in the window;
- the check agent reads requirements next to the paragraphs they cite and flags what is wrong.

Why windows and not the whole regulation in one call: R48 alone is about 85k tokens; one call
reading it would take minutes and, measured on other long documents, skims the middle. A window
of 15 pages is read in well under a minute, and 25 windows run side by side.

Why the model cites `[#n]` and code fills the citation: a model that types "Annex 4 Part 1 1.2"
or a page number gets one of them wrong now and then, and the platform scores pages. Here the
model picks a paragraph it was shown; code copies regulation, version, page and label from that
row. A `[#n]` that is not in the window is refused before anything is stored (SYS-5, SYS-6).

What this does NOT do: decide which regulations apply (the orchestrator does, with search), or
judge whether the requirement set is complete beyond listing obligation paragraphs nobody cited.
"""

import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field
from pydantic_ai import Agent, ModelRetry, RunContext, ToolOutput

from agent_service.records import LibraryVersion, NewRequirement, Paragraph, Requirement

# A window ends at whichever comes first. 15 pages is the measured density of the dev case's
# answers (190 requirements on 53 of 372 pages) read at a pace a model does not skim; 60k
# characters is about 15k tokens, for annexes that are mostly dense tables.
WINDOW_PAGES = 15
WINDOW_CHARS = 60_000

# A paragraph that imposes something. Used only to list obligations nobody cited (the check's
# second half), never to decide what the writer reads: the writer reads everything.
OBLIGATION = re.compile(r"\b(shall|must)\b", re.IGNORECASE)

_HERE = Path(__file__).parent


class UnknownRegulation(Exception):
    """The orchestrator named a regulation or paragraph the library does not have."""


@dataclass(frozen=True)
class Window:
    version: LibraryVersion
    paragraphs: Sequence[Paragraph]

    @property
    def pages(self) -> str:
        first, last = self.paragraphs[0].page_start, self.paragraphs[-1].page_end
        return f"{first}" if first == last else f"{first}-{last}"

    def render(self) -> str:
        """The window as the writer reads it: every paragraph with its number, label, page and
        the headings above it, so "shall not exceed 30 cd" is read under "Rear position lamps"."""
        v = self.version
        lines = [
            f"Regulation {v.regulation} ({v.title or 'no title'}), version {v.version_label}, "
            f"pages {self.pages}.",
            "",
        ]
        heading = None
        for p in self.paragraphs:
            if p.heading and p.heading != heading:
                lines += [f"## {p.heading}", ""]
                heading = p.heading
            label = p.label or "(unnumbered text)"
            lines += [f"[#{p.position}] {label} (page {p.page_start})", p.text, ""]
        return "\n".join(lines)


def windows(
    version: LibraryVersion,
    paragraphs: Sequence[Paragraph],
    *,
    max_pages: int = WINDOW_PAGES,
    max_chars: int = WINDOW_CHARS,
) -> list[Window]:
    """The version cut into windows on paragraph boundaries, in document order. A single
    paragraph longer than a window (a big table) is a window of its own, never cut."""
    out: list[Window] = []
    current: list[Paragraph] = []
    chars = 0
    for p in paragraphs:
        if current and (
            p.page_end - current[0].page_start + 1 > max_pages or chars + len(p.text) > max_chars
        ):
            out.append(Window(version, current))
            current, chars = [], 0
        current.append(p)
        chars += len(p.text)
    if current:
        out.append(Window(version, current))
    return out


def citable_version(versions: Sequence[LibraryVersion], regulation: str) -> LibraryVersion:
    """The version a main-goal requirement cites: the one the index calls `base`, or the only one.

    Certivity's brief scores citations of the base version for the main goal; `latest` is the
    sub-goal's. A regulation with several versions and none marked base is refused rather than
    guessed, because a wrong version scores zero for every requirement of that regulation.
    """
    mine = [v for v in versions if v.regulation == regulation]
    if not mine:
        known = sorted({v.regulation for v in versions})
        raise UnknownRegulation(
            f"{regulation!r} is not in the library. Regulations: {', '.join(known) or 'none'}."
        )
    base = [v for v in mine if v.role == "base"]
    if len(base) == 1:
        return base[0]
    if len(mine) == 1:
        return mine[0]
    labels = ", ".join(f"{v.version_label} ({v.role or 'no role'})" for v in mine)
    raise UnknownRegulation(f"{regulation} has several versions and none is the base: {labels}.")


# ------------------------------------------------------------------------------------------
# The writer
# ------------------------------------------------------------------------------------------


class Draft(BaseModel):
    ref: int = Field(description="The [#n] number of the paragraph this requirement comes from.")
    text: str = Field(
        max_length=2000,
        description="The requirement, self-contained: subject, 'shall', values, units, conditions.",
    )
    test_case: str = Field(
        max_length=2000,
        description="How to verify it: test, inspection or analysis, and the pass criterion.",
    )


writer_agent = Agent(
    name="requirement-writer",
    deps_type=Window,
    output_type=ToolOutput(list[Draft], name="record_requirements"),
    instructions=(_HERE / "writer.md").read_text(),
    retries=2,
)


@writer_agent.output_validator
def _cites_this_window(ctx: RunContext[Window], drafts: list[Draft]) -> list[Draft]:
    known = {p.position for p in ctx.deps.paragraphs}
    wrong = sorted({d.ref for d in drafts if d.ref not in known})
    if wrong:
        raise ModelRetry(
            f"[#{', #'.join(map(str, wrong))}] are not paragraphs of this window. Cite only the "
            "[#n] numbers shown above, or leave the requirement out."
        )
    return [d for d in drafts if d.text.strip()]


def cite(
    draft: Draft,
    window: Window,
    *,
    ext_id: str,
    case_id: UUID,
    organization_id: UUID,
    run_id: UUID,
) -> NewRequirement:
    """The stored requirement: the model's words, and the citation copied from the paragraph."""
    paragraph = next(p for p in window.paragraphs if p.position == draft.ref)
    return NewRequirement(
        case_id=case_id,
        organization_id=organization_id,
        run_id=run_id,
        ext_id=ext_id,
        text=draft.text.strip(),
        test_case=draft.test_case.strip() or None,
        version_id=window.version.id,
        paragraph_id=paragraph.id,
        paragraph_hash=paragraph.content_hash,
        regulation=window.version.regulation,
        version_label=window.version.version_label,
        page=paragraph.page_start,
        paragraph=paragraph.label,
    )


def ext_id(n: int) -> str:
    return f"R-{n:03d}"


# ------------------------------------------------------------------------------------------
# The check (SYS-29)
# ------------------------------------------------------------------------------------------


class Finding(BaseModel):
    ext_id: str = Field(description="The requirement's id, for example R-012.")
    problem: str = Field(max_length=1000, description="What is wrong, in one or two sentences.")
    action: Literal["reject", "keep"] = Field(
        description="reject: it misstates its paragraph, cites the wrong one, or does not apply "
        "to this product. keep: worth a person's look, but it should stay."
    )


@dataclass
class CheckDeps:
    """What the check agent may look up: every paragraph of the versions the run cites."""

    by_label: dict[tuple[str, str], list[Paragraph]] = field(default_factory=dict)


check_agent = Agent(
    name="requirement-check",
    deps_type=CheckDeps,
    output_type=ToolOutput(list[Finding], name="report_findings"),
    instructions=(_HERE / "check.md").read_text(),
    retries=2,
)


@check_agent.tool
def read_paragraphs(
    ctx: RunContext[CheckDeps], regulation: str, labels: list[str]
) -> list[dict[str, Any]]:
    """Read paragraphs of a cited regulation by label, for example the table or the paragraph a
    requirement's paragraph refers to.

    Args:
        regulation: As cited, for example "UN R148".
        labels: Paragraph labels, for example ["5.4.2", "Annex 3 Part 1 1.2"]. At most 20.
    """
    out: list[dict[str, Any]] = []
    for label in labels[:20]:
        found = ctx.deps.by_label.get((regulation, label), [])
        if not found:
            out.append({"label": label, "error": "No paragraph with this label in the version."})
        out += [{"label": label, "page": p.page_start, "text": p.text} for p in found]
    return out


def check_batch(rows: Sequence[Requirement], cited: dict[UUID, Paragraph]) -> str:
    """Requirements next to the text of the paragraph each cites, for the check agent."""
    lines: list[str] = []
    for r in rows:
        p = cited.get(r.paragraph_id) if r.paragraph_id else None
        lines += [
            f"### {r.ext_id}: {r.regulation} {r.paragraph or '(unnumbered)'}, page {r.page}",
            f"Requirement: {r.text}",
            f"Test case: {r.test_case or '(none)'}",
            "Cited paragraph:" if p else "Cited paragraph: NOT FOUND in the library.",
        ]
        if p:
            lines += [f"(under: {p.heading})" if p.heading else "", p.text]
        lines.append("")
    return "\n".join(lines)


def code_findings(rows: Sequence[Requirement], cited: dict[UUID, Paragraph]) -> dict[str, str]:
    """What code alone can tell: a citation that no longer matches the library, and exact
    duplicates (same paragraph, same words), which only lower precision."""
    found: dict[str, str] = {}
    seen: dict[tuple[UUID | None, str], str] = {}
    for r in rows:
        p = cited.get(r.paragraph_id) if r.paragraph_id else None
        if r.paragraph_superseded_at is not None:
            found[r.ext_id] = (
                "Its paragraph was re-extracted with different text on"
                f" {r.paragraph_superseded_at:%Y-%m-%d}: check it against the current text."
            )
        elif p is None:
            found[r.ext_id] = "Its paragraph is no longer in the library (re-extracted or deleted)."
        elif (p.page_start, p.label, p.content_hash) != (r.page, r.paragraph, r.paragraph_hash):
            found[r.ext_id] = "Its citation no longer matches the paragraph in the library."
        key = (r.paragraph_id, " ".join(r.text.lower().split()))
        if key in seen:
            found[r.ext_id] = f"Duplicate of {seen[key]}: same paragraph, same text."
        else:
            seen[key] = r.ext_id
    return found


def uncovered(
    paragraphs: Sequence[Paragraph], rows: Sequence[Requirement], version: LibraryVersion
) -> list[dict[str, Any]]:
    """Obligation paragraphs ("shall", "must") of a read version that no requirement cites."""
    cited = {r.paragraph_id for r in rows}
    return [
        {"regulation": version.regulation, "paragraph": p.label, "page": p.page_start}
        for p in paragraphs
        if p.kind == "paragraph" and p.label and p.id not in cited and OBLIGATION.search(p.text)
    ]


# ------------------------------------------------------------------------------------------
# The submission (IF-4)
# ------------------------------------------------------------------------------------------


def submission(team_id: str, case_id: str, rows: Sequence[Requirement]) -> dict[str, Any]:
    """Certivity's main-goal file, built from the stored rows and nothing else."""
    if not team_id or not case_id:
        # validate.py accepts the file without them, and the platform then scores it as nobody's.
        raise ValueError(f"A submission needs team_id and case_id (got {team_id!r}, {case_id!r}).")
    out: list[dict[str, Any]] = []
    for r in rows:
        if r.status == "rejected":
            continue
        source: dict[str, Any] = {
            "regulation": r.regulation,
            "version": r.version_label,
            "page": r.page,
        }
        if r.paragraph:
            source["paragraph"] = r.paragraph
        item: dict[str, Any] = {"id": r.ext_id, "text": r.text, "source": source}
        if r.test_case:
            item["test_case"] = r.test_case
        out.append(item)
    return {"team_id": team_id, "case_id": case_id, "requirements": out}
