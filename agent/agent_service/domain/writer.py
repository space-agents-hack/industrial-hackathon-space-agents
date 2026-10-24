"""Writing a case's requirements from the regulation paragraphs, and checking them (#4; docs/se
SYS-25, SYS-28, SYS-29; design: requirements-writer.md in the project files).

The agents, all on the run's model unless the organisation chose a check model:
- the orchestrator (domain/__init__.py) chooses the regulations and drives the steps;
- per window of about 15 pages of one regulation, in parallel: the disposition agent decides,
  clause by clause, which obligations apply, and translators turn them into requirements ten at
  a time, citing a paragraph of that window by its number (settings.writer_stages "two"); or one
  writer does both ("one");
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
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from functools import cached_property
from pathlib import Path
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field, model_validator
from pydantic_ai import Agent, ModelRetry, RunContext, ToolOutput

from agent_service.records import LibraryVersion, NewRequirement, Paragraph, Requirement

# A window ends at whichever comes first. 15 pages is a length a model reads in well under a
# minute without skimming, and it keeps a long regulation to a few dozen parallel calls; 60k
# characters is about 15k tokens, for annexes that are mostly dense tables. Not tuned to any
# case's answers (SYS-42).
WINDOW_PAGES = 15
WINDOW_CHARS = 60_000

# A paragraph that imposes something. Used only to list obligations nobody cited (the check's
# second half), never to decide what the writer reads: the writer reads everything.
OBLIGATION = re.compile(r"\b(shall|must)\b", re.IGNORECASE)

# The clauses a writer must answer for, one by one (#48). Why code lists them: a writer reading a
# window freely wrote one requirement per paragraph 94% of the time, and the platform matches one
# to one, so the second and third obligation of a paragraph were lost. A clause is one sentence
# with "shall", "must" or a prohibition, or one item of a list under such a lead-in; that is how
# UN regulations write obligations, not a rule fitted to a case. Counted on the four regulations
# of the dev answer key (counting only, never which ones): this split gives every expected
# paragraph as many clauses as it has expected requirements for 137 of 190, where the free writer
# reached 109. What it misses (a heading with a bare value, a table) the writer adds itself.
_CLAUSE_WORDS = re.compile(r"\b(?:shall|must)\b|\bnot (?:be )?permitted\b|\bprohibited\b", re.I)
_LIST_ITEM = re.compile(r"(?:^|\n)\s*(?:\([a-z]{1,3}\)|[a-z]\)|[-\u2013\u2022])\s+")
_SENTENCE_END = re.compile(r"(?<=[.;])\s+(?=[A-Z(])")
_LEADING_NUMBER = re.compile(r"^\s*\S+\s+")
# Words of each clause shown to the writer: enough to tell clauses apart, the full text is above.
_CLAUSE_PREVIEW_WORDS = 14


def clauses(text: str) -> list[str]:
    """The obligation clauses of a paragraph's text, in order."""
    body = _LEADING_NUMBER.sub("", text, count=1)
    lead, *items = _LIST_ITEM.split(body)
    items = [" ".join(i.split()) for i in items if i.strip()]
    sentences = [s for s in _SENTENCE_END.split(" ".join(lead.split())) if _CLAUSE_WORDS.search(s)]
    if items and _CLAUSE_WORDS.search(lead):
        # "shall meet: (a) ...; (b) ..." is one obligation per item; the lead-in is not one more.
        return [s for s in sentences if not s.endswith(":")] + items
    return sentences + [i for i in items if _CLAUSE_WORDS.search(i)]


_HERE = Path(__file__).parent


class UnknownRegulation(Exception):
    """The orchestrator named a regulation or paragraph the library does not have."""


@dataclass(frozen=True)
class Window:
    # Not slots: cached_property needs the instance dict.
    version: LibraryVersion
    paragraphs: Sequence[Paragraph]
    # What an obligation may name as `covers`: the profile's functions and components plus
    # WHOLE_PART (coverable). Empty means `covers` is not checked (tests, or no profile).
    covers_from: tuple[str, ...] = ()

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
            lines += [f"[#{p.position}] {label} (page {p.page_start})", p.text]
            found = self.clauses.get(p.position, [])
            if found:
                lines.append("Clauses to account for:")
                for clause_id, clause in found:
                    words = clause.split()
                    more = " ..." if len(words) > _CLAUSE_PREVIEW_WORDS else ""
                    lines.append(
                        f"  {{{clause_id}}} {' '.join(words[:_CLAUSE_PREVIEW_WORDS])}{more}"
                    )
            lines.append("")
        return "\n".join(lines)

    @cached_property
    def clauses(self) -> dict[int, list[tuple[str, str]]]:
        """(clause id, clause) per paragraph position, for numbered paragraphs."""
        return {
            p.position: [(f"c{p.position}.{k}", c) for k, c in enumerate(clauses(p.text), 1)]
            for p in self.paragraphs
            if p.kind == "paragraph" and p.label
        }

    @property
    def clause_ids(self) -> set[str]:
        return {cid for found in self.clauses.values() for cid, _ in found}


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
# The product profile (SYS-43)
# ------------------------------------------------------------------------------------------


Build = Literal["integral", "replaceable", "separately_approved", "stated_type", "not_stated"]

# How each build reads in the profile. Scopes set conditions in these terms ("replaceable",
# "approved as a component", "of a type listed in"), so the screen's "as built" test (screen.md)
# and the writers can compare word for word.
_BUILD_TEXT: dict[str, str] = {
    "integral": "integral to the part, not replaceable on its own",
    "replaceable": "a replaceable item",
    "separately_approved": "a separately approved component",
    "stated_type": "of a type the case names (a category, class or standard)",
    "not_stated": "not stated by the case",
}


class Component(BaseModel):
    name: str = Field(
        min_length=1,
        max_length=120,
        description="Short, and unique in the profile: every later step copies it word for word.",
    )
    functions: list[str] = Field(
        min_length=1,
        description="The functions of the part it serves, copied from `functions`; for a "
        "component that serves none of them (a housing, a bracket), what it does.",
    )
    technology: str = Field(
        min_length=1,
        max_length=200,
        description="What kind of thing it is: electrical, electronic, light source, sensor, "
        "actuator, software, wiring, glazing, a material, a moving part, a structure.",
    )
    build: Build = Field(
        description="How the case shows it is built into the part: integral (not replaceable), "
        "replaceable, separately_approved (a component approved on its own), stated_type (the "
        "case names its category, class or standard), or not_stated."
    )


class ProductProfile(BaseModel):
    """What the part is, stated once by the orchestrator from the whole case.

    Why one statement: each of ~25 writers used to decide "does this apply to this product" from
    the raw case files on its own, and they decided differently; obligations for functions the
    part does not have got in. `components` is where a regulation that applies because of what the
    part is made of (and not what it does) becomes visible to the selection.

    Why components are records and not free text (v2, Certivity's first tip): the screen's "as
    built" test needs to know per component whether it is replaceable or separately approved,
    code runs one search per function and per component (tools.screen_regulations), and writers
    name the function or component an obligation covers. Each needs the same names, so a
    component's `name` is its key and must be unique.
    """

    part: str = Field(max_length=500)
    functions: list[str] = Field(default_factory=list[str])
    functions_absent: list[str] = Field(default_factory=list[str])
    components: list[Component] = Field(default_factory=list[Component])
    mounted: list[str] = Field(default_factory=list[str])
    vehicles: list[str] = Field(default_factory=list[str])
    markets: list[str] = Field(default_factory=list[str])
    named_in_case: list[str] = Field(default_factory=list[str])

    @model_validator(mode="after")
    def _unique_component_names(self) -> "ProductProfile":
        counts = Counter(_key(c.name) for c in self.components)
        twice = sorted({c.name for c in self.components if counts[_key(c.name)] > 1})
        if twice:
            raise ValueError(
                f"Component names must be unique, and these appear twice: {', '.join(twice)}. "
                "Merge them or name them apart (left and right, upper and lower)."
            )
        return self

    def search_entries(self) -> list[tuple[str, str]]:
        """(entry as the profile writes it, query) for the searches code runs per entry. A
        component is searched with its technology: a name alone ("the module") finds little."""
        out = [(f, f) for f in self.functions]
        out += [(c.name, f"{c.name}, {c.technology}") for c in self.components]
        return list(dict.fromkeys(out))

    def render(self) -> str:
        def items(title: str, values: list[str]) -> list[str]:
            return [f"{title}:", *(f"- {v}" for v in values or ["(nothing stated)"]), ""]

        components: list[str] = ["Its components:"]
        for c in self.components:
            # Alone on its line, so a writer can copy the name exactly (SYS-25 `covers`).
            components += [
                f"Component: {c.name}",
                f"  Serves: {'; '.join(c.functions)}",
                f"  Technology: {c.technology}",
                f"  How it is built in: {_BUILD_TEXT[c.build]}",
            ]
        if not self.components:
            components.append("- (nothing stated)")
        return "\n".join(
            [
                "# The product profile",
                "",
                "Stated by the orchestrator from the case. Judge whether an obligation applies "
                "against this; the case files above are the evidence for it.",
                "",
                f"The part: {self.part}",
                "",
                *items("Its functions", self.functions),
                *items("Functions of its family it does NOT have", self.functions_absent),
                *components,
                "",
                *items("Where it is fitted, and what of the vehicle it affects", self.mounted),
                *items("Vehicle categories", self.vehicles),
                *items("Markets", self.markets),
                *items(
                    "Regulations, approval marks or standards the case files name",
                    (self.named_in_case),
                ),
            ]
        ).rstrip()


def _key(name: str) -> str:
    return " ".join(name.lower().split())


# ------------------------------------------------------------------------------------------
# The writer
# ------------------------------------------------------------------------------------------


class Draft(BaseModel):
    ref: int = Field(description="The [#n] number of the paragraph this requirement comes from.")
    covers: str = Field(
        default="",
        max_length=300,
        description="The function or component of the product profile it is about, copied word "
        "for word from the profile, or 'the part' for the part as a whole.",
    )
    clauses: list[str] = Field(
        default_factory=list[str],
        description="The {c...} clause ids this requirement writes, from the paragraph it cites. "
        "Empty for an obligation the clause list does not show (a heading with a value, a "
        "table row).",
    )
    text: str = Field(
        max_length=2000,
        description="The requirement, self-contained: subject, 'shall', values, units, conditions.",
    )
    test_case: str = Field(
        max_length=2000,
        description="How to verify it: test, inspection or analysis, and the pass criterion.",
    )


class SetAside(BaseModel):
    clause: str = Field(description="A {c...} clause id of this window that gets no requirement.")
    reason: Literal[
        "definition_or_scope",
        "authority_procedure",
        "not_this_product",
        "not_an_obligation",
        "test_method",
        "same_as_another_clause",
    ] = Field(
        description="definition_or_scope: defines a term or the scope. authority_procedure: what "
        "the approval authority or the application file does. not_this_product: by the product "
        "profile (a function it lacks, another vehicle category, a device it neither is nor "
        "contains). not_an_obligation: imposes nothing (a permission, a reference only). "
        "test_method: how a test is carried out (set-up, conditioning, sequence, equipment, how a "
        "value is measured or computed), which belongs in the test case of the requirement it "
        "verifies. same_as_another_clause: restates an obligation answered elsewhere in this "
        "window."
    )
    note: str = Field(default="", max_length=300, description="Why, in a few words.")


class WindowAnswer(BaseModel):
    requirements: list[Draft] = Field(default_factory=list[Draft])
    set_aside: list[SetAside] = Field(default_factory=list[SetAside])


writer_agent = Agent(
    name="requirement-writer",
    deps_type=Window,
    output_type=ToolOutput(WindowAnswer, name="record_requirements"),
    instructions=(_HERE / "writer.md").read_text(),
    retries=2,
)


@writer_agent.output_validator
def _cites_this_window(ctx: RunContext[Window], answer: WindowAnswer) -> WindowAnswer:
    known = {p.position for p in ctx.deps.paragraphs}
    wrong = sorted({d.ref for d in answer.requirements if d.ref not in known})
    if wrong:
        raise ModelRetry(
            f"[#{', #'.join(map(str, wrong))}] are not paragraphs of this window. Cite only the "
            "[#n] numbers shown above, or leave the requirement out."
        )
    ids = ctx.deps.clause_ids
    answered = {c for d in answer.requirements for c in d.clauses} | {
        a.clause for a in answer.set_aside
    }
    unknown = sorted(answered - ids)
    missing = sorted(ids - answered, key=_clause_order)
    uncovered = _not_in_profile(ctx.deps, answer.requirements)
    # Coverage is asked for once, not forced: a window that fails costs every requirement in it,
    # a few unanswered clauses cost only themselves, and each retry is another full answer in a
    # run that has 770 s for everything. The second answer is kept as it is.
    if (unknown or missing or uncovered) and ctx.retry == 0:
        parts: list[str] = []
        if missing:
            shown = ", ".join(missing[:40]) + (" ..." if len(missing) > 40 else "")
            parts.append(
                f"{len(missing)} clause(s) have no answer: {shown}. Answer each one: in an entry "
                "that lists it in `clauses` if it applies, or in `set_aside` with its reason."
            )
        if unknown:
            parts.append(f"Not clause ids of this window: {', '.join(unknown[:20])}.")
        if uncovered:
            parts.append(
                f"`covers` is not an entry of the product profile for [#{', #'.join(uncovered)}]. "
                "Copy a function or component from the profile word for word, or write "
                f"'{WHOLE_PART}'; if it covers none of them, set its clauses aside as "
                "not_this_product."
            )
        raise ModelRetry(" ".join(parts) + " Answer again with the whole list.")
    requirements = [d for d in answer.requirements if d.text.strip()]
    return WindowAnswer(requirements=requirements, set_aside=answer.set_aside)


# What `covers` names when an obligation is on the part as a whole: its marking, its
# installation, the device as a whole.
WHOLE_PART = "the part"


def coverable(profile: "ProductProfile | None") -> tuple[str, ...]:
    """What an obligation may name as `covers` (SYS-25; Certivity's tips, Clemente 2026-10-24
    23:01): each function the profile says the part performs, each of its components, and the
    part as a whole. Not the functions it does NOT have: an obligation for one of those is set
    aside as not_this_product. A component by its name, which the profile prints alone on its
    line ("Component: <name>") so it can be copied exactly."""
    if profile is None:
        return ()
    names = (c.name for c in profile.components)
    return tuple(dict.fromkeys((*profile.functions, *names, WHOLE_PART)))


def _normal(text: str) -> str:
    return " ".join(text.casefold().split()).strip(" .;:-")


def _not_in_profile(window: Window, drafts: Sequence[Draft]) -> list[str]:
    """The [#n] of drafts whose `covers` names nothing in the profile. Case, spacing and end
    punctuation are forgiven: the point is that it names a profile entry, not that it is typed
    the same."""
    if not window.covers_from:
        return []
    allowed = {_normal(c) for c in window.covers_from}
    return sorted({str(d.ref) for d in drafts if _normal(d.covers) not in allowed}, key=int)


# How the trace counts an obligation whose `covers` names nothing in the profile even after the
# nudge (it is kept: a wrongly dropped obligation costs four times a kept one).
NOT_IN_PROFILE = "(not in the profile, kept)"


def covered_entry(window: Window, covers: str) -> str:
    """The profile entry `covers` names, spelt as the profile spells it, or NOT_IN_PROFILE. For
    the trace: how many obligations each entry, and the part as a whole, account for."""
    wanted = _normal(covers)
    return next((c for c in window.covers_from if _normal(c) == wanted), NOT_IN_PROFILE)


def _clause_order(clause_id: str) -> tuple[int, int]:
    position, k = clause_id[1:].split(".")
    return int(position), int(k)


# ------------------------------------------------------------------------------------------
# The writer in two stages (#48; settings.writer_stages = "two")
# ------------------------------------------------------------------------------------------
# Why two agents and not one: one writer per window had to find every obligation, judge whether it
# applies, split it, word it, write its test and cite it in one answer, and it gave one requirement
# per paragraph 94% of the time. Here the first agent only decides, clause by clause, what the
# window obliges this product to do; the second only turns each obligation into a requirement, a
# few at a time, and can read the table or paragraph an obligation refers to anywhere in the
# version. The check agent then reads the result as before.


class Obligation(BaseModel):
    ref: int = Field(description="The [#n] number of the paragraph that states it.")
    covers: str = Field(
        default="",
        max_length=300,
        description="The function or component of the product profile it is about, copied word "
        "for word from the profile, or 'the part' for the part as a whole.",
    )
    clauses: list[str] = Field(
        default_factory=list[str],
        description="The {c...} clause ids it comes from. Empty for one the clause list does not "
        "show (a heading with a value, a table row).",
    )
    what: str = Field(
        max_length=400,
        description="The obligation in one line, in the regulation's terms: which part of the "
        "paragraph, which list item or table row, under which condition.",
    )


class Disposition(BaseModel):
    obligations: list[Obligation] = Field(default_factory=list[Obligation])
    set_aside: list[SetAside] = Field(default_factory=list[SetAside])


disposition_agent = Agent(
    name="obligation-finder",
    deps_type=Window,
    output_type=ToolOutput(Disposition, name="record_disposition"),
    instructions=(_HERE / "disposition.md").read_text(),
    retries=2,
)


@disposition_agent.output_validator
def _disposes_of_every_clause(ctx: RunContext[Window], answer: Disposition) -> Disposition:
    as_drafts = WindowAnswer(
        requirements=[
            Draft(ref=o.ref, covers=o.covers, clauses=o.clauses, text=o.what or "-", test_case="")
            for o in answer.obligations
        ],
        set_aside=answer.set_aside,
    )
    _cites_this_window(ctx, as_drafts)  # the same refusals as the one-stage writer
    return answer


# Obligations per translator call: each comes with its paragraph, so ten is a few thousand tokens
# in and a few thousand out, well inside a call's time; more per call is fewer, slower calls.
TRANSLATE_BATCH = 10


@dataclass(frozen=True)
class TranslationJob:
    """Some obligations of one window, and every paragraph of the version, for look-ups."""

    window: Window
    obligations: Sequence[Obligation]
    by_label: dict[str, list[Paragraph]] = field(default_factory=dict[str, list[Paragraph]])

    def render(self) -> str:
        v = self.window.version
        by_position = {p.position: p for p in self.window.paragraphs}
        clause_text = {cid: c for found in self.window.clauses.values() for cid, c in found}
        lines = [
            f"Regulation {v.regulation} ({v.title or 'no title'}), version {v.version_label}.",
            "",
        ]
        for n, o in enumerate(self.obligations, 1):
            p = by_position[o.ref]
            lines += [
                f"## Obligation {n}: [#{p.position}] {p.label or '(unnumbered text)'} "
                f"(page {p.page_start})",
                f"Under: {p.heading}" if p.heading else "",
                f"What it obliges: {o.what}",
            ]
            lines += [f"Clause {{{c}}}: {clause_text[c]}" for c in o.clauses if c in clause_text]
            lines += ["Paragraph text:", p.text, ""]
        return "\n".join(lines)


translator_agent = Agent(
    name="requirement-translator",
    deps_type=TranslationJob,
    output_type=ToolOutput(list[Draft], name="record_translations"),
    instructions=(_HERE / "translate.md").read_text(),
    retries=2,
)


@translator_agent.tool
def read_version_paragraphs(
    ctx: RunContext[TranslationJob], labels: list[str]
) -> list[dict[str, Any]]:
    """Read paragraphs of this regulation version by label: the table, annex or paragraph an
    obligation refers to, wherever it is in the version.

    Args:
        labels: Paragraph labels as the regulation numbers them. At most 10.
    """
    out: list[dict[str, Any]] = []
    for label in labels[:10]:
        found = ctx.deps.by_label.get(label, [])
        if not found:
            out.append({"label": label, "error": "No paragraph with this label in the version."})
        out += [{"label": label, "page": p.page_start, "text": p.text} for p in found]
    return out


@translator_agent.output_validator
def _translates_these_obligations(
    ctx: RunContext[TranslationJob], drafts: list[Draft]
) -> list[Draft]:
    known = Counter(o.ref for o in ctx.deps.obligations)
    wrong = sorted({d.ref for d in drafts if d.ref not in known})
    if wrong:
        raise ModelRetry(
            f"[#{', #'.join(map(str, wrong))}] are not the paragraphs of these obligations. Cite "
            "the [#n] each obligation is headed with."
        )
    drafts = [d for d in drafts if d.text.strip()]
    written = Counter(d.ref for d in drafts)
    over = sorted(ref for ref, n in written.items() if n > known[ref])
    # One requirement per obligation (Clemente, 2026-10-25: "make sure one obligation, one
    # requirement is met"). The first stage already splits; a translator that splits again
    # multiplied the output (634 requirements on dev for a key of 190). Asked once; after that the
    # first ones per paragraph are kept, as many as it has obligations.
    if over and ctx.retry == 0:
        raise ModelRetry(
            f"[#{', #'.join(map(str, over))}]: more requirements than obligations. Write exactly "
            "one requirement per obligation; another agent already split them. Answer again."
        )
    kept: list[Draft] = []
    for d in drafts:
        if known[d.ref] > 0:
            kept.append(d)
            known[d.ref] -= 1
    return kept


def translation_jobs(
    window: Window, disposition: Disposition, version_paragraphs: Sequence[Paragraph]
) -> list[TranslationJob]:
    by_label: dict[str, list[Paragraph]] = {}
    for p in version_paragraphs:
        if p.label:
            by_label.setdefault(p.label, []).append(p)
    obligations = list(disposition.obligations)
    return [
        TranslationJob(window, obligations[i : i + TRANSLATE_BATCH], by_label)
        for i in range(0, len(obligations), TRANSLATE_BATCH)
    ]


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
        regulation: As cited in the requirement.
        labels: Paragraph labels, for example ["x.y.z", "Annex n Part m x.y"]. At most 20.
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
    paragraphs: Sequence[Paragraph],
    rows: Sequence[Requirement],
    version: LibraryVersion,
    set_aside: Mapping[UUID, str] | None = None,
) -> list[dict[str, Any]]:
    """Obligation paragraphs ("shall", "must") of a read version that no requirement cites, less
    those a writer set aside clause by clause (`set_aside`): a writer that judged a paragraph a
    test method or a restatement in its window decided it, and the check does not undo that."""
    cited = {r.paragraph_id for r in rows}
    skip = set_aside or {}
    return [
        {"regulation": version.regulation, "paragraph": p.label, "page": p.page_start}
        for p in paragraphs
        if p.kind == "paragraph"
        and p.label
        and p.id not in cited
        and p.id not in skip
        and OBLIGATION.search(p.text)
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
