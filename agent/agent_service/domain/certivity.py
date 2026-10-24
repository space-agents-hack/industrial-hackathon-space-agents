"""Certivity's own checks on a submission: `validate.py` (is the file accepted on upload?) and
`score_local.py` (regulation- and page-level score, only where an expected file exists).

Both tools are loaded from `agent/certivity/`, an unchanged copy of Certivity's package
(certivity/README.md). They are imported, not reimplemented and not run as subprocesses: the
platform runs this same `validate.py`, and a function call takes milliseconds.

What this does NOT do: score the requirement level (meaning). That needs Certivity's model and only
happens on their platform. And there is no score for a case without `expected.json`, which
includes the held-out case that decides the ranking.
"""

import importlib.util
import json
import re
import sys
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from types import ModuleType
from typing import Any

PACKAGE_DIR = Path(__file__).resolve().parents[2] / "certivity"

# More problems than this are not read by anyone; the count still says how many there are.
_MAX_PROBLEMS = 200

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
    """What the checks compare against, read once per process."""

    commit: str
    index: list[dict[str, Any]] | None
    expected: dict[str, dict[str, Any]]  # main-goal case_id -> expected.json
    requirements_old: dict[str, list[dict[str, Any]]]  # sub-goal case_id -> requirements_old.json


@cache
def reference() -> Reference:
    validate = _tool("validate")
    index_path = PACKAGE_DIR / "regulations" / "index.json"
    index = validate.load_index(index_path) if index_path.is_file() else None

    expected: dict[str, dict[str, Any]] = {}
    for path in sorted(PACKAGE_DIR.glob("cases/*/expected.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        expected[data.get("case_id") or path.parent.name] = data

    # A sub-goal case is named after its folder: subgoal/dev is "subgoal-dev" (README, section 3).
    # Its expected.json, when there is one, says so too; requirements_old.json does not.
    old: dict[str, list[dict[str, Any]]] = {}
    for path in sorted(PACKAGE_DIR.glob("subgoal/*/requirements_old.json")):
        case_id = f"subgoal-{path.parent.name}"
        sibling = path.parent / "expected.json"
        if sibling.is_file():
            case_id = json.loads(sibling.read_text(encoding="utf-8")).get("case_id") or case_id
        old[case_id] = validate.load_requirements_old(path)

    source = PACKAGE_DIR / "SOURCE"
    match = re.search(r"at commit (\S+)\.", source.read_text()) if source.is_file() else None
    return Reference(match.group(1) if match else "unknown", index, expected, old)


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


def check(text: str, *, with_score: bool = True) -> dict[str, Any]:
    """Validate a submission the way the platform does, and score it where Certivity allows.

    `with_score=False` is for the agent's own tool: a model that sees the score on the worked
    example can tune its answer to that one case, and the dev score would stop telling us anything
    about the held-out case.
    """
    validate, ref = _tool("validate"), reference()
    result: dict[str, Any] = {
        "kind": None,
        "case_id": None,
        "valid": False,
        "items": None,
        "problems": [],
        "problem_count": 0,
        "json_span": None,
        "score": None,
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

    if ref.index is None:
        notes.append(
            "regulations/index.json is missing: cited regulations and versions were not checked."
        )
    if kind == validate.SUBGOAL and old is None:
        notes.append(
            f"No requirements_old.json for case {case_id!r}: requirement ids were not checked."
        )

    if not with_score or kind != validate.MAIN:
        if with_score and kind == validate.SUBGOAL:
            notes.append(
                "Certivity ships no local score for the sub-goal; it is scored on the platform."
            )
        return result
    expected = ref.expected.get(case_id) if case_id else None
    if expected is None:
        notes.append(
            f"No expected file for case {case_id!r}, so no local score. "
            "Certivity scores it on the platform only."
        )
        return result
    try:
        result["score"] = _tool("score_local").score(data, expected)
    except Exception as exc:
        # The scorer assumes a well-formed file; on a broken one the validation problems say why.
        notes.append(
            f"Could not score this file ({type(exc).__name__}); fix the problems above first."
        )
        return result
    notes.append(
        "Regulation and page level only, as Certivity's score_local.py computes them. The platform "
        "uses full page ranges, so its numbers can differ slightly; the requirement level is "
        "platform-only."
    )
    return result
