"""Sub-goal: which requirements derived from an old version of a regulation must change in the
new version, and why (issue #5, SYS-19). Output is Certivity's sub-goal format
(`certivity/schemas/submission_subgoal.schema.json`).

No model is called. The answer is built from text alone:

1. Both versions are cut into segments: one sentence or one list item each. A paragraph is too
   coarse: in the worked example one paragraph changed, yet only one of the four requirements
   citing it did, because the other three come from sentences that moved, unchanged, to a new
   sub-paragraph.
2. The segments are aligned in document order (difflib), then what is left is paired across the
   whole document, first by identical text (moved), then by similarity (reworded or renumbered).
3. Each old requirement is traced to the segments it was written from, by word overlap inside
   the paragraph it cites. Requirements are paraphrased ("When X, the system shall Y" from "The
   system shall Y when X"), so overlap of words, not of strings.
4. A requirement whose segments all survive unchanged is not reported; one whose segments are
   gone is `removed`; anything else is `modified`, with the new segments as `new_text`.
5. New segments that nothing paired with, outside introduction, scope and definitions, and that
   state an obligation, become `added`.

"Unchanged" is judged after normalising editorial noise: `70%` and `70 per cent`, `6 seconds`
and `6 s`, footnote markers glued to words (`Party3` became `Party4` only because a footnote was
inserted earlier), quotes, hyphens and line breaks. Without it the worked example
flags three requirements whose obligation did not change.

What this does NOT do:
  - judge meaning. A reworded sentence with the same obligation is still `modified`; a changed
    table cell that no sentence repeats is not seen.
  - rewrite text into requirement style. `new_text` is the regulation's new wording, with the
    lead-in of a list prepended to its items so each one reads on its own.
  - read tables or figures as tables. Their text takes part only where it forms sentences.
"""

import argparse
import json
import re
import sys
from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Literal, Protocol

from agent_service.domain import certivity, paragraphs

Status = Literal["unchanged", "modified", "removed", "added"]

# Below this, two segments are different text, not a rewording of each other. Set on the worked
# example: rewordings there score 0.6 and above, unrelated sentences that share boilerplate
# ("the vehicle shall") stay under 0.45.
_PAIR_MIN = 0.5
# A segment is evidence for a requirement when this share of its content words is in the
# requirement. Lower and the lead-in of a list ("The procedure shall be as follows:")
# attaches to every item's requirement, so a change to the lead-in flags all of them.
_EVIDENCE_MIN = 0.6
# The schema caps new_text at 2,000 characters.
_TEXT_MAX = 2000
# Top-level sections whose new text is not a requirement on the product: background,
# applicability, terms, and which approvals Contracting Parties accept when. The worked example's
# expected answer adds nothing from them although all four changed.
_NOT_REQUIREMENTS = re.compile(
    r"^(introduction|scope|definitions?|transitional provisions?)\b", re.IGNORECASE
)
# What makes a new sentence an obligation worth an `added` entry. "at least" and "not more than"
# are there because limits are written without a modal ("The offset is not more than 0.5 m").
_NORMATIVE = re.compile(
    r"\b(shall|must|may|required|not more than|not less than|at least|at most)\b", re.IGNORECASE
)
_LIST_ITEM = re.compile(r"^\((?:[a-z]|[ivxl]+)\)\s")
_LABEL_PREFIX = re.compile(r"^\d+(?:\.\d+)*\.?\s+")
# Abbreviations that end with a dot but do not end a sentence.
_ABBREVIATIONS = ("e.g.", "i.e.", "No.", "no.", "para.", "Rev.", "etc.", "approx.")
# A colon ends a sentence too when a capital follows: "...shall be as follows: The test ...".
_SENTENCE_END = re.compile(r"(?<=[.:])\s+(?=[A-Z“\"])")
_QUOTES = str.maketrans({"\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"'})
_STOPWORDS = frozenset(
    re.findall(
        r"\w+",
        "a an and are as at be been by for from has have in is it its of on or such that the "
        "their then there these this to was were when where which while with shall",
    )
)


class ParagraphLike(Protocol):
    """What this module needs from a paragraph. `agent_service.domain.paragraphs.Paragraph`
    (the store's extraction, #3) has these fields, with a label that is never None here."""

    @property
    def label(self) -> str | None: ...
    @property
    def text(self) -> str: ...
    @property
    def page_start(self) -> int: ...


@dataclass
class Segment:
    """One sentence or list item of a version, with where it is."""

    index: int
    label: str
    page: int
    text: str
    norm: str
    heading: bool = False
    lead: bool = False  # ends with ':' and introduces list items
    item: bool = False
    status: Status = "unchanged"
    partner: int | None = None


@dataclass
class Version:
    regulation: str
    version_label: str
    segments: list[Segment]
    section_titles: dict[str, str] = field(default_factory=dict)


# ------------------------------------------------------------------------------------------
# Text normalisation and segmentation
# ------------------------------------------------------------------------------------------


def normalize(text: str) -> str:
    """The text with editorial differences removed, for deciding "unchanged"."""
    t = text.translate(_QUOTES)
    t = re.sub(r"(?i)\bper\s*cent\b", "%", t)
    t = re.sub(r"(?i)\b(\d+(?:\.\d+)?)\s*(?:seconds?|secs?)\b", r"\1 s", t)
    # A footnote marker glued to a word: "Party3", "direction3." Short words are left
    # alone because "M1" and "N1" are vehicle categories, not footnotes.
    t = re.sub(r"\b([A-Za-z]{3,})\d{1,2}\b", r"\1", t)
    t = re.sub(r"\s*%", "%", t)
    t = t.lower().replace("-", " ")
    return " ".join(re.findall(r"[a-z0-9%]+(?:\.[0-9]+)*", t))


def _words(norm: str) -> set[str]:
    return {w for w in norm.split() if w not in _STOPWORDS}


def _split_sentences(text: str) -> list[str]:
    protected = text
    for i, abbr in enumerate(_ABBREVIATIONS):
        protected = protected.replace(abbr, f"\x00{i}\x00")
    parts = _SENTENCE_END.split(protected)
    out = []
    for part in parts:
        for i, abbr in enumerate(_ABBREVIATIONS):
            part = part.replace(f"\x00{i}\x00", abbr)
        if part.strip():
            out.append(part.strip())
    return out


def _join_lines(lines: list[str]) -> str:
    text = ""
    for line in lines:
        line = line.strip()
        if not line:
            continue
        if text.endswith("-") and line[:1].islower():
            text += line
        else:
            text = f"{text} {line}" if text else line
    return text


def segment_paragraph(label: str, page: int, text: str) -> list[tuple[str, bool, bool, bool]]:
    """(text, heading, lead, item) for each segment of one paragraph, in order."""
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if lines:
        lines[0] = _LABEL_PREFIX.sub("", lines[0], count=1) if label else lines[0]
    out: list[tuple[str, bool, bool, bool]] = []
    # A short first line without a modal, followed by more text, is the paragraph's title:
    # "5.1.11. Interruption by the driver". A wrapped sentence's first line is long.
    if (
        len(lines) > 1
        and len(lines[0]) <= 60
        and not _NORMATIVE.search(lines[0])
        and not lines[0].endswith((":", "."))
    ):
        out.append((lines.pop(0).rstrip(","), True, False, False))
    elif len(lines) == 1 and len(lines[0]) <= 60 and not lines[0].endswith((".", ":", ";")):
        out.append((lines[0].rstrip(","), True, False, False))
        lines = []

    chunks: list[tuple[list[str], bool]] = []
    for line in lines:
        if _LIST_ITEM.match(line) or not chunks:
            chunks.append(([line], bool(_LIST_ITEM.match(line))))
        else:
            chunks[-1][0].append(line)
    for chunk_lines, is_item in chunks:
        joined = _join_lines(chunk_lines)
        # An item's later sentences are split off too: the last item of a list is often followed
        # by a new sentence on the next line ("(d) Record the result. Before any test ..."),
        # and kept together the two would change status together.
        sentences = _split_sentences(joined)
        for i, sentence in enumerate(sentences):
            item = is_item and i == 0
            out.append((sentence, False, sentence.endswith(":"), item))
    return out


def build_version(
    regulation: str, version_label: str, paragraph_list: Iterable[ParagraphLike]
) -> Version:
    segments: list[Segment] = []
    titles: dict[str, str] = {}
    for p in paragraph_list:
        label = p.label or ""
        parts = segment_paragraph(label, p.page_start, p.text)
        top = label.split(".")[0] if label and "." not in label.strip(".") else None
        if top is not None and parts:
            titles[top] = parts[0][0]
        for text, heading, lead, item in parts:
            segments.append(
                Segment(
                    len(segments), label, p.page_start, text, normalize(text), heading, lead, item
                )
            )
    return Version(regulation, version_label, segments, titles)


# ------------------------------------------------------------------------------------------
# Alignment
# ------------------------------------------------------------------------------------------


def _similarity(a: Segment, b: Segment) -> float:
    wa, wb = a.norm.split(), b.norm.split()
    if not wa or not wb:
        return 0.0
    return SequenceMatcher(None, wa, wb, autojunk=False).ratio()


def _proximity(a: str, b: str) -> float:
    """Same paragraph pulls a pair together, another chapter pushes it apart. In the worked
    example a new sentence in the test chapter was closer in words to an old condition in the
    performance chapter than that condition's own rewording was."""
    if a == b:
        return 0.1
    return 0.0 if a.split(".")[0] == b.split(".")[0] else -0.15


def align(old: Version, new: Version) -> None:
    """Set status and partner on every segment of both versions."""
    for s in old.segments:
        s.status, s.partner = "removed", None
    for s in new.segments:
        s.status, s.partner = "added", None

    def pair(o: Segment, n: Segment) -> None:
        status: Status = "unchanged" if o.norm == n.norm else "modified"
        o.status = n.status = status
        o.partner, n.partner = n.index, o.index

    # 1. In order: what did not move.
    matcher = SequenceMatcher(
        None, [s.norm for s in old.segments], [s.norm for s in new.segments], autojunk=False
    )
    for block in matcher.get_matching_blocks():
        for k in range(block.size):
            pair(old.segments[block.a + k], new.segments[block.b + k])

    # 2. Moved without change (text of 5.1 now under a new 5.1.1). Nearest first, so the copy
    #    of a repeated list item that sits where the old one was takes the pairing.
    free_new: dict[str, list[Segment]] = {}
    for n in new.segments:
        if n.partner is None:
            free_new.setdefault(n.norm, []).append(n)
    for o in old.segments:
        if o.partner is None and free_new.get(o.norm):
            candidates = free_new[o.norm]
            best = min(candidates, key=lambda n: abs(n.index - o.index))
            candidates.remove(best)
            pair(o, best)

    # 3. Reworded: best similarity first, with a small preference for the same paragraph so a
    #    sentence stays with its paragraph when a similar one is added elsewhere.
    olds = [o for o in old.segments if o.partner is None and not o.heading]
    news = [n for n in new.segments if n.partner is None and not n.heading]
    scored: list[tuple[float, int, int]] = []
    for o in olds:
        ow = _words(o.norm)
        for n in news:
            nw = _words(n.norm)
            if not ow or not nw or len(ow & nw) / len(ow | nw) < 0.25:
                continue
            score = _similarity(o, n) + _proximity(o.label, n.label)
            if score >= _PAIR_MIN:
                scored.append((score, o.index, n.index))
    scored.sort(reverse=True)
    for _, oi, ni in scored:
        o, n = old.segments[oi], new.segments[ni]
        if o.partner is None and n.partner is None:
            pair(o, n)


# ------------------------------------------------------------------------------------------
# Requirements
# ------------------------------------------------------------------------------------------


@dataclass
class Change:
    change: Literal["modified", "removed", "added"]
    requirement_id: str | None
    new_text: str | None
    reason: str
    page: int | None
    paragraph: str | None

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {"requirement_id": self.requirement_id, "change": self.change}
        if self.new_text is not None:
            out["new_text"] = self.new_text
        out["reason"] = self.reason
        if self.page is not None:
            out["source"] = {"page": self.page, "paragraph": self.paragraph or ""}
            if not self.paragraph:
                del out["source"]["paragraph"]
        return out


def _norm_label(label: str | None) -> str:
    return (label or "").strip().rstrip(".").replace(",", "").lower()


def evidence(requirement: dict[str, Any], old: Version) -> list[Segment]:
    """The old segments a requirement was written from: those of its cited paragraph whose
    content words are mostly in the requirement."""
    source = requirement.get("source") or {}
    label = _norm_label(source.get("paragraph"))
    rwords = _words(normalize(requirement.get("text", "")))
    body = [s for s in old.segments if not s.heading]
    pool = [s for s in body if _norm_label(s.label) == label] if label else []
    if not pool and label:
        pool = [s for s in body if _norm_label(s.label).startswith(label + ".")]
    if not pool and source.get("page"):
        pool = [s for s in body if s.page == source["page"]]

    def containment(s: Segment) -> float:
        w = _words(s.norm)
        return len(w & rwords) / len(w) if w else 0.0

    found = [s for s in pool if containment(s) >= _EVIDENCE_MIN]
    if not found and pool:
        best = max(pool, key=containment)
        if containment(best) >= 0.3:
            found = [best]
    return found


def _word_diff(old_text: str, new_text: str, limit: int = 1200) -> str:
    a, b = old_text.split(), new_text.split()
    parts: list[str] = []
    for op, i1, i2, j1, j2 in SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        before, after = " ".join(a[i1:i2]), " ".join(b[j1:j2])
        if op == "equal" or normalize(before) == normalize(after):
            continue
        if op == "replace":
            parts.append(f"'{before}' became '{after}'")
        elif op == "insert":
            parts.append(f"'{after}' was added")
        else:
            parts.append(f"'{before}' was removed")
    text = "; ".join(parts)
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _cap(text: str) -> str:
    return text if len(text) <= _TEXT_MAX else text[: _TEXT_MAX - 1] + "…"


def _short(text: str, n: int = 100) -> str:
    return text if len(text) <= n else text[:n] + "…"


def _scope(ev: list[Segment], old: Version) -> list[Segment]:
    """The evidence that decides whether the requirement changed.

    A list's lead-in is context for a requirement written from one of its items: in the worked
    example a test procedure's lead-in was narrowed to one kind of test and none of the
    requirements written from its steps changed for it. A requirement written
    from several items is the whole list, lead-in included. A lead-in none of whose items is in
    the evidence only shares words with the requirement and is dropped."""
    taken = {s.index for s in ev}

    def introduces_evidence(lead: Segment) -> bool:
        j = lead.index + 1
        while (
            j < len(old.segments) and old.segments[j].item and old.segments[j].label == lead.label
        ):
            if j in taken:
                return True
            j += 1
        return False

    kept = [s for s in ev if not s.lead or s.item or introduces_evidence(s)]
    items = [s for s in kept if s.item]
    if len(items) == 1:
        kept = [s for s in kept if not s.lead or s.item]
    return kept or ev


def _new_span(judged: list[Segment], new: Version) -> tuple[list[Segment], set[int]]:
    """The new text of a requirement, and the new segments it accounts for.

    For one sentence or item: its counterpart. For several: from the first counterpart to the
    last, plus what was inserted in those paragraphs (a sixth condition added to a list of five
    belongs to the rule the list qualifies, not to a new requirement). Segments of other
    paragraphs in between are left out: if one item moved to another chapter, what lies between
    is not part of this requirement."""
    partners = sorted(
        (new.segments[s.partner] for s in judged if s.partner is not None), key=lambda n: n.index
    )
    if not partners:
        return [], set()
    if len(judged) == 1:
        return partners, {partners[0].index}
    labels = {n.label for n in partners}
    within = [n for n in new.segments if n.label in labels and not n.heading]
    first, last = partners[0].index, partners[-1].index
    shown = [n for n in within if first <= n.index <= last]
    owned = {n.index for n in within if n.partner is None} | {n.index for n in partners}
    return shown, owned


def requirement_changes(
    requirements_old: Sequence[dict[str, Any]], old: Version, new: Version
) -> tuple[list[Change], set[int]]:
    """Changes for the old requirements, and the new segments they account for (so the same
    sentence is not also reported as `added`)."""
    changes: list[Change] = []
    consumed: set[int] = set()
    reg, ver = new.regulation, new.version_label
    for req in requirements_old:
        judged = _scope(evidence(req, old), old)
        if not judged:
            continue
        shown, owned = _new_span(judged, new)
        inserted = [n for n in shown if n.partner is None]
        if all(s.status == "unchanged" for s in judged) and not inserted:
            continue
        old_label = judged[0].label
        if all(s.status == "removed" for s in judged):
            excerpt = _short(" ".join(s.text for s in judged), 80)
            changes.append(
                Change(
                    "removed",
                    req["id"],
                    None,
                    f"Paragraph {old_label} of {reg} was amended in version {ver}; the provision "
                    f"'{excerpt}' no longer appears.",
                    None,
                    None,
                )
            )
            continue
        consumed |= owned
        new_label = shown[0].label
        old_text = " ".join(s.text for s in judged)
        new_text = " ".join(n.text for n in shown)
        where = new_label if new_label == old_label else f"{new_label} (formerly {old_label})"
        diff = _word_diff(old_text, new_text) or "the wording changed"
        changes.append(
            Change(
                "modified",
                req["id"],
                _cap(new_text),
                f"Paragraph {where} of {reg} was amended in version {ver}: {diff}.",
                shown[0].page,
                new_label,
            )
        )
    return changes, consumed


def added_changes(new: Version, consumed: set[int]) -> list[Change]:
    """New obligations nothing in the old version pairs with."""
    reg, ver = new.regulation, new.version_label
    excluded = {top for top, title in new.section_titles.items() if _NOT_REQUIREMENTS.match(title)}
    segs = new.segments
    out: list[Change] = []

    def eligible(s: Segment) -> bool:
        return (
            s.status == "added"
            and s.index not in consumed
            and not s.heading
            and bool(s.label)
            and s.label.split(".")[0] not in excluded
        )

    handled: set[int] = set()
    for lead in segs:
        if not lead.lead or lead.index in handled:
            continue
        items = []
        j = lead.index + 1
        while j < len(segs) and segs[j].item and segs[j].label == lead.label:
            items.append(segs[j])
            j += 1
        if not items:
            continue
        handled.add(lead.index)
        fresh = [it for it in items if eligible(it)]
        handled.update(it.index for it in fresh)
        normative = _NORMATIVE.search(lead.text) or any(_NORMATIVE.search(it.text) for it in fresh)
        if not fresh or not normative:
            # A new lead-in to items that already existed is not an obligation of its own.
            continue
        if all(not _LIST_ITEM.sub("", it.text)[:1].islower() for it in fresh):
            # Steps of a procedure ("(a) Position the vehicle ..."): one obligation each, with
            # the lead-in that makes it one, even when the lead-in itself is not new.
            for it in fresh:
                out.append(_added(f"{lead.text} {it.text}", it, reg, ver))
        else:
            # Conditions of one rule: "...is not required when: (a) there is ...; or (b) ..."
            anchor = lead if eligible(lead) else fresh[0]
            out.append(_added(" ".join([lead.text, *(it.text for it in fresh)]), anchor, reg, ver))

    for s in segs:
        if s.index in handled or not eligible(s) or not _NORMATIVE.search(s.text):
            continue
        out.append(_added(s.text, s, reg, ver))
    out.sort(key=lambda c: c.page or 0)
    return out


def _added(text: str, s: Segment, reg: str, ver: str) -> Change:
    return Change(
        "added",
        None,
        _cap(text),
        f"Paragraph {s.label} of {reg} is new in version {ver}: '{_short(s.text)}'.",
        s.page,
        s.label,
    )


def diff_versions(
    requirements_old: Sequence[dict[str, Any]], old: Version, new: Version
) -> list[Change]:
    align(old, new)
    changes, consumed = requirement_changes(requirements_old, old, new)
    return changes + added_changes(new, consumed)


def submission(team_id: str, case_id: str, changes: Sequence[Change]) -> dict[str, Any]:
    return {"team_id": team_id, "case_id": case_id, "changes": [c.to_json() for c in changes]}


# ------------------------------------------------------------------------------------------
# From a PDF
# ------------------------------------------------------------------------------------------


def version_from_pdf(pdf: bytes, regulation: str) -> Version:
    """A version from the store's paragraph extraction (#3). Unnumbered text before the first
    heading (an introduction) has no label and is left out: nothing cites it."""
    extraction = paragraphs.extract(pdf)
    return build_version(
        regulation,
        extraction.version_label or "?",
        [p for p in extraction.paragraphs if p.label],
    )


def cited_regulation(requirements_old: Sequence[dict[str, Any]]) -> str | None:
    """The regulation the requirements cite most: the one the reasons name."""
    cited = Counter(
        (r.get("source") or {}).get("regulation")
        for r in requirements_old
        if isinstance(r.get("source"), dict)
    )
    cited.pop(None, None)
    return cited.most_common(1)[0][0] if cited else None


# ------------------------------------------------------------------------------------------
# Local score against an expected file
# ------------------------------------------------------------------------------------------


def _ratio(numerator: int, denominator: int) -> float:
    # As score_local.py: nothing to divide by scores 0, not 1.
    return 0.0 if denominator == 0 else numerator / denominator


def _level(submitted: int, expected: int, matched: int) -> dict[str, Any]:
    return {
        "submitted": submitted,
        "expected": expected,
        "matched": matched,
        "precision": _ratio(matched, submitted),
        "recall": _ratio(matched, expected),
    }


def score(predicted: dict[str, Any], expected: dict[str, Any]) -> dict[str, Any]:
    """A sub-goal file against Certivity's expected.json for the same case.

    Certivity's measure is "recall of the requirements flagged for change, and the accuracy of the
    change stated for each one", computed on the platform with a model. Certivity ships no scorer
    for it, so this is an approximation by rules: flagged ids (recall, precision), change type of
    the ids flagged in both (accuracy), and `added` entries matched one to one with an expected one
    in the same paragraph whose text is similar (ratio 0.4 or more, so a reworded sentence still
    counts and an unrelated one in the same paragraph does not). It does not judge whether a
    `new_text` or `reason` says the right thing; the platform does."""
    p_ids = {c["requirement_id"]: c["change"] for c in predicted["changes"] if c["requirement_id"]}
    e_ids = {c["requirement_id"]: c["change"] for c in expected["changes"] if c["requirement_id"]}
    hit = set(p_ids) & set(e_ids)
    right = {i for i in hit if p_ids[i] == e_ids[i]}
    p_add = [c for c in predicted["changes"] if c["change"] == "added"]
    e_add = [c for c in expected["changes"] if c["change"] == "added"]
    used: set[int] = set()
    matched = 0
    for e in e_add:
        e_para = _norm_label((e.get("source") or {}).get("paragraph"))
        best, best_i = 0.0, -1
        for i, p in enumerate(p_add):
            if i in used or _norm_label((p.get("source") or {}).get("paragraph")) != e_para:
                continue
            r = SequenceMatcher(
                None,
                normalize(e.get("new_text") or "").split(),
                normalize(p.get("new_text") or "").split(),
            ).ratio()
            if r > best:
                best, best_i = r, i
        if best_i >= 0 and best >= 0.4:
            used.add(best_i)
            matched += 1
    return {
        "flagged": _level(len(p_ids), len(e_ids), len(hit)),
        "change_type": {
            "right": len(right),
            "of": len(hit),
            "accuracy": _ratio(len(right), len(hit)),
        },
        "added": _level(len(p_add), len(e_add), matched),
        "missed": sorted(set(e_ids) - set(p_ids)),
        "extra": sorted(set(p_ids) - set(e_ids)),
        "wrong_type": sorted(hit - right),
        "added_unmatched": [
            (p.get("source") or {}).get("paragraph") for i, p in enumerate(p_add) if i not in used
        ],
    }


def _main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m agent_service.domain.regdiff",
        description="Sub-goal changes from an old and a new regulation PDF.",
    )
    parser.add_argument("old_pdf", type=Path)
    parser.add_argument("new_pdf", type=Path)
    parser.add_argument("requirements_old", type=Path)
    parser.add_argument(
        "--regulation", help="name in the reasons (default: what the requirements cite most)"
    )
    parser.add_argument("--team-id", default="team-00")
    parser.add_argument("--case-id", default="subgoal-dev")
    parser.add_argument("--out", type=Path, help="write the submission here (default: stdout)")
    parser.add_argument("--expected", type=Path, help="print a local score against this file")
    args = parser.parse_args(argv)

    reqs = json.loads(args.requirements_old.read_text(encoding="utf-8"))
    regulation = args.regulation or cited_regulation(reqs) or "the regulation"
    old = version_from_pdf(args.old_pdf.read_bytes(), regulation)
    new = version_from_pdf(args.new_pdf.read_bytes(), regulation)
    result = submission(args.team_id, args.case_id, diff_versions(reqs, old, new))
    text = json.dumps(result, indent=2, ensure_ascii=False)
    if args.out:
        args.out.write_text(text + "\n", encoding="utf-8")
    else:
        print(text)
    # The same check production runs on every file (POST /checks, the agent's certivity_check),
    # with the requirement ids checked against this requirements_old.json.
    ref = certivity.Reference("local", None, {}, {args.case_id: reqs})
    check = certivity.check(text, ref, with_score=False)
    for problem in check["problems"]:
        print(f"{problem['path']}: {problem['message']}", file=sys.stderr)
    print(
        f"validate.py: {'valid' if check['valid'] else 'INVALID'}, {check['items']} changes",
        file=sys.stderr,
    )
    if args.expected:
        expected = json.loads(args.expected.read_text(encoding="utf-8"))
        print(json.dumps(score(result, expected), indent=2), file=sys.stderr)
    return 0 if check["valid"] else 1


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv[1:]))
