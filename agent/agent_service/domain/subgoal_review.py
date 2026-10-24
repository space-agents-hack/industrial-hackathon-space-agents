"""Reviewer agents for a sub-goal run (#42, SYS-45): a model re-reads the requirements whose cited
paragraph changed, and code decides what its answer may change.

Why a reviewer: the rules diff (`regdiff`) traces each old requirement to the sentences it was
written from by word overlap. Certivity rewords the regulation when it writes requirements, so a
requirement can be traced to the wrong sentence of its paragraph. Then a change to a neighbouring
sentence flags it, or a change to its own sentence is missed. Only the dev case has reworded
requirements, so this was the one risk we could not measure (subgoal-gaps.md). A model reads a
reworded sentence better than word overlap does.

Why code checks every answer, as the main goal's check does (SYS-29): a model that quotes a
sentence can misquote it. A verdict changes the result only through text found in the PDFs:
- `old_quote`, the sentence the requirement came from, must appear in the old version. Code then
  diffs that sentence with the same rules (`regdiff.requirement_changes`), so `new_text` is
  still the regulation's own new wording and the page and paragraph are copied by code.
- `new_quote`, for `modified`, must appear in the new version and not in the old one.

How a verdict and the rules combine. Recall first, because the platform scores recall of the
flagged requirements:
- A requirement the rules flagged stays flagged. The only exception is when both the corrected
  trace and the reviewer say it did not change.
- A requirement the rules missed is added when the corrected trace finds a change and the reviewer
  agrees, or when the reviewer's `new_quote` passes the check.
- A flag that the rules called `removed` becomes `modified` when the reviewer's `new_quote`
  passes the check, because the sentence moved and was reworded beyond what the pairing finds.
- An `added` entry whose text a newly flagged requirement now accounts for is dropped, so the same
  sentence is not reported twice.

The batches run in parallel, `concurrency` at a time, each with its own timeout. A failed batch
is tried once more while the run has time. A batch that still fails keeps the rules' answer, and
the trace names its requirements. These are the main goal's lessons (e3c19a4, 8167ef2): a call
that hangs must not take the run with it, and a failure says what was not done.

What this does NOT do: write `added` entries (the rules do, from unpaired new sentences), or
review requirements whose paragraph did not change at all. Those are unchanged by construction.
"""

import asyncio
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field
from pydantic_ai import Agent, RunContext, ToolOutput, UsageLimits
from pydantic_ai.models import Model
from pydantic_ai.usage import RunUsage

from agent_service.domain import regdiff

_HERE = Path(__file__).parent
# A requirement's two paragraphs are rarely long, but a page-wide fallback or a rewritten annex
# can be; past this the prompt grows without helping the judgement.
_OLD_CHARS = 4000
_NEW_CHARS = 6000
# A quote this short ("the vehicle") is found anywhere and proves nothing.
_MIN_QUOTE_WORDS = 4
_SEARCH_HITS = 5
# Per reviewer call: the answer plus at most two searches. Each search resends the whole prompt,
# so the first production run (2026-10-24), with 8 allowed, spent minutes and dollars on a
# 15-requirement case while the trace showed nothing. A cap on input tokens backs it up.
_REQUESTS = 3
_INPUT_TOKENS = 60_000


@dataclass(frozen=True)
class Limits:
    batch_size: int = 8
    concurrency: int = 6
    timeout_s: float = 240
    # asyncio's loop time after which no new batch starts; None for no limit.
    deadline: float | None = None


@dataclass
class Candidate:
    requirement: dict[str, Any]
    old: list[regdiff.Segment]
    new: list[regdiff.Segment]

    @property
    def id(self) -> str:
        return str(self.requirement["id"])


class Verdict(BaseModel):
    requirement_id: str = Field(description="The requirement's id, exactly as listed.")
    verdict: Literal["unchanged", "modified", "removed"]
    old_quote: str = Field(
        description="The sentence or list item of the OLD text the requirement was written "
        "from, copied exactly."
    )
    new_quote: str | None = Field(
        default=None,
        description="For `modified` only: the sentence(s) of the NEW version that now state the "
        "requirement, copied exactly as printed. Null otherwise.",
    )
    reason: str = Field(description="One sentence: what changed in the obligation, or why not.")


@dataclass(frozen=True)
class ReviewDeps:
    new: regdiff.Version


reviewer_agent = Agent(
    name="change-reviewer",
    deps_type=ReviewDeps,
    output_type=ToolOutput(list[Verdict], name="report_verdicts"),
    instructions=(_HERE / "subgoal_review.md").read_text(),
    retries=2,
)


@reviewer_agent.tool
def search_new_version(ctx: RunContext[ReviewDeps], words: str) -> list[dict[str, Any]]:
    """Find where a sentence of the old version is in the new version, when it is not in the new
    text shown (it moved to another paragraph). Returns the closest sentences by shared words.

    Args:
        words: A few distinctive words of the old sentence.
    """
    wanted = set(regdiff.normalize(words).split())
    if not wanted:
        return []
    scored = sorted(
        (
            (len(wanted & set(s.norm.split())), -s.index, s)
            for s in ctx.deps.new.segments
            if not s.heading
        ),
        key=lambda t: (t[0], t[1]),
        reverse=True,
    )
    return [
        {"paragraph": s.label, "page": s.page, "text": s.text}
        for hits, _, s in scored[:_SEARCH_HITS]
        if hits
    ]


# ------------------------------------------------------------------------------------------
# Which requirements
# ------------------------------------------------------------------------------------------


def _label(label: str | None) -> str:
    return (label or "").strip().rstrip(".").replace(",", "").lower()


def cited_segments(requirement: dict[str, Any], old: regdiff.Version) -> list[regdiff.Segment]:
    """The old segments of the paragraph a requirement cites. This is the same pool
    `regdiff.evidence` searches, but all of it: the reviewer judges the paragraph, not the
    sentences word overlap chose."""
    source = requirement.get("source") or {}
    label = _label(source.get("paragraph"))
    body = [s for s in old.segments if not s.heading]
    pool = [s for s in body if _label(s.label) == label] if label else []
    if not pool and label:
        pool = [s for s in body if _label(s.label).startswith(label + ".")]
    if not pool and source.get("page"):
        pool = [s for s in body if s.page == source["page"]]
    return pool


def candidates(
    requirements: Sequence[dict[str, Any]], old: regdiff.Version, new: regdiff.Version
) -> list[Candidate]:
    """The requirements whose cited paragraph changed in any way, after `regdiff.align`: a sentence
    of it changed or went, or a sentence was inserted where it now is. The others cite text that
    is the same, word for word after normalising, so no reading can find a change in them."""
    out: list[Candidate] = []
    for req in requirements:
        pool = cited_segments(req, old)
        if not pool:
            continue
        labels = {new.segments[s.partner].label for s in pool if s.partner is not None}
        labels |= {s.label for s in pool}
        shown = [n for n in new.segments if n.label in labels and not n.heading]
        changed = any(s.status != "unchanged" for s in pool) or any(
            n.partner is None for n in shown
        )
        if changed:
            out.append(Candidate(req, pool, shown))
    return out


# ------------------------------------------------------------------------------------------
# What the reviewer reads
# ------------------------------------------------------------------------------------------


def _segments(segments: Sequence[regdiff.Segment], limit: int) -> list[str]:
    lines: list[str] = []
    size = 0
    current: tuple[str, int] | None = None
    for s in segments:
        if (s.label, s.page) != current:
            current = (s.label, s.page)
            lines.append(f"{s.label} (page {s.page}):")
        line = f"- {s.text}"
        size += len(line)
        if size > limit:
            lines.append("- [cut here: the paragraph is longer]")
            break
        lines.append(line)
    return lines


def render(batch: Sequence[Candidate], rules: dict[str, regdiff.Change]) -> str:
    lines = [f"{len(batch)} requirement(s) to review.", ""]
    for c in batch:
        req = c.requirement
        source = req.get("source") or {}
        rule = rules.get(c.id)
        finding = f"{rule.change}: {rule.reason}" if rule else "not flagged"
        lines += [
            f"### {c.id}",
            f"Requirement: {req.get('text', '')}",
            f"Cites: paragraph {source.get('paragraph') or '?'}, page {source.get('page') or '?'}",
            "Old version:",
            *_segments(c.old, _OLD_CHARS),
            "New version:",
            *(
                _segments(c.new, _NEW_CHARS)
                or ["- (no paragraph with these numbers; use search_new_version)"]
            ),
            f"Text comparison: {finding}",
            "",
        ]
    return "\n".join(lines)


# ------------------------------------------------------------------------------------------
# Running the batches
# ------------------------------------------------------------------------------------------


@dataclass
class Report:
    changes: list[regdiff.Change]
    usage: RunUsage
    reviewed: int = 0
    decisions: list[dict[str, str]] = field(default_factory=list)
    unverified: list[str] = field(default_factory=list)
    failed: list[str] = field(default_factory=list)
    not_reviewed: list[str] = field(default_factory=list)

    def summary(self) -> dict[str, Any]:
        return {
            "reviewed": self.reviewed,
            "changed_by_review": self.decisions[:60],
            "quotes_not_found": self.unverified[:60],
            "failed_batches": self.failed,
            "not_reviewed_for_time": self.not_reviewed[:200],
        }


async def review(
    found: Sequence[Candidate],
    old: regdiff.Version,
    new: regdiff.Version,
    rules: list[regdiff.Change],
    model: Model | str,
    limits: Limits,
    progress: Callable[[str], Awaitable[None]],
    order: dict[str, int],
) -> Report:
    """`order`: each requirement id's position in requirements_old, for the file's order."""
    by_rule = {c.requirement_id: c for c in rules if c.requirement_id}
    # Requirements citing the same paragraph go together, so a batch reads related text.
    ordered = sorted(found, key=lambda c: (c.old[0].index, c.id))
    size = max(1, limits.batch_size)
    batches = [list(ordered[i : i + size]) for i in range(0, len(ordered), size)]
    await progress(
        f"Reviewing {len(ordered)} requirement(s) whose cited paragraph changed, in "
        f"{len(batches)} batch(es), {limits.concurrency} at a time."
    )
    semaphore = asyncio.Semaphore(max(1, limits.concurrency))
    usage = RunUsage()
    deps = ReviewDeps(new)
    loop = asyncio.get_running_loop()

    def has_time() -> bool:
        return limits.deadline is None or loop.time() + limits.timeout_s < limits.deadline

    async def one(batch: list[Candidate], label: str) -> list[Verdict] | str | None:
        async with semaphore:
            if not has_time():
                return None
            started = loop.time()
            try:
                async with asyncio.timeout(limits.timeout_s):
                    result = await reviewer_agent.run(
                        render(batch, by_rule),
                        model=model,
                        deps=deps,
                        usage_limits=UsageLimits(
                            request_limit=_REQUESTS, input_tokens_limit=_INPUT_TOKENS
                        ),
                    )
            except Exception as exc:
                if isinstance(exc, TimeoutError):
                    failure = f"TimeoutError: no answer within {limits.timeout_s:g} s"
                else:
                    failure = f"{type(exc).__name__}: {exc}"[:300]
                await progress(
                    f"Batch {label} failed after {loop.time() - started:.0f} s: {failure}"
                )
                return failure
            usage.incr(result.usage)
            ids = {c.id for c in batch}
            got = [v for v in result.output if v.requirement_id in ids]
            # One line per batch, so a slow review shows where it is instead of looking stuck.
            await progress(
                f"Batch {label}: {len(got)} of {len(batch)} verdicts in "
                f"{loop.time() - started:.0f} s, {result.usage.input_tokens} tokens in, "
                f"{result.usage.output_tokens} out."
            )
            return got

    verdicts: dict[str, Verdict] = {}
    report = Report(list(rules), usage)
    pending = batches
    for attempt in (1, 2):
        outcomes = await asyncio.gather(
            *(one(b, f"{i} of {len(pending)}") for i, b in enumerate(pending, 1))
        )
        retry: list[list[Candidate]] = []
        for batch, outcome in zip(pending, outcomes, strict=True):
            ids = ", ".join(c.id for c in batch)
            if outcome is None:
                report.not_reviewed += [c.id for c in batch]
            elif isinstance(outcome, str):
                if attempt == 1:
                    retry.append(batch)
                else:
                    report.failed.append(f"{ids}: {outcome}")
            else:
                for v in outcome:
                    verdicts[v.requirement_id] = v
        if not retry:
            break
        await progress(f"{len(retry)} batch(es) failed; trying them once more.")
        pending = retry

    report.reviewed = len(verdicts)
    by_id = {c.id: c for c in ordered}
    reviewed = [(by_id[i], v) for i, v in verdicts.items()]
    report.changes = merge(rules, reviewed, old, new, report, order)
    return report


# ------------------------------------------------------------------------------------------
# What a verdict may change
# ------------------------------------------------------------------------------------------


def _text(version: regdiff.Version) -> str:
    return " " + " ".join(s.norm for s in version.segments if s.norm) + " "


def _found(quote: str | None, haystack: str) -> bool:
    q = regdiff.normalize(quote or "")
    return len(q.split()) >= _MIN_QUOTE_WORDS and f" {q} " in haystack


def _where(quote: str, new: regdiff.Version) -> regdiff.Segment | None:
    """The new segment a quote starts in, for its page and paragraph: code copies the citation,
    as for the main goal's requirements."""
    q = regdiff.normalize(quote)
    for s in new.segments:
        if not s.heading and s.norm and (f" {s.norm} " in f" {q} " or f" {q} " in f" {s.norm} "):
            return s
    head = " ".join(q.split()[:8])
    for s in new.segments:
        if not s.heading and head and head in s.norm:
            return s
    return None


def _quoted(c: Candidate, v: Verdict, new: regdiff.Version) -> regdiff.Change | None:
    assert v.new_quote is not None
    s = _where(v.new_quote, new)
    if s is None:
        return None
    why = v.reason.strip().rstrip(".")
    return regdiff.Change(
        "modified",
        c.id,
        v.new_quote.strip()[:2000],
        f"Paragraph {s.label} of {new.regulation} was amended in version {new.version_label}: "
        f"{why}.",
        s.page,
        s.label,
        old_text=v.old_quote,
        source_text=v.new_quote.strip(),
    )


def merge(
    rules: list[regdiff.Change],
    reviewed: Sequence[tuple[Candidate, Verdict]],
    old: regdiff.Version,
    new: regdiff.Version,
    report: Report,
    order: dict[str, int],
) -> list[regdiff.Change]:
    old_text, new_text = _text(old), _text(new)
    by_rule = {c.requirement_id: c for c in rules if c.requirement_id}
    replaced: dict[str, regdiff.Change | None] = {}
    accounted: list[str] = []

    for c, v in reviewed:
        rule = by_rule.get(c.id)
        old_ok = _found(v.old_quote, old_text)
        new_ok = (
            v.verdict == "modified"
            and _found(v.new_quote, new_text)
            and not _found(v.new_quote, old_text)
        )
        if v.verdict != "unchanged" and not old_ok and not new_ok:
            report.unverified.append(c.id)
        retraced: regdiff.Change | None = None
        if old_ok:
            again = {**c.requirement, "text": v.old_quote}
            found, _ = regdiff.requirement_changes([again], old, new)
            retraced = found[0] if found else None

        decision: regdiff.Change | Literal["keep"] | None = "keep"
        if rule is not None:
            if old_ok and retraced is None and v.verdict == "unchanged":
                decision = None
            elif rule.change == "removed" and new_ok:
                decision = _quoted(c, v, new) or "keep"
        elif v.verdict != "unchanged":
            if retraced is not None and (retraced.change == v.verdict or not new_ok):
                decision = retraced
            elif new_ok:
                decision = _quoted(c, v, new) or "keep"
            elif v.verdict == "removed" and old_ok and not _found(v.old_quote, new_text):
                decision = regdiff.Change(
                    "removed",
                    c.id,
                    None,
                    f"In version {new.version_label} of {new.regulation} the provision "
                    f"'{v.old_quote.strip()[:80]}' no longer appears: {v.reason.strip()}",
                    None,
                    None,
                )
        if decision == "keep":
            continue
        replaced[c.id] = decision
        before = rule.change if rule else "unchanged"
        after = decision.change if decision else "unchanged"
        report.decisions.append(
            {"requirement": c.id, "from": before, "to": after, "why": v.reason[:300]}
        )
        if decision is not None and decision.new_text:
            accounted.append(regdiff.normalize(decision.new_text))

    out: list[regdiff.Change] = []
    for change in rules:
        if change.requirement_id in replaced:
            continue
        if change.change == "added" and change.new_text:
            text = regdiff.normalize(change.new_text)
            if any(text and (text in a or a in text) for a in accounted if a):
                report.decisions.append(
                    {
                        "requirement": f"added at {change.paragraph}",
                        "from": "added",
                        "to": "dropped",
                        "why": "A requirement flagged by the review now accounts for this text.",
                    }
                )
                continue
        out.append(change)
    # Modified and removed first, in the order of requirements_old, then added: as regdiff
    # orders them, so a reviewed file reads like an unreviewed one.
    firsts = [c for c in out if c.change != "added"]
    firsts += [c for c in replaced.values() if c is not None]
    firsts.sort(key=lambda c: order.get(c.requirement_id or "", len(order)))
    return firsts + [c for c in out if c.change == "added"]
