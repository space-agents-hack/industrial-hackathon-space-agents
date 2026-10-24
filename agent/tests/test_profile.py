"""The product profile (SYS-43): recorded once, read by every writer and the check, required
before anything is written, and read back from the trace when a run resumes after a pause."""

import io

import pytest
from PIL import Image
from pydantic_ai import BinaryContent, ConversationTypeAdapter, ModelRetry
from pydantic_ai.messages import (
    ModelRequest,
    ModelResponse,
    ToolCallPart,
    UserPromptPart,
)

from agent_service import runner
from agent_service.domain import tools, writer
from agent_service.records import CaseFileBlock
from agent_service.settings import Settings
from tests.fakes import InMemoryRunStore, case_run

pytestmark = pytest.mark.anyio

PROFILE = writer.ProductProfile(
    part="A made-up body panel.",
    does=["covers the front of the vehicle"],
    does_not=["no lighting function"],
    contains=["an ultrasonic sensor behind an opening", "a wiring harness"],
    mounted=["front end, lowest edge 300 mm above ground"],
    vehicles=["M1"],
)


def deps(store: InMemoryRunStore, settings: Settings) -> tools.Deps:
    run_id = case_run(store)
    return tools.Deps(
        store=store,
        run=store.runs[run_id],
        case_name="a-case",
        case_parts=["## Case file: spec.md\nA made-up body panel."],
        team_id="team-00",
        settings=settings,
    )


def test_the_profile_lists_every_field_and_says_what_is_not_stated() -> None:
    text = PROFILE.render()

    assert "an ultrasonic sensor behind an opening" in text
    assert "no lighting function" in text
    # Markets were not given: said so, not left out, so a writer does not read silence as "none".
    assert text.split("Markets:")[1].lstrip().startswith("- (nothing stated)")


async def test_writers_and_the_check_read_the_profile_after_the_case(store, settings) -> None:
    d = deps(store, settings)
    assert not any("product profile" in str(p) for p in tools._case(d))  # pyright: ignore[reportPrivateUsage]

    d.profile = PROFILE
    parts = tools._case(d)  # pyright: ignore[reportPrivateUsage]

    assert parts[-1] == PROFILE.render()
    assert "A made-up body panel." in str(parts[1])


async def test_nothing_is_written_before_the_profile(store, settings) -> None:
    with pytest.raises(ModelRetry, match="record_product_profile"):
        await tools._require_profile(deps(store, settings))  # pyright: ignore[reportPrivateUsage]


async def test_after_a_pause_the_profile_is_read_back_from_the_trace(store, settings) -> None:
    d = deps(store, settings)
    await store.add_event(
        d.run.id,
        "tool_call",
        {"tool_call_id": "a", "tool_name": "record_product_profile", "args": {"part": "first"}},
    )
    await store.add_event(
        d.run.id,
        "tool_call",
        {"tool_call_id": "b", "tool_name": "record_product_profile", "args": PROFILE.model_dump()},
    )

    assert await tools._require_profile(d) == PROFILE  # pyright: ignore[reportPrivateUsage]


async def test_a_run_records_the_profile_before_it_searches_or_writes(store, settings) -> None:
    run_id = case_run(store)
    plan = await runner.prepare(store, settings, run_id)
    await runner.execute(store, settings, plan)

    called = [p["tool_name"] for p in store.payloads(run_id, "tool_call")]
    assert called.index("record_product_profile") < called.index("search_regulations")
    assert called.index("record_product_profile") < called.index("write_requirements")


async def test_the_drawings_of_the_case_reach_the_model_before_it_records_the_profile(
    store, settings
) -> None:
    # Plumbing, not judgement: whether the model reads the drawing well is for a hosted run.
    # What can break here is the drawing never being shown, which is what this checks.
    run_id = case_run(store)
    case_id = store.runs[run_id].case_id
    assert case_id is not None
    image = io.BytesIO()
    Image.new("L", (8, 8)).save(image, format="PNG")
    file_id = store.add_case_file(case_id, "exploded_view.png", "png", image.getvalue())
    files = store.cases[case_id]
    files[-1] = files[-1].model_copy(update={"status": "parsed"})
    store.blocks[file_id] = [
        CaseFileBlock(
            file_id=file_id,
            seq=0,
            kind="image",
            image_path=files[-1].storage_path,
            media_type="image/png",
            parser="pillow",
        )
    ]

    plan = await runner.prepare(store, settings, run_id)
    await runner.execute(store, settings, plan)

    seen = ConversationTypeAdapter.validate_python(store.conversations[run_id]).messages
    first_image = next(
        i
        for i, m in enumerate(seen)
        if isinstance(m, ModelRequest)
        and any(
            isinstance(p, UserPromptPart)
            and not isinstance(p.content, str)
            and any(isinstance(c, BinaryContent) and c.is_image for c in p.content)
            for p in m.parts
        )
    )
    profile_call = next(
        i
        for i, m in enumerate(seen)
        if isinstance(m, ModelResponse)
        and any(
            isinstance(p, ToolCallPart) and p.tool_name == "record_product_profile" for p in m.parts
        )
    )
    assert first_image < profile_call
