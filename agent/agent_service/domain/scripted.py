"""A model that is not a model: a fixed policy for each of the three agents, with no provider and
no network. `AGENT_MODEL=scripted` selects it.

Why it exists: the whole loop (the orchestrator's tools, the parallel writers, the check, the
approval pause and the resume) runs in tests, on a fresh clone with no API key, and on stage if
the network goes down. It reads the same prompts and tool results a real model would and decides
from them. What it writes is mechanical ("The product shall meet 5.4.2: ..."): it proves the
plumbing, never the quality of requirements. That is what `make eval` with a real model is for.

Which agent is asking is told by the output tool it was given: `submit` (orchestrator),
`record_requirements` (writer), `report_findings` (check), `report_verdicts` (the sub-goal's
reviewer, domain/subgoal_review.py), `record_texts` (the sub-goal's writer step,
domain/subgoal_write.py). The assistant
(domain/assistant.py) has no output tool and answers in text; it is told by its `read_paragraph`.
"""

import json
import re
from collections.abc import AsyncIterator
from typing import Any

from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.models.function import AgentInfo, DeltaToolCall, DeltaToolCalls, FunctionModel

Call = tuple[str, dict[str, Any]]

# A window line as writer.Window.render() writes it: "[#12] 5.4.2 (page 12)".
_PARAGRAPH = re.compile(r"^\[#(\d+)\] (.+) \(page (\d+)\)$")
# A clause the writer must answer for, as Window.render() lists it: "  {c12.3} The ...".
_CLAUSE = re.compile(r"^  \{(c\d+\.\d+)\} ")
# The check's scripted judgement: a requirement copied from a paragraph that calls itself
# obsolete is rejected. Only so tests can follow the reject path; a real check reads the text.
_OBSOLETE = re.compile(r"\bobsolete\b", re.IGNORECASE)


# Words of any task that say nothing about the product.
_NOT_THE_PRODUCT = {"write", "requirements", "requirement", "these", "their", "which", "there"}


def _prompt_text(messages: list[ModelMessage]) -> str:
    for message in messages:
        if isinstance(message, ModelRequest):
            for part in message.parts:
                if isinstance(part, UserPromptPart):
                    content = part.content
                    if isinstance(content, str):
                        return content
                    return "\n".join(c for c in content if isinstance(c, str))
    return ""


def _returns(messages: list[ModelMessage]) -> tuple[dict[str, list[Any]], dict[str, bool]]:
    # Typed as Any: the library types a tool result as "anything a tool may return", and here we
    # know they are the dicts and lists from tools.py.
    returns: dict[str, list[Any]] = {}
    denied: dict[str, bool] = {}
    for message in messages:
        if not isinstance(message, ModelRequest):
            continue
        for part in message.parts:
            if isinstance(part, ToolReturnPart):
                returns.setdefault(part.tool_name, []).append(part.content)
                denied[part.tool_name] = part.outcome == "denied"
    return returns, denied


def _orchestrate(messages: list[ModelMessage]) -> tuple[str, list[Call]]:
    returns, denied = _returns(messages)
    if "list_regulations" not in returns:
        return "Reading the library.", [("list_regulations", {})]
    library = returns["list_regulations"][0]
    codes = sorted({v["regulation"] for v in library if v["role"] in ("base", None)})
    if not codes:
        summary = "The library has no regulations, so no requirements were written."
        return summary, [("submit", {"summary": summary})]
    if "record_product_profile" not in returns:
        # The engineer's note as the whole profile: a real model reads the files and drawings.
        lines = _prompt_text(messages).strip().splitlines()
        profile = {
            "part": (lines[0] if lines else "the part")[:500],
            "does": [],
            "does_not": [],
            "contains": [],
            "mounted": [],
            "vehicles": [],
            "markets": [],
            "named_in_case": [],
        }
        return "Recording what the part is.", [("record_product_profile", profile)]
    if "screen_regulations" not in returns:
        return "Screening every regulation's scope.", [("screen_regulations", {})]
    if "search_regulations" not in returns:
        # Any long word of the engineer's note: "rear position lamp" finds the lamp regulations
        # and not the one about glazing. A real model reads the case; this only keeps the
        # selection step honest enough to test.
        words = sorted({w.lower() for w in re.findall(r"[A-Za-z]{5,}", _prompt_text(messages))})
        query = " or ".join(w for w in words if w not in _NOT_THE_PRODUCT) or "shall"
        return "Searching the library for the product.", [
            ("search_regulations", {"query": query, "limit": 50})
        ]
    hits = returns["search_regulations"][0]
    screened = returns["screen_regulations"][0]
    kept = {v["regulation"] for v in screened["applies"] + screened["possibly"]}
    codes = [c for c in codes if c in kept or any(h["regulation"] == c for h in hits)]
    if not codes:
        summary = "No regulation in the library speaks about this product."
        return summary, [("submit", {"summary": summary})]
    if "write_requirements" not in returns:
        return f"Writing the requirements of {', '.join(codes)}.", [
            ("write_requirements", {"regulations": codes})
        ]
    if "check_requirements" not in returns:
        return "Checking what was written.", [("check_requirements", {})]
    check = returns["check_requirements"][0]
    rejects = [f["ext_id"] for f in check["findings"] if f["action"] == "reject"]
    if rejects and "reject_requirements" not in returns:
        return f"Rejecting {len(rejects)} requirement(s) the check flagged.", [
            ("reject_requirements", {"ext_ids": rejects, "reason": "The check marked them reject."})
        ]
    written = sum(w["requirements"] for w in returns["write_requirements"][0]["written"].values())
    if "export_requirements" not in returns:
        summary = (
            f"{written} requirements from {', '.join(codes)}; the check flagged "
            f"{len(check['findings'])} and {len(rejects)} were rejected."
        )
        return "Asking for approval.", [("export_requirements", {"summary": summary})]
    if denied["export_requirements"]:
        outcome = f"The export was denied ({returns['export_requirements'][0]}); nothing approved."
    else:
        outcome = f"{returns['export_requirements'][0]['approved']} requirements approved."
    summary = f"Read {', '.join(codes)} and wrote {written} requirements. {outcome}"
    return summary, [("submit", {"summary": summary})]


def _write(messages: list[ModelMessage]) -> tuple[str, list[Call]]:
    # One requirement per paragraph with a "shall", answering for all of its listed clauses: the
    # loop and the coverage check are what this exercises, not the splitting.
    drafts: list[dict[str, Any]] = []
    current: tuple[int, str] | None = None
    for line in _prompt_text(messages).splitlines():
        if match := _PARAGRAPH.match(line):
            current = (int(match.group(1)), match.group(2))
            continue
        if clause := _CLAUSE.match(line):
            if drafts and drafts[-1]["ref"] == int(clause.group(1)[1:].split(".")[0]):
                drafts[-1]["clauses"].append(clause.group(1))
            continue
        if current and re.search(r"\b(shall|must)\b", line, re.IGNORECASE):
            ref, label = current
            drafts.append(
                {
                    "ref": ref,
                    # The scripted model reads no profile: every obligation is on the whole part.
                    "covers": "the part",
                    "clauses": [],
                    "text": f"The product shall meet {label}: {line.strip()[:300]}",
                    "test_case": f"Inspect or test the product against {label}.",
                }
            )
            current = None
    return "", [("record_requirements", {"requirements": drafts, "set_aside": []})]


def _dispose(messages: list[ModelMessage]) -> tuple[str, list[Call]]:
    # The same policy as the one-stage writer, as obligations: one per paragraph with a "shall".
    _, calls = _write(messages)
    drafts = calls[0][1]["requirements"]
    obligations = [
        {"ref": d["ref"], "covers": d["covers"], "clauses": d["clauses"], "what": d["text"][:400]}
        for d in drafts
    ]
    return "", [("record_disposition", {"obligations": obligations, "set_aside": []})]


# An obligation as writer.TranslationJob.render() heads it: "## Obligation 1: [#12] 5.4.2 (page 5)".
_OBLIGATION = re.compile(r"^## Obligation \d+: \[#(\d+)\] (.+) \(page \d+\)$")


def _translate(messages: list[ModelMessage]) -> tuple[str, list[Call]]:
    drafts: list[dict[str, Any]] = []
    for line in _prompt_text(messages).splitlines():
        if match := _OBLIGATION.match(line):
            drafts.append({"ref": int(match.group(1)), "label": match.group(2), "clauses": []})
        elif line.startswith("What it obliges: ") and drafts:
            what = line.removeprefix("What it obliges: ")
            drafts[-1]["text"] = what if what.startswith("The product") else f"The product: {what}"
        elif (clause := re.match(r"^Clause \{(c\d+\.\d+)\}", line)) and drafts:
            drafts[-1]["clauses"].append(clause.group(1))
    out = [
        {
            "ref": d["ref"],
            "clauses": d["clauses"],
            "text": d.get("text", "The product shall."),
            "test_case": f"Inspect or test the product against {d['label']}.",
        }
        for d in drafts
    ]
    return "", [("record_translations", {"response": out})]


# A regulation as screen.Candidate.render() heads it: "## UN R1: Title (version 00)".
_CANDIDATE = re.compile(r"^## (.+?): ", re.M)


def _screen(messages: list[ModelMessage]) -> tuple[str, list[Call]]:
    """`applies` when the scope section shares a word of five letters or more with the part's
    one-line description, else `does_not`: enough to test the plumbing, not a judgement."""
    text = _prompt_text(messages)
    part = re.search(r"^The part: (.*)$", text, re.M)
    words = {w.lower() for w in re.findall(r"[A-Za-z]{5,}", part.group(1) if part else "")}
    words -= _NOT_THE_PRODUCT
    verdicts: list[dict[str, Any]] = []
    blocks = _CANDIDATE.split(text)[1:]
    for code, block in zip(blocks[::2], blocks[1::2], strict=True):
        scope = block.split("Scope section:", 1)[-1].split("Transitional provisions", 1)[0]
        found = sorted(w for w in words if w in scope.lower())
        verdicts.append(
            {
                "regulation": code,
                "verdict": "applies" if found else "does_not",
                "reason": f"Its scope mentions {', '.join(found)}." if found else "No match.",
                "scope_quote": scope.strip()[:200],
                "profile_entries": [],
            }
        )
    return "", [("report_screen", {"response": verdicts})]


def _check(messages: list[ModelMessage]) -> tuple[str, list[Call]]:
    findings: list[dict[str, str]] = []
    for block in _prompt_text(messages).split("\n### ")[1:]:
        ext_id = block.split(":", 1)[0].strip()
        if _OBSOLETE.search(block.split("Cited paragraph:", 1)[-1]):
            findings.append(
                {"ext_id": ext_id, "problem": "Its paragraph is obsolete.", "action": "reject"}
            )
    return "", [("report_findings", {"response": findings})]


def _review(messages: list[ModelMessage]) -> tuple[str, list[Call]]:
    """Agrees with the text comparison: quotes the first old sentence shown and, for a flag, the
    first new one. So a scripted sub-goal run gives exactly the rules' file, which is what the
    plumbing test needs; judging meaning is what a real model is for."""
    verdicts: list[dict[str, Any]] = []
    for block in _prompt_text(messages).split("\n### ")[1:]:
        rid = block.split("\n", 1)[0].strip()
        old_part, _, rest = block.partition("New version:")
        new_part, _, finding = rest.partition("Text comparison:")
        old_lines = [ln[2:] for ln in old_part.splitlines() if ln.startswith("- ")]
        new_lines = [ln[2:] for ln in new_part.splitlines() if ln.startswith("- ")]
        said = finding.strip().split(":", 1)[0]
        verdict = said if said in ("modified", "removed") else "unchanged"
        verdicts.append(
            {
                "requirement_id": rid,
                "verdict": verdict,
                "old_quote": old_lines[0] if old_lines else "",
                "new_quote": new_lines[0] if verdict == "modified" and new_lines else None,
                "reason": f"As the text comparison found: {verdict}.",
            }
        )
    return "", [("report_verdicts", {"response": verdicts})]


def _write_changes(messages: list[ModelMessage]) -> tuple[str, list[Call]]:
    """Writes each change as the regulation's new text, as printed. So a scripted sub-goal run
    gives the rules' file, and a text over the schema's cap fails the check and keeps the rules'
    shortened one; rewriting it as a requirement is what a real model is for."""
    written: list[dict[str, Any]] = []
    for block in _prompt_text(messages).split("\n### ")[1:]:
        cid = block.split(" ", 1)[0].strip()
        text = next(
            (
                ln.split(": ", 1)[1]
                for ln in block.splitlines()
                if ln.startswith("New regulation text: ")
            ),
            "",
        )
        written.append({"id": cid, "texts": [text]})
    return "", [("record_texts", {"response": written})]


# A requirement line as assistant.requirement_lines writes it.
_REQUIREMENT = re.compile(r"^- (R-\d+) \[\w+\] (.+) (\S+), paragraph (\S+), page (\d+): ", re.M)


def _chat(messages: list[ModelMessage]) -> tuple[str, list[Call]]:
    """A requirement named in the question: read its paragraph, then quote it. Anything else:
    search the library with the question, then say which hit a requirement cites."""
    question, instructions = "", ""
    for message in messages:
        if isinstance(message, ModelRequest):
            instructions = message.instructions or instructions
            for part in message.parts:
                if isinstance(part, UserPromptPart) and isinstance(part.content, str):
                    question = part.content
    returns, _ = _returns(messages[-1:])
    cited = {m.group(1): m.groups()[1:] for m in _REQUIREMENT.finditer(instructions)}
    if named := next((r for r in re.findall(r"R-\d+", question) if r in cited), None):
        regulation, version, paragraph, page = cited[named]
        if "read_paragraph" not in returns:
            args = {"regulation": regulation, "paragraph": paragraph, "version": version}
            return "", [("read_paragraph", args)]
        text = returns["read_paragraph"][0].get("text", "")
        return f"{named} cites {regulation} {version}, {paragraph}, page {page}: {text}", []
    if "search_regulations" not in returns:
        return "", [("search_regulations", {"query": question, "limit": 3})]
    lines = []
    for hit in returns["search_regulations"][0]:
        by = [
            r
            for r, (reg, ver, para, _) in cited.items()
            if (reg, ver, para) == (hit["regulation"], hit["version"], hit["paragraph"])
        ]
        where = f"{hit['regulation']} {hit['version']}, {hit['paragraph']}, page {hit['page']}"
        lines.append(f"{where}: cited by {', '.join(by)}." if by else f"{where}: not cited.")
    return "\n".join(lines) or "The library has nothing on this.", []


def _next_step(messages: list[ModelMessage], info: AgentInfo) -> tuple[str, list[Call]]:
    outputs = {t.name for t in info.output_tools}
    if not outputs and any(t.name == "read_paragraph" for t in info.function_tools):
        return _chat(messages)
    if "record_requirements" in outputs:
        return _write(messages)
    if "record_disposition" in outputs:
        return _dispose(messages)
    if "record_translations" in outputs:
        return _translate(messages)
    if "report_findings" in outputs:
        return _check(messages)
    if "report_verdicts" in outputs:
        return _review(messages)
    if "record_texts" in outputs:
        return _write_changes(messages)
    if "report_screen" in outputs:
        return _screen(messages)
    return _orchestrate(messages)


async def _stream(
    messages: list[ModelMessage], info: AgentInfo
) -> AsyncIterator[str | DeltaToolCalls]:
    text, calls = _next_step(messages, info)
    if text:
        yield text
    for index, (name, args) in enumerate(calls):
        yield {index: DeltaToolCall(name=name, json_args=json.dumps(args))}


def _respond(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
    text, calls = _next_step(messages, info)
    parts: list[TextPart | ToolCallPart] = [TextPart(text)] if text else []
    return ModelResponse(parts=[*parts, *(ToolCallPart(name, args) for name, args in calls)])


def scripted_model() -> FunctionModel:
    # Both forms: the service streams (to record events as they happen), sub-agents and the evals
    # do not.
    return FunctionModel(_respond, stream_function=_stream, model_name="scripted")
