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
    paragraph it is shown for any other. It speaks both writer protocols (one stage, or the
    disposition then the translators), by the output tool it is given."""

    async def model(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        text = str(messages)
        if marker in text:
            await asyncio.sleep(30)
        ref = int(text.split("[#", 1)[1].split("]", 1)[0])
        draft = {"ref": ref, "text": "The lamp shall.", "test_case": "Look."}
        tool = info.output_tools[0].name
        if tool == "record_disposition":
            args: dict[str, Any] = {"obligations": [{"ref": ref, "what": "It shall."}]}
        elif tool == "record_translations":
            args = {"response": [draft]}
        else:
            args = {"requirements": [draft]}
        return ModelResponse(parts=[ToolCallPart(tool, args)])

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


async def test_the_one_stage_writer_still_stores_what_it_writes(store, settings) -> None:
    # WRITER_STAGES=one is the way back if two stages make a run too slow.
    d = deps(store, settings.model_copy(update={"subagent_timeout_s": 0.2, "writer_stages": "one"}))

    result = await tools.write_requirements(ctx(d, stalls_on("obsolete")), ["UN R148"])

    assert result["written"]["UN R148"] == {"version": "00", "windows": 2, "requirements": 1}
    assert len(result["failed_windows"]) == 1


async def test_no_writer_call_starts_once_the_run_is_inside_its_write_reserve(
    store, settings
) -> None:
    # The first two-stage run on dev ran out of time mid-write and never checked or submitted. A
    # call that cannot finish before the reserve is not started, so the run moves on to check.
    d = deps(store, settings)
    d.deadline = asyncio.get_running_loop().time() + settings.write_reserve_s + 5

    result = await tools.write_requirements(ctx(d, stalls_on("no marker")), ["UN R148"])

    assert result["written"]["UN R148"]["requirements"] == 0
    assert all(f["error"].startswith("OutOfTime: not started") for f in result["failed_windows"])
    assert len(result["failed_windows"]) == 2


async def test_a_windows_translations_start_while_other_windows_are_still_disposed(
    store, settings
) -> None:
    # In one shared lane every window's first stage queued ahead of every translation (#48).
    d = deps(store, settings.model_copy(update={"translate_concurrency": 1}))
    d.concurrency = 1
    order: list[str] = []
    inner = stalls_on("no marker").function
    assert inner is not None

    async def model(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        tool = info.output_tools[0].name
        order.append(f"start {tool}")
        await asyncio.sleep(0.01)
        response = await inner(messages, info)  # type: ignore[misc]
        order.append(f"end {tool}")
        return response

    await tools.write_requirements(ctx(d, FunctionModel(model)), ["UN R148"])

    last_disposition_ends = max(i for i, e in enumerate(order) if e == "end record_disposition")
    assert order.index("start record_translations") < last_disposition_ends
