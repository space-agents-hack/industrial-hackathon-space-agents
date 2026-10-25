"""The writer step of a sub-goal run (#42, SYS-45): a model writes each change's `new_text`, and
code checks it against the regulation before it replaces the rules' text.

Why: on the dev upload of 2026-10-24 23:45 CEST, detection was right but the texts lost points.
The platform scores flag recall and the accuracy of each change's text, and its key states each
change as a requirement (subgoal-text-proposal.md). The rules copied the regulation instead:
- an added sentence with two obligations became one change, and matching is one to one, so the
  second obligation counted as missed;
- a modified requirement's text was the new paragraph as printed, not the old requirement updated,
  so it carried what other requirements cover;
- lead-ins were glued to each step and headings' conditions were left out.
The main goal's writer learned the same lesson (translate.md): one obligation per requirement, in
the regulation's words, standing alone.

What code checks, per change, before a text is used (`problems`):
- at most 2,000 characters (the schema's cap) and, for `modified`, exactly one text;
- every number of the new wording is kept: for `modified`, those of what was added or replaced;
  for `added`, all of them across its texts;
- no number the new version deleted comes back;
- what was added or replaced (`modified`), or the new wording (`added`), is covered by the texts'
  words;
- few words that are in neither the regulation nor the old requirement: the text says what the
  regulation says.
The first answer with problems is sent back once with them listed. After that, a change whose
texts still fail keeps the rules' text, and the trace names it.

What this does NOT do: decide what changed, the type of a change, or its page and paragraph. Those
stay with the rules and the reviewer (`regdiff`, `subgoal_review`). It also does not reorder the
file: a split added change stays where the rules put it.
"""

import asyncio
import re
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field, replace
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field
from pydantic_ai import Agent, ModelRetry, RunContext, ToolOutput, UsageLimits
from pydantic_ai.models import Model
from pydantic_ai.usage import RunUsage

from agent_service.domain import regdiff
from agent_service.domain.subgoal_review import Limits

# The main goal's near-duplicate test (3a7a849), one copy so the two cannot drift apart.
from agent_service.domain.writer import _content_words  # pyright: ignore[reportPrivateUsage]

_HERE = Path(__file__).parent
_TEXT_MAX = 2000
# A list or a step-by-step procedure rarely holds more obligations than this; more texts than
# this for one change means the model is writing the paragraph, not the change.
_MAX_TEXTS = 12
# Share of the changed words the texts must contain. Not all: an obligation reworded to stand
# alone ("the vehicle shall" where the regulation says "it shall") loses a few.
_COVERAGE_MIN = 0.8
# Share of a text's words that may be in neither the regulation nor the old requirement: the
# subject named from a heading, "shall" for "is". Above it, the text says something else.
_FOREIGN_MAX = 0.2
# A text this short in words cannot be judged by shares: two foreign words are half of it.
_FOREIGN_SLACK = 2
_CONTEXT_CHARS = 6000
_REQUESTS = 3
_INPUT_TOKENS = 60_000
_NUMBER = re.compile(r"\d")


@dataclass
class Item:
    """One change to write: the rules' change and what the model reads for it."""

    key: str
    change: regdiff.Change
    requirement: str | None
    headings: list[str]
    paragraph: str

    @property
    def source(self) -> str:
        return self.change.source_text or self.change.new_text or ""


class Written(BaseModel):
    id: str = Field(description="The change's id, exactly as listed (C1, C2, ...).")
    texts: list[str] = Field(
        description="The change's text. Exactly one for `modified`; for `added`, one per "
        "obligation."
    )


@dataclass(frozen=True)
class WriteDeps:
    items: dict[str, Item]


write_agent = Agent(
    name="change-writer",
    deps_type=WriteDeps,
    output_type=ToolOutput(list[Written], name="record_texts"),
    instructions=(_HERE / "subgoal_write.md").read_text(),
    retries=2,
)


@write_agent.output_validator
def _validate(ctx: RunContext[WriteDeps], answer: list[Written]) -> list[Written]:
    # Sent back once: a second answer with problems is accepted, and only the texts that still
    # fail fall back to the rules' wording. Another retry would be another full answer for a
    # few texts, and the run has a minute.
    if ctx.retry >= 1:
        return answer
    got = {w.id: w for w in answer}
    lines: list[str] = []
    for key, item in ctx.deps.items.items():
        if key not in got:
            lines.append(f"{key}: no answer.")
            continue
        lines += [f"{key}: {p}" for p in problems(item, got[key].texts)]
    if lines:
        raise ModelRetry(
            "Some texts fail the check against the regulation. Fix them and answer again for "
            "every change:\n" + "\n".join(lines[:40])
        )
    return answer


# ------------------------------------------------------------------------------------------
# What the model reads
# ------------------------------------------------------------------------------------------


def _ancestors(label: str) -> list[str]:
    parts = label.rstrip(".").split(".")
    return [".".join(parts[:k]) for k in range(1, len(parts) + 1)]


def items(
    changes: Sequence[regdiff.Change], requirements: Sequence[dict[str, Any]], new: regdiff.Version
) -> list[Item]:
    """The changes with a text to write, each with its context in the new version: the headings
    above its paragraph and the whole paragraph."""
    text_of = {str(r["id"]): str(r.get("text", "")) for r in requirements}
    out: list[Item] = []
    for change in changes:
        if change.change == "removed" or not (change.source_text or change.new_text):
            continue
        label = (change.paragraph or "").rstrip(".")
        wanted = set(_ancestors(label)) if label else set()
        headings = [s.text for s in new.segments if s.heading and s.label.rstrip(".") in wanted]
        body = " ".join(
            s.text for s in new.segments if not s.heading and s.label.rstrip(".") == label
        )
        out.append(
            Item(
                f"C{len(out) + 1}",
                change,
                text_of.get(change.requirement_id or ""),
                headings,
                body[:_CONTEXT_CHARS],
            )
        )
    return out


def render(batch: Sequence[Item]) -> str:
    lines = [f"{len(batch)} change(s) to write.", ""]
    for it in batch:
        c = it.change
        where = f"paragraph {c.paragraph or '?'}, page {c.page or '?'}"
        what = c.reason.split(": ", 1)[1] if ": " in c.reason else c.reason
        if c.change == "modified":
            lines += [
                f"### {it.key} (modified {c.requirement_id}, {where})",
                f"Old requirement: {it.requirement or ''}",
                f"Old regulation text it was written from: {c.old_text or '(not traced)'}",
                f"New regulation text: {it.source}",
                f"What changed: {what}",
            ]
        else:
            lines += [
                f"### {it.key} (added, {where})",
                f"New regulation text: {it.source}",
            ]
        lines += [
            f"Headings above it: {' / '.join(it.headings) or '(none)'}",
            f"Whole paragraph in the new version: {it.paragraph or '(not found)'}",
            "",
        ]
    return "\n".join(lines)


# ------------------------------------------------------------------------------------------
# The check
# ------------------------------------------------------------------------------------------


def _numbers(norm: str) -> set[str]:
    return {w for w in norm.split() if _NUMBER.search(w)}


def _changed(old: str, new: str) -> str:
    """What `new` adds or replaces relative to `old`, normalised: the words a modified text must
    carry."""
    a, b = regdiff.normalize(old).split(), regdiff.normalize(new).split()
    out: list[str] = []
    for op, _, _, j1, j2 in SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        if op in ("insert", "replace"):
            out += b[j1:j2]
    return " ".join(out)


def problems(item: Item, texts: Sequence[str]) -> list[str]:
    """Why these texts may not replace the rules' text for this change; empty when they may."""
    c = item.change
    found: list[str] = []
    texts = [t.strip() for t in texts]
    if not texts or not all(texts):
        return ["an empty text."]
    if c.change == "modified" and len(texts) != 1:
        found.append(f"{len(texts)} texts for a modified requirement; write exactly one.")
    if len(texts) > _MAX_TEXTS:
        found.append(f"{len(texts)} texts; write one per obligation of the change only.")
    for k, t in enumerate(texts, 1):
        if len(t) > _TEXT_MAX:
            found.append(f"text {k} has {len(t)} characters; the limit is {_TEXT_MAX}.")

    written = regdiff.normalize(" ".join(texts))
    words, numbers = regdiff.content_words(written), _numbers(written)
    source = regdiff.normalize(item.source)
    own = {regdiff.normalize(c.paragraph or "")} - {""}
    if c.change == "modified":
        must = _changed(c.old_text or "", item.source) if c.old_text else source
    else:
        must = source
    missing = sorted(_numbers(must) - numbers - own)
    if missing:
        found.append(f"numbers of the new wording are missing: {', '.join(missing[:10])}.")
    if c.old_text:
        gone = _numbers(regdiff.normalize(c.old_text)) - _numbers(source)
        back = sorted(gone & numbers)
        if back:
            found.append(f"numbers the new version deleted are still there: {', '.join(back)}.")
    needed = regdiff.content_words(must)
    if needed and len(needed & words) / len(needed) < _COVERAGE_MIN:
        left = sorted(needed - words)[:12]
        found.append(f"the change is not all there; missing words: {', '.join(left)}.")
    known = regdiff.content_words(
        regdiff.normalize(
            " ".join([item.source, item.paragraph, *item.headings, item.requirement or ""])
        )
    )
    foreign = words - known
    if len(foreign) > _FOREIGN_SLACK and len(foreign) / max(len(words), 1) > _FOREIGN_MAX:
        found.append(f"words the regulation does not contain: {', '.join(sorted(foreign)[:12])}.")
    return found


# ------------------------------------------------------------------------------------------
# Running the batches
# ------------------------------------------------------------------------------------------


@dataclass
class Report:
    changes: list[regdiff.Change]
    usage: RunUsage
    written: int = 0
    kept_rules: list[str] = field(default_factory=list)
    failed: list[str] = field(default_factory=list)
    split: int = 0
    duplicates: list[str] = field(default_factory=list)

    def summary(self) -> dict[str, Any]:
        return {
            "written": self.written,
            "added_split_into": self.split,
            "kept_rules_text": self.kept_rules[:60],
            "dropped_as_duplicates": self.duplicates[:60],
            "failed_batches": self.failed,
        }


def _name(item: Item) -> str:
    c = item.change
    return c.requirement_id or f"added at {c.paragraph}"


async def write(
    changes: list[regdiff.Change],
    requirements: Sequence[dict[str, Any]],
    new: regdiff.Version,
    model: Model | str,
    limits: Limits,
    progress: Callable[[str], Awaitable[None]],
) -> Report:
    todo = items(changes, requirements, new)
    size = max(1, limits.batch_size)
    batches = [todo[i : i + size] for i in range(0, len(todo), size)]
    await progress(
        f"Writing {len(todo)} change text(s) as requirements, in {len(batches)} batch(es), "
        f"{limits.concurrency} at a time."
    )
    semaphore = asyncio.Semaphore(max(1, limits.concurrency))
    usage = RunUsage()
    loop = asyncio.get_running_loop()
    report = Report(list(changes), usage)

    def has_time() -> bool:
        return limits.deadline is None or loop.time() + limits.timeout_s < limits.deadline

    async def attempt(batch: list[Item], label: str) -> dict[str, list[str]] | str:
        started = loop.time()
        try:
            async with asyncio.timeout(limits.timeout_s):
                result = await write_agent.run(
                    render(batch),
                    model=model,
                    deps=WriteDeps({it.key: it for it in batch}),
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
                f"Writing batch {label} failed after {loop.time() - started:.0f} s: {failure}"
            )
            return failure
        usage.incr(result.usage)
        await progress(
            f"Writing batch {label}: {len(result.output)} of {len(batch)} texts in "
            f"{loop.time() - started:.0f} s, {result.usage.input_tokens} tokens in, "
            f"{result.usage.output_tokens} out."
        )
        return {w.id: w.texts for w in result.output}

    async def one(batch: list[Item], label: str) -> dict[str, list[str]] | str | None:
        # A failed batch is tried again at once, as the reviewer's is (e38811b): waiting for the
        # round's slowest batch first would add its time to the run.
        async with semaphore:
            if not has_time():
                return None
            outcome = await attempt(batch, label)
            if isinstance(outcome, str) and has_time():
                outcome = await attempt(batch, f"{label}, second try")
            return outcome

    outcomes = await asyncio.gather(
        *(one(b, f"{i} of {len(batches)}") for i, b in enumerate(batches, 1))
    )
    texts: dict[str, list[str]] = {}
    for batch, outcome in zip(batches, outcomes, strict=True):
        if isinstance(outcome, dict):
            texts.update(outcome)
        elif isinstance(outcome, str):
            report.failed.append(f"{', '.join(_name(it) for it in batch)}: {outcome}")

    # The failures of a whole batch are listed above; a change of a batch that answered but
    # whose texts fail the check is named here.
    answered = {
        it.key for b, o in zip(batches, outcomes, strict=True) if isinstance(o, dict) for it in b
    }
    by_change = {id(it.change): it for it in todo}
    out: list[regdiff.Change] = []
    for change in changes:
        it = by_change.get(id(change))
        if it is None:
            out.append(change)
            continue
        got = texts.get(it.key)
        if got is None or problems(it, got):
            if it.key in answered:
                report.kept_rules.append(_name(it))
            out.append(change)
            continue
        report.written += 1
        clean = [t.strip() for t in got]
        if change.change == "added" and len(clean) > 1:
            report.split += len(clean) - 1
        out += [replace(change, new_text=t) for t in clean]
    report.changes = _without_duplicates(out, report)
    return report


def _without_duplicates(changes: list[regdiff.Change], report: Report) -> list[regdiff.Change]:
    """An added text that states what another text of the same paragraph states, in other words,
    is dropped. Splitting per obligation can write one twice (a lead-in repeated into each item,
    then the lead-in alone), and the platform matches one to one, so a second copy never scores.
    A modified or removed change is never dropped: it carries a requirement's id."""
    seen: set[tuple[str, tuple[str, ...]]] = set()
    out: list[regdiff.Change] = []
    for c in changes:
        key = ((c.paragraph or "").rstrip("."), _content_words(c.new_text or ""))
        if c.change == "added" and c.new_text and key in seen:
            report.duplicates.append(f"added at {c.paragraph}: {c.new_text[:80]}")
            continue
        if c.new_text:
            seen.add(key)
        out.append(c)
    return out
