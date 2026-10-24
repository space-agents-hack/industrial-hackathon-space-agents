"""A model that is not a model: a fixed policy for each of the three agents, with no provider and
no network. `AGENT_MODEL=scripted` selects it.

Why it exists: the whole loop (the orchestrator's tools, the parallel writers, the check, the
approval pause and the resume) runs in tests, on a fresh clone with no API key, and on stage if
the network goes down. It reads the same prompts and tool results a real model would and decides
from them. What it writes is mechanical ("The product shall meet 5.4.2: ..."): it proves the
plumbing, never the quality of requirements. That is what `make eval` with a real model is for.

Which agent is asking is told by the output tool it was given: `submit` (orchestrator),
`record_requirements` (writer), `report_findings` (check). The run page's chat
(domain/run_chat.py) has no output tool and answers in text; it is told by its `read_paragraph`.
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
    codes = [c for c in codes if any(h["regulation"] == c for h in hits)]
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
    drafts: list[dict[str, Any]] = []
    current: tuple[int, str] | None = None
    for line in _prompt_text(messages).splitlines():
        if match := _PARAGRAPH.match(line):
            current = (int(match.group(1)), match.group(2))
            continue
        if current and re.search(r"\b(shall|must)\b", line, re.IGNORECASE):
            ref, label = current
            drafts.append(
                {
                    "ref": ref,
                    "text": f"The product shall meet {label}: {line.strip()[:300]}",
                    "test_case": f"Inspect or test the product against {label}.",
                }
            )
            current = None
    return "", [("record_requirements", {"response": drafts})]


def _check(messages: list[ModelMessage]) -> tuple[str, list[Call]]:
    findings: list[dict[str, str]] = []
    for block in _prompt_text(messages).split("\n### ")[1:]:
        ext_id = block.split(":", 1)[0].strip()
        if _OBSOLETE.search(block.split("Cited paragraph:", 1)[-1]):
            findings.append(
                {"ext_id": ext_id, "problem": "Its paragraph is obsolete.", "action": "reject"}
            )
    return "", [("report_findings", {"response": findings})]


# A requirement line as run_chat.requirement_lines writes it.
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
    if "report_findings" in outputs:
        return _check(messages)
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
