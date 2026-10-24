"""The scope screen: every regulation of the library judged against the product profile, before
anything is written (#33; docs/se SYS-44, refining SYS-28).

Why every regulation and not the search hits: on the dev case the one regulation that was missed
applies because of something the part contains, and no query was written for it. Search recall
depends on someone thinking of the query; reading the scope section of all ~56 regulations does
not. Scope sections are short (the paragraphs of section 1), so the whole library is a few calls.

Why the introduction and the transitional provisions too: two regulations of the library can
cover the same function (a newer one that took over an older one's subject). Search ranks them
side by side because their words are the same. Whether one replaces the other is written in their own text, so the
screen reads it and reports it; the orchestrator decides with that evidence, and keeps both
when there is none (SYS-44). Nothing here names a regulation or decides by one.

What this does NOT do: decide. It returns verdicts with the sentence each rests on; the
orchestrator chooses what to write, and search stays for what the scope does not say.
"""

import re
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
class Candidate:
    version: LibraryVersion
    scope: str
    transitional: str
    introduction: str = ""

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
