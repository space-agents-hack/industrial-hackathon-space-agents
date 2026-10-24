"""The scope screen: every regulation of the library judged against the product profile, before
anything is written (#33; docs/se SYS-44, refining SYS-28).

Why every regulation and not the search hits: on the dev case the one regulation that was missed
applies because of something the part contains, and no query was written for it. Search recall
depends on someone thinking of the query; reading the scope section of all ~56 regulations does
not. Scope sections are short (the paragraphs of section 1), so the whole library is a few calls.

Why the introduction and the transitional provisions too: two regulations of the library can
cover the same function (a newer one that took over an older one's subject). Search ranks them
side by side because their words are the same. Whether one replaces the other is written in
their own text, so the screen reads it and reports it; the orchestrator decides with that
evidence, and keeps both when there is none (SYS-44). Nothing here names a regulation or
decides by one.

Search and rules (Certivity's second tip, #53): code also runs one search per function and
component of the profile and shows each regulation's ranks next to its scope, and fixed rules
(`decide`) turn verdicts and ranks into what to read. What this does NOT do: leave a regulation
out on search ranks (rule 3 logs only, RULE3_LIVE), judge near-twins (the orchestrator does, on
quoted evidence), or stop the orchestrator from adding one with a reason.
"""

import re
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field
from pydantic_ai import Agent, ModelRetry, RunContext, ToolOutput

from agent_service.records import LibraryVersion, Paragraph

# Section 1 of a UN regulation is its scope: "1", "1.1", "1.2.3", never "10" or "Annex 1 1.1".
_SCOPE_LABEL = re.compile(r"1(\.\d+)*")
_TRANSITIONAL = re.compile(r"transitional provisions", re.IGNORECASE)
# Per regulation. A scope runs to a few hundred words; the transitional provisions of an often
# amended regulation run to pages, and their first paragraphs say what replaces what. The
# introduction (the unnumbered text before section 1) is where a regulation that took over the
# subject of others says so ("combines the provisions of Regulations Nos. ..."); the older ones
# usually say nothing about it, so without the introduction the screen had no evidence either way.
INTRODUCTION_CHARS = 2_000
SCOPE_CHARS = 3_000
TRANSITIONAL_CHARS = 2_500
# Regulations per screen call: about 12 x 6k characters, 20k tokens, read without skimming.
BATCH = 12

_HERE = Path(__file__).parent


@dataclass(frozen=True)
class Evidence:
    """Where one search for a profile entry ranked a regulation: `rank` among the regulations the
    search hit, by their best paragraph (1 is the best), and how many of its paragraphs came
    back."""

    entry: str
    rank: int
    paragraphs: int
    hit: int


@dataclass(frozen=True)
class Candidate:
    version: LibraryVersion
    scope: str
    transitional: str
    introduction: str = ""
    # Best rank first. Empty: no search for a function or component found it.
    evidence: tuple[Evidence, ...] = ()
    # Whether code ran searches at all (a profile with no functions or components runs none).
    searched: bool = False

    def render(self) -> str:
        v = self.version
        lines = [f"## {v.regulation}: {v.title or 'no title'} (version {v.version_label})", ""]
        if v.scope_summary:
            lines += [f"Summary of its scope (written by an indexer): {v.scope_summary}", ""]
        if self.introduction:
            lines += ["Introduction (start):", self.introduction, ""]
        lines += ["Scope section:", self.scope or "(no section 1 was extracted)", ""]
        if self.transitional:
            lines += ["Transitional provisions (start):", self.transitional, ""]
        if self.searched:
            lines += ["Search by profile entry:", describe(self.evidence), ""]
        return "\n".join(lines)


def candidate(version: LibraryVersion, paragraphs: Sequence[Paragraph]) -> Candidate:
    """What the screen reads of one version: its introduction, its scope section and the start of
    its transitional provisions, each capped. A version whose section 1 was not found shows its
    opening text as the scope instead."""
    scope = [p.text for p in paragraphs if p.label and _SCOPE_LABEL.fullmatch(p.label)]
    introduction: list[str] = []
    if scope:
        for p in paragraphs:
            if p.label:
                break
            introduction.append(p.text)
    else:
        scope = [p.text for p in paragraphs[:8]]
    transitional = [
        p.text for p in paragraphs if _TRANSITIONAL.search(p.heading) or _TRANSITIONAL.match(p.text)
    ]
    return Candidate(
        version,
        _cap("\n".join(scope), SCOPE_CHARS),
        _cap("\n".join(transitional), TRANSITIONAL_CHARS),
        _cap("\n".join(introduction), INTRODUCTION_CHARS),
    )


def _cap(text: str, chars: int) -> str:
    return text if len(text) <= chars else text[:chars] + " [...]"


def batches(candidates: Sequence[Candidate], size: int = BATCH) -> list[list[Candidate]]:
    return [list(candidates[i : i + size]) for i in range(0, len(candidates), size)]


class Verdict(BaseModel):
    regulation: str = Field(description="The regulation's code, exactly as its heading gives it.")
    verdict: Literal["applies", "possibly", "does_not"]
    reason: str = Field(max_length=600, description="One or two sentences.")
    scope_quote: str = Field(
        max_length=600, description="The sentence of its scope that decides it, copied."
    )
    profile_entries: list[str] = Field(
        default_factory=list[str],
        description="The profile entries its scope covers, each copied word for word from the "
        "profile. Empty for does_not.",
    )
    replacement: str = Field(
        default="",
        max_length=800,
        description="What its own text says about combining, replacing or taking over other "
        "regulations, being replaced by one, or no longer granting approvals, quoted. Empty if "
        "it says nothing.",
    )


screen_agent = Agent(
    name="regulation-screen",
    deps_type=list[Candidate],
    output_type=ToolOutput(list[Verdict], name="report_screen"),
    instructions=(_HERE / "screen.md").read_text(),
    retries=2,
)


@screen_agent.output_validator
def _one_verdict_each(ctx: RunContext[list[Candidate]], verdicts: list[Verdict]) -> list[Verdict]:
    shown = {c.version.regulation for c in ctx.deps}
    given = [v.regulation for v in verdicts]
    missing = sorted(shown - set(given))
    unknown = sorted(set(given) - shown)
    if missing or unknown:
        raise ModelRetry(
            "Give exactly one verdict for each regulation shown above."
            + (f" Missing: {', '.join(missing)}." if missing else "")
            + (f" Not shown here: {', '.join(unknown)}." if unknown else "")
        )
    # Two verdicts for one regulation: the last one stands.
    return list({v.regulation: v for v in verdicts}.values())


# ------------------------------------------------------------------------------------------
# Search evidence and the fixed rules (Certivity's second tip: scope by rules and by search)
# ------------------------------------------------------------------------------------------

# Rule 3's line: a `possibly` is "without search evidence" when no search for a function or a
# component ranks it among the first TOP regulations. Five was fixed in the plan before any run
# (certivity-tips-plan.md), not fitted to a score; a library of ~56 regulations has 3 to 10 that
# share a part's subject. The rule only logs (SHADOW) until a dev run shows what it would cut.
TOP = 5
RULE3_LIVE = False


def evidence(searches: Sequence[tuple[str, Sequence[str]]]) -> dict[str, list[Evidence]]:
    """Per regulation, where each search ranked it. `searches` is (profile entry, the regulation
    code of every paragraph hit, best first), one per search code ran."""
    out: dict[str, list[Evidence]] = {}
    for entry, codes in searches:
        order = list(dict.fromkeys(codes))
        counts = Counter(codes)
        for rank, code in enumerate(order, start=1):
            out.setdefault(code, []).append(Evidence(entry, rank, counts[code], len(order)))
    for found in out.values():
        found.sort(key=lambda e: (e.rank, -e.paragraphs, e.entry))
    return out


def reciprocal_rank(found: Sequence[Evidence]) -> float:
    return sum(1 / e.rank for e in found)


def describe(found: Sequence[Evidence], most: int = 4) -> str:
    if not found:
        return "No search for a function or component of the profile found it."
    shown = [
        f'ranked {e.rank} of {e.hit} regulations for "{e.entry}" ({e.paragraphs} paragraph(s))'
        for e in found[:most]
    ]
    if len(found) > most:
        shown.append(f"and {len(found) - most} more entries")
    return "; ".join(shown) + "."


def _numbers(code: str) -> list[str]:
    return re.findall(r"\d+", code)


def named_in_case(code: str, named: Sequence[str]) -> str | None:
    """The profile's `named_in_case` line that names this regulation, if any. Matched on the code
    as the library writes it, or on its number after "R", "Regulation No." or before "R" as an
    approval mark writes it ("E4 nnnR-00"). General, not a list of regulations."""
    # Lookarounds, not \b: a code may end in a non-word character.
    whole = re.compile(
        r"(?<!\w)" + r"\s*".join(map(re.escape, code.split())) + r"(?!\w)", re.IGNORECASE
    )
    numbers = _numbers(code)
    number = numbers[-1].lstrip("0") if numbers else None
    patterns = [whole]
    if number and re.search(r"\bR\s?-?\d", code, re.IGNORECASE):
        patterns += [
            re.compile(rf"\b(?:R|Regulation\s+No\.?)\s?-?0*{number}\b", re.IGNORECASE),
            re.compile(rf"\b0*{number}\s?R\b"),
        ]
    for line in named:
        if any(p.search(line) for p in patterns):
            return line
    return None


@dataclass(frozen=True)
class Decision:
    regulation: str
    read: bool
    because: str
    verdict: str | None
    # Rule 3, in shadow: this `possibly` would be left out if the rule were live.
    rule3: bool = False


def decide(
    codes: Sequence[str],
    verdicts: Sequence["Verdict"],
    found: dict[str, list[Evidence]],
    named: Sequence[str],
    live: bool = RULE3_LIVE,
) -> list[Decision]:
    """The fixed rules over the screen's verdicts and the search evidence, in this order:

    1. a regulation the case names is read;
    2. `applies` is read;
    3. `possibly` is read, unless no search ranks it in the first TOP regulations for any entry:
       then it is marked, and left out only when the rule is live;
    4. anything else (`does_not`, or no verdict because its screen call failed) is not read here.

    The "as built" test is the screen's (screen.md), and near-twins are the orchestrator's: both
    need the text, which code does not judge. Same verdicts and hits, same result (V-44)."""
    by_code = {v.regulation: v for v in verdicts}
    out: list[Decision] = []
    for code in codes:
        v = by_code.get(code)
        verdict = v.verdict if v else None
        if line := named_in_case(code, named):
            out.append(Decision(code, True, f"named in the case: {line}", verdict))
        elif verdict == "applies":
            out.append(Decision(code, True, "its scope applies", verdict))
        elif verdict == "possibly":
            best = min((e.rank for e in found.get(code, [])), default=None)
            if best is not None and best <= TOP:
                out.append(Decision(code, True, "its scope possibly applies", verdict))
            else:
                why = (
                    f"its scope possibly applies, and no search ranks it in the first {TOP} "
                    "regulations for any function or component"
                )
                out.append(Decision(code, not live, why, verdict, rule3=True))
        elif verdict == "does_not":
            out.append(Decision(code, False, "its scope does not apply", verdict))
        else:
            out.append(Decision(code, False, "not screened", verdict))
    return out


def shared_entries(verdicts: Sequence[Verdict]) -> list[dict[str, object]]:
    """Profile entries that more than one applying regulation covers: where two regulations may
    be near-twins, and the orchestrator has to look at the evidence (SYS-44)."""
    by_entry: dict[str, list[str]] = {}
    for v in verdicts:
        if v.verdict == "does_not":
            continue
        for entry in dict.fromkeys(e.strip() for e in v.profile_entries if e.strip()):
            by_entry.setdefault(entry, []).append(v.regulation)
    return [
        {"profile_entry": entry, "regulations": sorted(regs)}
        for entry, regs in by_entry.items()
        if len(regs) > 1
    ]
