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
# A lead-in that announces a list, with or without a "shall" of its own.
_INTRODUCES_LIST = re.compile(r"(?::|\bfollowing\b[^.]*\.)\s*$")
# Words of each clause shown to the writer: enough to tell clauses apart, the full text is above.
_CLAUSE_PREVIEW_WORDS = 14


# An enumeration inside a sentence: "shall bear (i) the mark, (ii) the code and (iii) the voltage".
# The marker must follow a word or a ",;:" so a cross-reference ("paragraph 3.3.5. (a)") is not one.
_INLINE_MARKER = re.compile(r"(?:(?<=[A-Za-z,;:])|(?<=[A-Za-z,;:] ))\(([ivx]{1,4}|[a-h])\)\s+")
_ROMAN = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x"]


def _inline_items(sentence: str) -> list[str]:
    """The items of an inline enumeration that runs (i), (ii)... or (a), (b)... from the start,
    or [] when the sentence has none. Each item is one obligation under the sentence's lead-in."""
    found = list(_INLINE_MARKER.finditer(sentence))
    if len(found) < 2:
        return []
    marks = [m.group(1) for m in found]
    roman = _ROMAN[: len(marks)]
    letters = [chr(ord("a") + k) for k in range(len(marks))]
    if marks != roman and marks != letters:
        return []
    ends = [m.start() for m in found[1:]] + [len(sentence)]
    items = [sentence[m.end() : end].strip(" ,;") for m, end in zip(found, ends, strict=True)]
    return [re.sub(r"[,;]?\s+(?:and|or)$", "", i) for i in items]


def clauses(text: str) -> list[str]:
    """The obligation clauses of a paragraph's text, in order."""
    body = _LEADING_NUMBER.sub("", text, count=1)
    lead, *items = _LIST_ITEM.split(body)
    items = [" ".join(i.split()) for i in items if i.strip()]
    sentences: list[str] = []
    for s in _SENTENCE_END.split(" ".join(lead.split())):
        if _CLAUSE_WORDS.search(s):
            # Inline (i), (ii) items are one obligation each, as a list on separate lines is.
            sentences += _inline_items(s) or [s]
    if items and (_CLAUSE_WORDS.search(lead) or _INTRODUCES_LIST.search(lead)):
        # "shall meet: (a) ...; (b) ..." is one obligation per item; the lead-in is not one more.
        # So is "bear the following markings: (a) ...", whose "shall" is in the paragraph above.
        # An item that only heads a sub-list ("(a) On the module:") is not one either.
        return [s for s in sentences if not s.endswith(":")] + [
            i for i in items if not i.endswith(":")
        ]
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


def _in_annex(p: Paragraph) -> bool:
    # Labels and headings of annex text start with "Annex" (paragraphs.Paragraph.label/heading);
    # appendices printed after the main text, before the annexes, with "Appendix".
    return (p.label or p.heading).startswith(("Annex", "Appendix"))


def queue_order(jobs: Sequence[Window]) -> list[Window]:
    """The order windows start in: every regulation's main text before any annex, and inside each
    of the two, one window of each regulation in turn.

    Why: windows start in this order and none starts once the write reserve is reached, so on a
    run that runs short the last ones are lost. In the order the regulations were named, that was
    every window of the last regulations, so whole regulations went missing from the file. This
    way a slow run loses annex tails first:
    mostly test procedures and forms, the clauses the disposition sets aside as test_method most
    often. When the run fits, the order changes nothing but the sequence. A window that starts in
    the main text counts as main text."""
    groups: dict[UUID, tuple[list[Window], list[Window]]] = {}
    for w in jobs:
        main, annex = groups.setdefault(w.version.id, ([], []))
        (annex if _in_annex(w.paragraphs[0]) else main).append(w)
    out: list[Window] = []
    for part in (0, 1):
        lanes = [g[part] for g in groups.values()]
        for i in range(max((len(lane) for lane in lanes), default=0)):
            out += [lane[i] for lane in lanes if i < len(lane)]
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
# Why "mounted inside the assembly" counts as integral (Ramón, 2026-10-25 04:43 UTC): a spec that
# lists a component as fitted on a board inside the part, without saying "not replaceable", was
# read as not_stated, so the screen's "as built" test gave `possibly` to a regulation that covers
# only replaceable or separately approved items of that kind, and the search kept it. On dev that
# was one regulation with 36 obligations and no expected requirement. The risk is the other way:
# a terse spec of a component that is in fact replaceable now drops a regulation, so the rule
# asks for no socket, connector, holder or replacement mentioned, not just silence.
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
        "case names its category, class or standard), or not_stated. A component the case shows "
        "mounted inside the assembly (on a circuit board, moulded or bonded in, part of a sealed "
        "unit) with no socket, connector, holder or replacement mentioned is integral; not_stated "
        "is for a component of which the case shows nothing of how it is fitted."
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
        "contains, a vehicle signal the case does not name). not_an_obligation: imposes nothing "
        "(a permission, a reference only). "
        "test_method: how the laboratory carries a test out, even with a value (apparatus, "
        "facility, instrument settings, measuring distance, sample allocation, sequence, how a "
        "value is measured or computed), which belongs in the test case of the requirement it "
        "verifies; what the product is exposed to or must show is an obligation. "
        "same_as_another_clause: restates an obligation answered elsewhere in this "
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
                f"'{WHOLE_PART}', which also covers an obligation that holds only if the part "
                "has a feature the case does not mention (keep it, with its condition). Set it "
                "aside as not_this_product only when it is on another device or a function the "
                "profile says the part does not have."
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
        description="The obligation in one line, in the regulation's terms: its scope, its "
        "condition and its constraint, and which sentence or list item of the paragraph it is.",
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


# A vote's unit: a clause id, or "#n" for an obligation that lists no clause, with its occurrence
# within one sample (vote_dispositions).
_Unit = tuple[str, int]


def vote_dispositions(
    samples: Sequence[Disposition], *, need: int
) -> tuple[Disposition, Counter[str]]:
    """Several answers of the disposition agent for one window, merged into one by vote.

    Why (research doc retrieval-extraction-research.md, proposal 1; Clemente 2026-10-25: "apply
    all"): one sample of a model at its default temperature keeps some obligations by chance and
    drops others by chance. Asking twice or three times and voting is self-consistency, the usual
    remedy. `need` is how many samples must keep a unit: 1 is the union (an obligation one sample
    missed comes back, for recall), a majority cuts what only one sample kept (for precision).

    The vote is per unit, not per obligation, because samples group clauses differently: a unit
    is one clause id an obligation lists, or, for an obligation that lists none (a table row, a
    heading with a value), its [#n]. Each unit is counted once per occurrence within a sample, so
    two obligations on the same clause, or three table rows on one paragraph, are three votes on
    "how many", not one. Merged obligations come from the first sample that holds them, keep their
    `covers` and list each clause once (the translator's cap, 89a088d, is one requirement per
    clause). A clause kept by the vote is never also set aside.

    Returns the merged disposition and agreement counts for the trace: units kept by every sample
    and units kept by only some of them, which is the noise the vote acts on, measured without
    the answer key."""

    def units(sample: Disposition) -> list[list[_Unit]]:
        seen: Counter[str] = Counter()
        out: list[list[_Unit]] = []
        for o in sample.obligations:
            mine: list[_Unit] = []
            for key in list(dict.fromkeys(o.clauses)) or [f"#{o.ref}"]:
                seen[key] += 1
                mine.append((key, seen[key]))
            out.append(mine)
        return out

    per_sample = [units(s) for s in samples]
    votes: Counter[_Unit] = Counter(u for sample in per_sample for mine in sample for u in mine)
    kept = {u for u, n in votes.items() if n >= need}
    agreement: Counter[str] = Counter()
    for n in votes.values():
        agreement["vote: kept by all" if n == len(samples) else "vote: kept by some"] += 1
    agreement["vote: dropped"] = len(votes) - len(kept)

    merged: list[Obligation] = []
    emitted: set[_Unit] = set()
    for sample, sample_units in zip(samples, per_sample, strict=True):
        for o, mine in zip(sample.obligations, sample_units, strict=True):
            new = [u for u in mine if u in kept and u not in emitted]
            if not new:
                continue
            emitted.update(new)
            clauses = [key for key, _ in new if not key.startswith("#")]
            merged.append(o.model_copy(update={"clauses": clauses}))

    kept_clauses = {c for o in merged for c in o.clauses}
    set_aside: dict[str, SetAside] = {}
    for sample in samples:
        for a in sample.set_aside:
            if a.clause not in kept_clauses:
                set_aside.setdefault(a.clause, a)
    return Disposition(obligations=merged, set_aside=list(set_aside.values())), agreement


# Obligations per translator call: each comes with its paragraph, so ten is a few thousand tokens
# in and a few thousand out, well inside a call's time; more per call is fewer, slower calls.
TRANSLATE_BATCH = 10

# A cross-reference in a paragraph: "paragraph 6.2.3.", "paragraphs 5.1 and 5.2" (the first is
# taken), "paragraph 2 of Annex 4". Only numbered paragraphs: a bare "Annex 4" is a whole annex,
# too long to attach, and stays a look-up.
_REFERENCE = re.compile(r"\bparagraphs?\s+(\d+(?:\.\d+)*)\.?(?:\s+of\s+Annex\s+(\d+[A-Z]?))?")
# Referenced paragraphs attached per translator call, and characters of each: 8 of 1,500 is
# about 3k tokens more per call, small next to the case the call already carries.
_REFERRED_MAX = 8
_REFERRED_CHARS = 1_500


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
        referred = self.referred_to()
        if referred:
            lines += ["# Paragraphs these obligations refer to", ""]
            for r in referred:
                text = (
                    r.text if len(r.text) <= _REFERRED_CHARS else r.text[:_REFERRED_CHARS] + " ..."
                )
                lines += [f"{r.label} (page {r.page_start})", text, ""]
        return "\n".join(lines)

    def referred_to(self) -> list[Paragraph]:
        """The paragraphs the obligations' own paragraphs name ("as specified in paragraph
        6.2.3.", "paragraph 2 of Annex 4"), resolved in the obligation's own annex or part first,
        then in the main body. Why attached and not left to read_version_paragraphs: a translator
        that does not think of looking writes the requirement without the values, and each
        look-up is another model turn in a run with 770 s for everything. Capped at
        _REFERRED_MAX per call so the input stays a few thousand tokens."""
        by_position = {p.position: p for p in self.window.paragraphs}
        own = {o.ref for o in self.obligations}
        out: list[Paragraph] = []
        for o in self.obligations:
            p = by_position[o.ref]
            scope = p.label.rsplit(" ", 1)[0] if p.label and " " in p.label else ""
            for number, annex in _REFERENCE.findall(p.text):
                candidates = [f"Annex {annex} {number}"] if annex else [f"{scope} {number}", number]
                for label in candidates:
                    found = [
                        r
                        for r in self.by_label.get(label.strip(), [])
                        if r.position not in own and r.id not in {x.id for x in out}
                    ]
                    if found:
                        out.append(found[0])
                        break
                if len(out) >= _REFERRED_MAX:
                    return out
        return out


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
    # How many requirements each paragraph may get: one per obligation, or one per clause when an
    # obligation lists several (each "shall" sentence or list item the code found).
    allowed: Counter[int] = Counter()
    for o in ctx.deps.obligations:
        allowed[o.ref] += max(1, len(o.clauses))
    wrong = sorted({d.ref for d in drafts if d.ref not in allowed})
    if wrong:
        raise ModelRetry(
            f"[#{', #'.join(map(str, wrong))}] are not the paragraphs of these obligations. Cite "
            "the [#n] each obligation is headed with."
        )
    drafts = [d for d in drafts if d.text.strip()]
    written = Counter(d.ref for d in drafts)
    over = sorted(ref for ref, n in written.items() if n > allowed[ref])
    # One requirement per obligation (Clemente, 2026-10-25: "make sure one obligation, one
    # requirement is met"): a translator splitting freely multiplied the output (634 requirements
    # on dev for a key of 190). One per obligation flat may cost recall wherever the first stage
    # lists one obligation for several clauses (matched fell to 115 of 190 after it; the cause is
    # not measured). So the bound is the code's own split: one per clause, never more. Asked
    # once; then the first ones per paragraph are kept.
    if over and ctx.retry == 0:
        raise ModelRetry(
            f"[#{', #'.join(map(str, over))}]: more requirements than the obligations and clauses "
            "listed. Write one requirement per obligation, or one per clause when an obligation "
            "lists several clauses that each oblige something. Answer again."
        )
    kept: list[Draft] = []
    for d in drafts:
        if allowed[d.ref] > 0:
            kept.append(d)
            allowed[d.ref] -= 1
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


# Words that carry no obligation of their own: two requirements on one paragraph that differ only
# in these (and in word order, case, punctuation or a plural "s") state the same obligation.
# "not", "no", numbers, "minimum"/"maximum" and every noun are NOT here, so "one device" and "two
# devices", or a limit of 45° and one of 30°, stay apart.
_FILLER = frozenset(
    {"a", "an", "the", "of", "shall", "must", "be", "is", "are", "and", "or", "to", "in", "for"}
    | {"with", "by", "as", "at", "on", "which", "that", "this", "these", "those", "each"}
    | {"every", "its", "their", "it", "they", "there", "where", "when"}
)


def _content_words(text: str) -> tuple[str, ...]:
    # Counted, not a set: "for 12 V ... 12 V / 24 V" and "for 24 V ... 12 V / 24 V" hold the same
    # words and are two obligations.
    words = re.findall(r"[a-z]+|\d+(?:[.,]\d+)?", text.lower())
    return tuple(
        sorted(w.removesuffix("s") if len(w) > 3 else w for w in words if w not in _FILLER)
    )


def code_findings(rows: Sequence[Requirement], cited: dict[UUID, Paragraph]) -> dict[str, str]:
    """What code alone can tell: a citation that no longer matches the library, and duplicates
    on one paragraph (the same words, or the same content words in another order or form), which
    only lower precision: the platform matches one to one, so a second copy never scores."""
    found: dict[str, str] = {}
    seen: dict[tuple[UUID | None, str], str] = {}
    near: dict[tuple[UUID | None, tuple[str, ...]], str] = {}
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
        loose = (r.paragraph_id, _content_words(r.text))
        if key in seen:
            found[r.ext_id] = f"Duplicate of {seen[key]}: same paragraph, same text."
        elif loose in near:
            found[r.ext_id] = (
                f"Duplicate of {near[loose]}: same paragraph, same obligation in other words."
            )
        else:
            seen[key] = r.ext_id
            near[loose] = r.ext_id
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
