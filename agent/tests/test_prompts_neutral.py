"""Nothing a model reads names a regulation, a paragraph or the dev case's product (SYS-42).

Why a test: the first writer prompts carried examples from the only case we had (a rear lamp), so
on a different part they pointed the model at the wrong things. Nobody meant it; a rule kept in
memory did not stop it. What a model reads is the prompt files, the tool descriptions and the
output-field descriptions; code comments are not read and may name what they parse.

Why the agents are found and not listed (audit of 2026-10-25): a hand-kept list had missed the
writer's, the first stage's, the translator's and the screen's output schemas and the
translator's tool. Every module-level `Agent` of the domain is read now, so a new one is covered
the day it is added. String literals in the domain code are scanned too, for the product words
only: a retry message or a prompt built in code reaches the model without passing through a
`.md` file, while regex fragments in parsers would trip the number patterns.
"""

import ast
import importlib
import inspect
import pkgutil
import re
from pathlib import Path
from typing import Any

from pydantic import BaseModel, TypeAdapter
from pydantic_ai import Agent, ToolOutput
from pydantic_ai.toolsets.function import FunctionToolset

import agent_service.domain as domain
from agent_service.domain import (
    assistant,
    case_ingest,
    regulation_search,
    subgoal_review,
    subgoal_write,
    writer,
)
from agent_service.domain.tools import toolset

DOMAIN = Path(writer.__file__).parent

# "R10", "UN R148", "R 48", "GTR 9", "ECE-R7". Not our own ids ("R-012") nor a placeholder
# ("UN R<n>").
REGULATION_CODE = re.compile(r"\b(?:R|GTR)\s?\d{1,3}\b")
# A paragraph label with at least two numbers, "5.4.2" or "6.1": an example a model copies.
PARAGRAPH_LABEL = re.compile(r"\b\d+\.\d+(?:\.\d+)*\b")
# The dev case's product and its families: the held-out case is a different part.
# Extended 2026-10-25 with the rest of the light-signalling vocabulary and with the part people
# guess the held-out case is (unconfirmed): a prompt tuned to a guess overfits as much as one
# tuned to the dev case. "light source" is not here: the profile's generic list of component
# kinds names it next to sensors and actuators, which every part family has an equivalent of.
DEV_PRODUCT = re.compile(
    r"lamp|reflector|retro-?reflect|photometr|luminous|luminance|candela|tail.?light|stop.?light"
    r"|direction indicator|turn signal|bulb|bumper|fascia|rear-lamp",
    re.IGNORECASE,
)
# Code that writes no prompt and whose strings no model reads: the scripted stand-in model.
_NOT_MODEL_READ = {"scripted.py"}


def _tool_texts() -> dict[str, str]:
    texts: dict[str, str] = {}
    sets = {
        "orchestrator": toolset,
        "check": writer.check_agent._function_toolset,  # pyright: ignore[reportPrivateUsage]
        "assistant": assistant.assistant._function_toolset,  # pyright: ignore[reportPrivateUsage]
        "sub-goal reviewer": subgoal_review.reviewer_agent._function_toolset,  # pyright: ignore[reportPrivateUsage]
    }
    for owner, tools in sets.items():
        for name, tool in tools.tools.items():
            texts[f"{owner} tool {name}"] = (
                f"{tool.description}\n{tool.function_schema.json_schema}"
            )
    return texts


def _field_texts() -> dict[str, str]:
    models: list[type[BaseModel]] = [
        writer.Draft,
        writer.Finding,
        regulation_search.ScopeSummary,
        subgoal_review.Verdict,
        subgoal_write.Written,
    ]
    return {f"fields of {m.__name__}": str(m.model_json_schema()) for m in models}


def domain_agents() -> dict[str, Agent[Any, Any]]:
    """Every module-level Agent of the domain package, by module and name."""
    found: dict[int, tuple[str, Agent[Any, Any]]] = {
        id(domain.agent): ("orchestrator", domain.agent)
    }
    for info in pkgutil.iter_modules(domain.__path__):
        module = importlib.import_module(f"{domain.__name__}.{info.name}")
        for name, value in vars(module).items():
            if isinstance(value, Agent):
                found.setdefault(id(value), (f"{info.name}.{name}", value))  # pyright: ignore[reportUnknownArgumentType]
    return dict(found.values())


def _agent_texts() -> dict[str, str]:
    """Each agent's tools and output schemas: what reaches the model besides the instructions."""
    texts: dict[str, str] = {}
    for owner, agent in domain_agents().items():
        toolsets = [agent._function_toolset, *agent._user_toolsets]  # pyright: ignore[reportPrivateUsage]
        for tools in toolsets:
            if not isinstance(tools, FunctionToolset):
                continue
            for name, tool in tools.tools.items():  # pyright: ignore[reportUnknownVariableType]
                texts[f"{owner} tool {name}"] = (
                    f"{tool.description}\n{tool.function_schema.json_schema}"  # pyright: ignore[reportUnknownMemberType]
                )
        outputs = agent._output_type  # pyright: ignore[reportPrivateUsage]
        for out in outputs if isinstance(outputs, list) else [outputs]:  # pyright: ignore[reportUnknownVariableType]
            if not isinstance(out, ToolOutput):
                continue
            spec = out.output  # pyright: ignore[reportUnknownMemberType, reportUnknownVariableType]
            if inspect.isfunction(spec):
                text = inspect.getdoc(spec) or ""
            else:
                text = str(TypeAdapter(spec).json_schema())  # pyright: ignore[reportUnknownArgumentType, reportArgumentType]
            texts[f"{owner} output {out.name}"] = text
    return texts


_DOCUMENTED = ast.Module | ast.ClassDef | ast.FunctionDef | ast.AsyncFunctionDef


def _code_strings() -> dict[str, str]:
    """String literals of the domain code, without docstrings: those are read by people, except a
    tool's, which is its description and is read with the agent's tools (`_agent_texts`)."""
    texts: dict[str, str] = {}
    for path in sorted(DOMAIN.glob("*.py")):
        if path.name in _NOT_MODEL_READ:
            continue
        tree = ast.parse(path.read_text())
        docstrings: set[int] = set()
        for node in ast.walk(tree):
            if isinstance(node, _DOCUMENTED) and node.body:
                first = node.body[0]
                if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant):
                    docstrings.add(id(first.value))
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Constant)
                and isinstance(node.value, str)
                and id(node) not in docstrings
            ):
                texts[f"{path.name} line {node.lineno}"] = node.value
    return texts


def model_read_texts() -> dict[str, str]:
    texts = {f"{p.name}": p.read_text() for p in sorted(DOMAIN.glob("*.md"))}
    texts["case transcription instructions"] = case_ingest._INSTRUCTIONS  # pyright: ignore[reportPrivateUsage]
    texts["scope summary instructions"] = regulation_search._SUMMARY_INSTRUCTIONS  # pyright: ignore[reportPrivateUsage]
    return texts | _tool_texts() | _field_texts() | _agent_texts()


def test_the_texts_are_found() -> None:
    texts = model_read_texts()
    assert {"prompt.md", "writer.md", "check.md"} <= texts.keys()
    assert any(k.startswith("orchestrator tool write_requirements") for k in texts)
    # The sub-goal's reviewer is held to the same rule (Clemente, 2026-10-24: #32 holds for the
    # sub-goal prompts too).
    assert "subgoal_review.md" in texts
    assert "subgoal_write.md" in texts
    assert any(k.startswith("sub-goal reviewer tool search_new_version") for k in texts)
    # Found without a list: the outputs and tools the hand-kept list had missed.
    for key in (
        "writer.writer_agent output record_requirements",
        "writer.disposition_agent output record_disposition",
        "writer.translator_agent tool read_version_paragraphs",
        "screen.screen_agent output report_screen",
        "orchestrator output submit",
        "orchestrator tool record_product_profile",
    ):
        assert key in texts, key


def test_no_model_read_text_names_a_regulation_paragraph_or_the_dev_product() -> None:
    found = [
        f"{where}: {m.group(0)!r}"
        for where, text in model_read_texts().items()
        for pattern in (REGULATION_CODE, PARAGRAPH_LABEL, DEV_PRODUCT)
        for m in pattern.finditer(text)
    ]
    assert not found, "Use a placeholder (UN R<n>, x.y.z) or a part-neutral word:\n" + "\n".join(
        found
    )


def test_no_string_in_the_domain_code_names_the_dev_product() -> None:
    found = [
        f"{where}: {m.group(0)!r}"
        for where, text in _code_strings().items()
        for m in DEV_PRODUCT.finditer(text)
    ]
    assert not found, "A string in code can reach a model (a retry, a prompt built in code):\n" + (
        "\n".join(found)
    )


def test_the_patterns_catch_what_they_are_for() -> None:
    assert REGULATION_CODE.search('e.g. ["UN R148"]')
    assert REGULATION_CODE.search("GTR 9 applies")
    assert not REGULATION_CODE.search('e.g. ["UN R<n>"]')
    assert not REGULATION_CODE.search("reject R-012")
    assert PARAGRAPH_LABEL.search('["5.4.2"]')
    assert not PARAGRAPH_LABEL.search('["x.y.z"]')
    assert DEV_PRODUCT.search("another lamp function")
    assert DEV_PRODUCT.search("retro-reflective devices")
    assert DEV_PRODUCT.search("the bumper beam")
    assert not DEV_PRODUCT.search("the light source, a sensor, an actuator")
