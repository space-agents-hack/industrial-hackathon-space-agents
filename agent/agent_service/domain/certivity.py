"""Certivity's own checks on a submission: `validate.py` (is the file accepted on upload?) and
`score_local.py` (regulation- and page-level score, only where an expected file exists).

Both tools are loaded from `agent/certivity/`, an unchanged copy of Certivity's code
(certivity/README.md). What they compare against (the regulation index, the answer files) is
Certivity's confidential data, so it lives in the database (table certivity_reference) and is
passed in as a `Reference`. They are imported, not reimplemented and not run as subprocesses: the
platform runs this same `validate.py`, and a function call takes milliseconds.

A sub-goal file is scored by `regdiff.score` against the sub-goal's expected.json: Certivity ships
that answer but no scorer for it.

What this does NOT do: score the requirement level by meaning, or judge whether a sub-goal change
states the right thing. That needs Certivity's model and only happens on their platform; the
requirement level here is a count estimate (`requirement_estimate`), not a judgement. And there
is no score for a case without `expected.json`, which includes the held-out cases that decide the
ranking.
"""

import importlib.util
import json
import re
import subprocess
import sys
from collections import Counter
from dataclasses import dataclass, field
from functools import cache
from pathlib import Path
from types import ModuleType
from typing import Any, Protocol
from uuid import UUID

# Certivity's code (MIT), copied unchanged. Their data lives in the database, not here.
PACKAGE_DIR = Path(__file__).resolve().parents[2] / "certivity"

# More problems than this are not read by anyone; the count still says how many there are.
_MAX_PROBLEMS = 200

# Share of the paragraph slots the platform's judge credited, on the one upload where we know both:
# 2026-10-24 21:11 UTC, 409 requirements, 109 slots shared with the answer key, 91 matched (#48).
# One point is all it rests on: re-measure it from every platform upload with a requirement level
# (score log, docs/se/verification.md). Changing it moves the estimate, never the output.
REQUIREMENT_JUDGE_RATE = 91 / 109

_FENCED = re.compile(r"```(?:json)?\s*\n(.*?)\n\s*```", re.DOTALL)


@cache
def _tool(name: str) -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        f"certivity_{name}", PACKAGE_DIR / "tools" / f"{name}.py"
    )
    if spec is None or spec.loader is None:
        raise FileNotFoundError(f"{name}.py not found in {PACKAGE_DIR / 'tools'}")
    module = importlib.util.module_from_spec(spec)
    # Registered before it runs: dataclasses look their module up in sys.modules.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@dataclass(frozen=True)
class Reference:
    """What the checks compare against. The regulation index comes from the organisation's
    regulation library (tables regulations, regulation_versions: one list, imported once in the
    app, ADR-0006); the answer keys from table certivity_reference. Either can be empty."""

    commit: str
    index: list[dict[str, Any]] | None
    expected: dict[str, dict[str, Any]]  # main-goal case_id -> expected.json
    requirements_old: dict[str, list[dict[str, Any]]]  # sub-goal case_id -> requirements_old.json
    # sub-goal case_id -> its expected.json. Kept apart from `expected`, which the agent's tools
    # and the main score read: one name for two file formats is how a sub-goal answer would end
    # up scored as a requirements list.
    subgoal_expected: dict[str, dict[str, Any]] = field(default_factory=dict)

    @classmethod
    def from_rows(
        cls, rows: list[dict[str, Any]], index: list[dict[str, Any]] | None = None
    ) -> "Reference":
        # An "index" row from before ADR-0006 is ignored: the library is the only list.
        # Both answer formats are stored as kind "expected"; what is in them tells them apart.
        answers = [r for r in rows if r["kind"] == "expected"]
        expected = {r["case_id"]: r["content"] for r in answers if not _is_subgoal(r["content"])}
        subgoal = {r["case_id"]: r["content"] for r in answers if _is_subgoal(r["content"])}
        old = {r["case_id"]: r["content"] for r in rows if r["kind"] == "requirements_old"}
        commits = sorted({r["certivity_commit"] for r in rows})
        return cls(", ".join(commits) or "not loaded", index, expected, old, subgoal)

    @property
    def answer_keys_loaded(self) -> bool:
        return bool(self.expected) or bool(self.requirements_old)


EMPTY = Reference("not loaded", None, {}, {})


def _is_subgoal(content: Any) -> bool:
    return isinstance(content, dict) and isinstance(content.get("changes"), list)


class _Store(Protocol):
    async def certivity_reference(self) -> list[dict[str, Any]]: ...

    async def regulation_index(self, organization_id: UUID) -> list[dict[str, Any]]: ...


async def load_reference(store: _Store, organization_id: UUID | None) -> Reference:
    """The answer keys, and the regulation index of this organisation's library. Without an
    organisation, or with an empty library, there is no index and validate.py skips that check."""
    index = await store.regulation_index(organization_id) if organization_id else []
    return Reference.from_rows(await store.certivity_reference(), index or None)


def read_package(root: Path) -> list[dict[str, Any]]:
    """The answer keys to store, read from a clone of Certivity's package (load_certivity). Not
    regulations/index.json: that is imported into the regulation library in the app (ADR-0006)."""
    validate = _tool("validate")
    commit = _git_commit(root)
    rows: list[dict[str, Any]] = []

    for path in sorted(root.glob("cases/*/expected.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        rows.append(_row("expected", data.get("case_id") or path.parent.name, data, commit))

    # A sub-goal case is named after its folder: subgoal/dev is "subgoal-dev" (README, section 3).
    # Its expected.json, when there is one, says so too; requirements_old.json does not. The
    # held-out sub-goal comes without one.
    for path in sorted(root.glob("subgoal/*/requirements_old.json")):
        case_id = f"subgoal-{path.parent.name}"
        sibling = path.parent / "expected.json"
        if sibling.is_file():
            answer = json.loads(sibling.read_text(encoding="utf-8"))
            case_id = answer.get("case_id") or case_id
            rows.append(_row("expected", case_id, answer, commit))
        rows.append(_row("requirements_old", case_id, validate.load_requirements_old(path), commit))
    return rows


def _row(kind: str, case_id: str, content: Any, commit: str) -> dict[str, Any]:
    return {"kind": kind, "case_id": case_id, "content": content, "certivity_commit": commit}


def _git_commit(root: Path) -> str:
    try:
        out = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
            check=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return "unknown"
    return out.stdout.strip() or "unknown"


def extract_json(text: str) -> tuple[Any, tuple[int, int] | None, str | None]:
    """The JSON document in `text`, where it is, and why not if there is none.

    A model's answer is often the JSON inside a sentence or a ```json fence. The span lets the web
    offer exactly that part for download, because the uploaded file must contain only the JSON.
    """
    stripped = text.strip()
    start = text.find(stripped) if stripped else 0
    candidates: list[tuple[int, int]] = [(start, start + len(stripped))]
    candidates += [m.span(1) for m in _FENCED.finditer(text)]
    first, last = text.find("{"), text.rfind("}")
    if first != -1 and last > first:
        candidates.append((first, last + 1))

    error: str | None = None
    for begin, end in candidates:
        try:
            return json.loads(text[begin:end]), (begin, end), None
        except json.JSONDecodeError as exc:
            error = error or f"Not valid JSON: {exc.msg} at line {exc.lineno}, column {exc.colno}."
        except RecursionError:
            error = error or "Not valid JSON: nested too deeply."
    return None, None, error or "Empty."


def check(
    text: str,
    ref: Reference,
    *,
    with_score: bool = True,
    expected: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Validate a submission the way the platform does, and score it where Certivity allows.

    `with_score=False` is for the agent's own tool: a model that sees the score on the worked
    example can tune its answer to that one case, and the dev score would stop telling us anything
    about the held-out case.
    """
    validate = _tool("validate")
    result: dict[str, Any] = {
        "kind": None,
        "case_id": None,
        "valid": False,
        "items": None,
        "problems": [],
        "problem_count": 0,
        "json_span": None,
        "score": None,
        "breakdown": None,
        "requirement_estimate": None,
        "subgoal_score": None,
        "notes": [],
        "certivity_commit": ref.commit,
    }
    notes: list[str] = result["notes"]

    size = len(text.encode("utf-8"))
    if size > validate.MAX_BYTES:
        limit = validate.MAX_BYTES // (1024 * 1024)
        message = f"The file is {size / 1024 / 1024:.1f} MB; the limit is {limit} MB."
        result.update(problems=[{"path": "$", "message": message}], problem_count=1)
        return result

    data, span, error = extract_json(text)
    if span is None:
        result.update(problems=[{"path": "$", "message": error}], problem_count=1)
        return result
    result["json_span"] = list(span)
    if text[span[0] : span[1]].strip() != text.strip():
        notes.append(
            "The JSON was found inside surrounding text. Upload only the JSON part "
            "(the download button gives exactly that)."
        )

    kind = validate.kind_of(data)
    case_id = data.get("case_id") if isinstance(data, dict) else None
    case_id = case_id if isinstance(case_id, str) else None
    old = ref.requirements_old.get(case_id) if case_id else None
    problems = validate.validate(data, index=ref.index, requirements_old=old)

    items = data.get("requirements" if kind == validate.MAIN else "changes") if kind else None
    result.update(
        kind=kind,
        case_id=case_id,
        valid=not problems,
        items=len(items) if isinstance(items, list) else None,
        problems=[{"path": p.path, "message": p.message} for p in problems[:_MAX_PROBLEMS]],
        problem_count=len(problems),
    )

    # A sub-goal file cites no regulation, so the library plays no part in its check.
    if ref.index is None and kind != validate.SUBGOAL:
        notes.append(
            "This organisation's regulation library is empty, so cited regulations and versions "
            "were not checked. Import index.json on the Regulations page."
        )
    if not ref.answer_keys_loaded:
        notes.append(
            "Certivity's answer keys are not in the database, so requirement ids were not checked "
            "and nothing was scored. Load them with `make certivity-load` (a release also does)."
        )
    if kind == validate.SUBGOAL and old is None:
        notes.append(
            f"No requirements_old.json for case {case_id!r}: requirement ids were not checked."
        )

    if not with_score or kind is None:
        return result
    if kind == validate.SUBGOAL:
        return _subgoal_score(result, data, ref, case_id, expected)
    if expected is not None and _is_subgoal(expected):
        notes.append(
            "The expected file you chose is a sub-goal answer (a changes list), so this "
            "main-goal file was scored against the one in the database instead."
        )
        expected = None
    supplied = expected is not None
    if expected is None:
        expected = ref.expected.get(case_id) if case_id else None
    if expected is None:
        # case_id is the case's name in the app (Deps.case_name). A case named anything but
        # Certivity's id ("dev-rear-lamp", or the held-out case's folder name) gets no score here
        # and is scored against nothing on the platform, so say which names would match.
        known = ", ".join(repr(k) for k in sorted(ref.expected)) or "none loaded"
        notes.append(
            f"No expected file for case {case_id!r}, so no local score. That is expected for "
            "the held-out case, named after its folder under cases/. Otherwise case_id is wrong: "
            "it is taken from the case's name in the app, and must be Certivity's id for the case "
            f"(rename the case and run again). Cases with an expected file: {known}."
        )
        return result
    try:
        result["score"] = _tool("score_local").score(data, expected)
        result["breakdown"] = breakdown(data, expected)
        result["requirement_estimate"] = requirement_estimate(data, expected)
    except Exception as exc:
        # The scorer assumes a well-formed file; on a broken one the validation problems say why.
        notes.append(
            f"Could not score this file ({type(exc).__name__}); fix the problems above first."
        )
        return result
    if supplied:
        notes.append(
            "Scored against the expected.json you chose "
            f"(its case_id: {expected.get('case_id')!r}), not the one in the database."
        )
    notes.append(
        "Regulation and page level as Certivity's score_local.py computes them. The platform "
        "uses full page ranges, so its numbers can differ slightly."
    )
    notes.append(
        "Requirement level: an estimate, not the platform's judgement. Per cited paragraph it "
        "counts min(yours, expected) and credits the share the platform's judge accepted on a "
        f"past upload ({REQUIREMENT_JUDGE_RATE:.2f}). It sees how many obligations you wrote on "
        "each paragraph, not what they say."
    )
    return result


def _subgoal_score(
    result: dict[str, Any],
    data: dict[str, Any],
    ref: Reference,
    case_id: str | None,
    chosen: dict[str, Any] | None,
) -> dict[str, Any]:
    # Imported here: regdiff's command line runs these checks on what it writes.
    from agent_service.domain import regdiff

    notes: list[str] = result["notes"]
    # A chosen file is used only if it is a sub-goal answer: a main-goal expected.json chosen for
    # a changes file would score every flag as extra.
    if chosen is not None and not _is_subgoal(chosen):
        notes.append(
            "The expected file you chose is a main-goal answer (a requirements list), so this "
            "sub-goal file was not scored against it."
        )
        chosen = None
    expected = chosen if chosen is not None else ref.subgoal_expected.get(case_id or "")
    if expected is None:
        known = ", ".join(repr(k) for k in sorted(ref.subgoal_expected)) or "none loaded"
        notes.append(
            f"No sub-goal expected file for case {case_id!r}, so no local score. That is expected "
            "for the held-out sub-goal (subgoal-heldout); the platform scores it. Sub-goal cases "
            f"with an expected file: {known}."
        )
        return result
    try:
        result["subgoal_score"] = regdiff.score(data, expected)
    except Exception as exc:
        notes.append(
            f"Could not score this file ({type(exc).__name__}); fix the problems above first."
        )
        return result
    if chosen is not None:
        notes.append(
            "Scored against the expected.json you chose "
            f"(its case_id: {expected.get('case_id')!r}), not the one in the database."
        )
    notes.append(
        "An upper bound, not an estimate: flagged requirement ids, their change type, and added "
        "entries counted as matched when they share a paragraph and 40% of their words with an "
        "expected one. The platform has a model judge each change by meaning, and accepts fewer: "
        "on the dev upload of 2026-10-25 (about 05:20 CEST) this counted 23 matched and the "
        "platform 20."
    )
    return result


def breakdown(submission: dict[str, Any], expected: dict[str, Any]) -> list[dict[str, Any]]:
    """The score split by regulation, so a person sees which regulation was missed or extra and
    where the pages went: a missed regulation costs every requirement in it, and the totals alone
    do not say which one. Uses score_local's own matching (a page counts if the page or a
    paragraph on it is right), so the rows add up to its totals. Shown to people only: the agent's
    tool gets no score (with_score=False), and this comes with the score."""
    scorer = _tool("score_local")
    cited, wanted = scorer._cited(submission), scorer._cited(expected)
    sub_on_page, sub_anywhere = scorer._paragraphs(submission)
    gold_on_page, gold_anywhere = scorer._paragraphs(expected)
    sub_pages, gold_pages = set(cited), set(wanted)
    correct = {
        p
        for p in sub_pages
        if p in gold_pages or sub_on_page.get(p, set()) & gold_anywhere.get(p[:2], set())
    }
    found = {
        p
        for p in gold_pages
        if p in sub_pages or gold_on_page.get(p, set()) & sub_anywhere.get(p[:2], set())
    }
    rows: list[dict[str, Any]] = []
    for reg in sorted({r for r, _, _ in cited} | {r for r, _, _ in wanted}):
        rows.append(
            {
                "regulation": reg,
                "requirements": sum(r == reg for r, _, _ in cited),
                "expected_requirements": sum(r == reg for r, _, _ in wanted),
                "pages": sum(p[0] == reg for p in sub_pages),
                "pages_correct": sum(p[0] == reg for p in correct),
                "expected_pages": sum(p[0] == reg for p in gold_pages),
                "expected_pages_found": sum(p[0] == reg for p in found),
            }
        )
    return rows


def requirement_estimate(submission: dict[str, Any], expected: dict[str, Any]) -> dict[str, Any]:
    """The requirement level, estimated by counting, in the shape of score_local's levels.

    The platform matches requirements one to one, by meaning, with a model. Two requirements on one
    expected obligation are credited once, and one requirement stating two obligations matches one
    of them. Counting per (regulation, version, paragraph) bounds that from above:
    min(submitted, expected) on each paragraph is the most the judge can credit there if it pairs
    requirements on the same paragraph. The share it did credit is REQUIREMENT_JUDGE_RATE.

    Why counts and not a model: it costs nothing, cannot drift with a prompt, and sees exactly what
    lost most of the 23:11 upload (one requirement where the key has several, #48). What it cannot
    see: wording, or a match across neighbouring paragraphs. Shown to people only, like the score:
    the agent's tool never gets it (SYS-42).
    """
    key = _tool("score_local")._paragraph_key

    def slots(doc: dict[str, Any]) -> Counter[tuple[str, str, str]]:
        out: Counter[tuple[str, str, str]] = Counter()
        for r in doc.get("requirements", []):
            s = r["source"]
            label = key(s.get("paragraph"))
            if label:  # no paragraph, no slot: the judge's pairing is by paragraph or page
                out[(s["regulation"], s.get("version", ""), label)] += 1
        return out

    ours, gold = slots(submission), slots(expected)
    ceiling = sum(min(n, ours[p]) for p, n in gold.items())
    n_submitted = len(submission.get("requirements", []))
    n_expected = len(expected.get("requirements", []))
    matched = REQUIREMENT_JUDGE_RATE * ceiling
    precision = matched / n_submitted if n_submitted else 0.0
    recall = matched / n_expected if n_expected else 0.0
    return {
        "precision": precision,
        "recall": recall,
        "f1": 2 * precision * recall / (precision + recall) if matched else 0.0,
        "n_submitted": n_submitted,
        "n_expected": n_expected,
        "n_matched": round(matched),
        "ceiling": ceiling,
        "judge_rate": REQUIREMENT_JUDGE_RATE,
    }
