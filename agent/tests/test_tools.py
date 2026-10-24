"""The writer tools around the model calls: what a call that never answers leaves, what a failed
window hands back for a retry, and which versions a search reads (#36, #39, #40). Made-up library
(tests/fakes.py); the models are pydantic-ai's FunctionModel, so no provider is reached."""

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest
from pydantic_ai.messages import ModelMessage, ModelResponse, ToolCallPart
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.usage import RunUsage

from agent_service.domain import tools, writer
from agent_service.settings import Settings
from tests.fakes import InMemoryRunStore, case_run

pytestmark = pytest.mark.anyio

PROFILE = writer.ProductProfile(
    part="A made-up rear lamp.",
    does=["signals the vehicle's presence from the rear"],
    does_not=[],
    contains=["an LED"],
    mounted=["rear"],
    vehicles=["M1"],
)


def deps(store: InMemoryRunStore, settings: Settings) -> tools.Deps:
    run_id = case_run(store)
    return tools.Deps(
        store=store,
        run=store.runs[run_id],
        case_name="a-case",
        case_parts=["## Case file: spec.md\nA made-up rear lamp."],
        team_id="team-00",
        settings=settings,
        profile=PROFILE,
    )


def stalls_on(marker: str) -> FunctionModel:
    """A writer that never answers for the window containing `marker`, and cites the first
    paragraph it is shown for any other."""

    async def model(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        text = str(messages)
        if marker in text:
            await asyncio.sleep(30)
        ref = int(text.split("[#", 1)[1].split("]", 1)[0])
        return ModelResponse(
            parts=[
                ToolCallPart(
                    "record_requirements",
                    {"response": [{"ref": ref, "text": "The lamp shall.", "test_case": "Look."}]},
                )
            ]
        )

    return FunctionModel(model)


def ctx(d: tools.Deps, model: FunctionModel) -> Any:
    # The three things the tools read from pydantic-ai's RunContext.
    return SimpleNamespace(deps=d, model=model, usage=RunUsage())


async def test_a_window_whose_call_never_answers_fails_alone_and_the_rest_is_stored(
    store, settings
) -> None:
    d = deps(store, settings.model_copy(update={"subagent_timeout_s": 0.2}))

    result = await tools.write_requirements(ctx(d, stalls_on("obsolete")), ["UN R148"])

    assert result["written"]["UN R148"] == {"version": "00", "windows": 2, "requirements": 1}
    [failed] = result["failed_windows"]
    assert failed["pages"] == "20"
    assert failed["error"].startswith("TimeoutError: no answer within 0.2 s")
    assert len(await store.run_requirements(d.run.id)) == 1


async def test_a_failed_window_names_its_labels_and_they_retry_it(store, settings) -> None:
    d = deps(store, settings.model_copy(update={"subagent_timeout_s": 0.2}))
    first = await tools.write_requirements(ctx(d, stalls_on("obsolete")), ["UN R148"])
    [failed] = first["failed_windows"]
    assert failed["paragraphs"] == ["6.1"]
    assert "unnumbered_paragraphs" not in failed

    again = await tools.write_for_paragraphs(
        ctx(d, stalls_on("no marker")), failed["regulation"], failed["paragraphs"]
    )

    assert again == {"requirements": 1, "failed": [], "labels_not_found": []}
    assert len(await store.run_requirements(d.run.id)) == 2


async def test_the_search_finds_a_regulation_whose_only_version_has_no_role(
    store, settings
) -> None:
    d = deps(store, settings)
    store.add_version(
        "UN R<z>", "00", [("3.1", "3.1. The made-up widget shall glow.", 3)], role=None
    )

    hits = await tools.search_regulations(ctx(d, stalls_on("no marker")), "widget glow")

    assert [(h["regulation"], h["paragraph"]) for h in hits] == [("UN R<z>", "3.1")]
    # A regulation's latest version is still not searched when a base exists.
    latest = await tools.search_regulations(ctx(d, stalls_on("no marker")), "four lamps")
    assert all(h["text"] != "6.10.1. Two or four lamps must be fitted." for h in latest)
