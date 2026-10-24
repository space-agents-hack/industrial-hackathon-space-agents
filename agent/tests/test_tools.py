"""The writer tools around the model calls: what a call that never answers leaves, and what a
failed window hands back for a retry (#36, #37). Made-up library (tests/fakes.py); the models are
pydantic-ai's FunctionModel, so no provider is reached."""

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
