"""Nothing a model reads names a regulation, a paragraph or the dev case's product (SYS-42).

Why a test: the first writer prompts carried examples from the only case we had (a rear lamp), so
on a different part they pointed the model at the wrong things. Nobody meant it; a rule kept in
memory did not stop it. What a model reads is the prompt files, the tool descriptions and the
output-field descriptions; code comments are not read and may name what they parse.
"""

import re
from pathlib import Path

from pydantic import BaseModel

from agent_service.domain import assistant, case_ingest, regulation_search, subgoal_review, writer
from agent_service.domain.tools import toolset

DOMAIN = Path(writer.__file__).parent

# "R10", "UN R148", "R 48", "GTR 9", "ECE-R7". Not our own ids ("R-012") nor a placeholder
# ("UN R<n>").
REGULATION_CODE = re.compile(r"\b(?:R|GTR)\s?\d{1,3}\b")
# A paragraph label with at least two numbers, "5.4.2" or "6.1": an example a model copies.
PARAGRAPH_LABEL = re.compile(r"\b\d+\.\d+(?:\.\d+)*\b")
# The dev case's product and its families: the held-out case is a different part.
DEV_PRODUCT = re.compile(r"lamp|reflector|photometr|luminous|tail light", re.IGNORECASE)


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
    ]
    return {f"fields of {m.__name__}": str(m.model_json_schema()) for m in models}


def model_read_texts() -> dict[str, str]:
    texts = {f"{p.name}": p.read_text() for p in sorted(DOMAIN.glob("*.md"))}
    texts["case transcription instructions"] = case_ingest._INSTRUCTIONS  # pyright: ignore[reportPrivateUsage]
    texts["scope summary instructions"] = regulation_search._SUMMARY_INSTRUCTIONS  # pyright: ignore[reportPrivateUsage]
    return texts | _tool_texts() | _field_texts()


def test_the_texts_are_found() -> None:
    texts = model_read_texts()
    assert {"prompt.md", "writer.md", "check.md"} <= texts.keys()
    assert any(k.startswith("orchestrator tool write_requirements") for k in texts)
    # The sub-goal's reviewer is held to the same rule (Clemente, 2026-10-24: #32 holds for the
    # sub-goal prompts too).
    assert "subgoal_review.md" in texts
    assert any(k.startswith("sub-goal reviewer tool search_new_version") for k in texts)


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


def test_the_patterns_catch_what_they_are_for() -> None:
    assert REGULATION_CODE.search('e.g. ["UN R148"]')
    assert REGULATION_CODE.search("GTR 9 applies")
    assert not REGULATION_CODE.search('e.g. ["UN R<n>"]')
    assert not REGULATION_CODE.search("reject R-012")
    assert PARAGRAPH_LABEL.search('["5.4.2"]')
    assert not PARAGRAPH_LABEL.search('["x.y.z"]')
    assert DEV_PRODUCT.search("another lamp function")
