"""Pictures in the regulation PDFs (#52, SYS-23): found and rendered from the PDF, described once
per organisation by the organisation's vision model, written into the paragraph they sit in, and
the import coming back for those it could not describe. The PDF is the made-up
tests/fixtures/regulation/figures.pdf; the model is pydantic-ai's FunctionModel, so no provider is
reached and what a picture "says" is the test's."""

import time
from pathlib import Path
from typing import Any

import pytest
from pydantic_ai.exceptions import ModelHTTPError
from pydantic_ai.messages import (
    BinaryContent,
    ModelMessage,
    ModelRequest,
    ModelResponse,
    TextPart,
    UserPromptPart,
)
from pydantic_ai.models.function import AgentInfo, FunctionModel

from agent_service import metering, providers
from agent_service.domain import figures, pdf_figures, regulations
from agent_service.domain.figures import Described, FigureStep
from agent_service.domain.paragraphs import extract
from agent_service.settings import Settings
from tests.library_fakes import ORG, InMemoryLibraryStore
from tests.test_regulations import Server, entry, public

pytestmark = pytest.mark.anyio

FIGURES = (Path(__file__).parent / "fixtures" / "regulation" / "figures.pdf").read_bytes()
MODEL = "anthropic:claude-haiku-5-5"


def far() -> float:
    return time.monotonic() + 60


@pytest.fixture
def library() -> InMemoryLibraryStore:
    store = InMemoryLibraryStore()
    store.models[figures.PROCESS] = MODEL
    return store


@pytest.fixture
def seen(monkeypatch: pytest.MonkeyPatch) -> list[bytes]:
    """The model answers with the size of the PNG it was sent, and records each PNG."""
    pngs: list[bytes] = []

    def model(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        request = next(m for m in reversed(messages) if isinstance(m, ModelRequest))
        prompt = next(p for p in request.parts if isinstance(p, UserPromptPart))
        image = next(c for c in prompt.content if isinstance(c, BinaryContent))
        pngs.append(image.data)
        return ModelResponse(parts=[TextPart(f"A picture of {len(image.data)} bytes, 0.5 m.")])

    monkeypatch.setattr(providers, "build_model", lambda *_: FunctionModel(model))
    return pngs


def step(library: InMemoryLibraryStore, settings: Settings) -> FigureStep:
    return FigureStep(library, settings, ORG, metering.Meter(ORG))


# ------------------------------------------------------------------------- finding and rendering


def test_pictures_are_found_by_page_and_icons_are_left_out() -> None:
    found = pdf_figures.figures(FIGURES)

    # The mounting picture on page 1 and again on page 2, the chart on page 2; the 16 px mark in
    # the text of 6.2 is too small to say anything.
    assert [(f.page, f.position) for f in found] == [(1, 0), (2, 0), (2, 1)]
    assert found[0].sha256 == found[2].sha256 != found[1].sha256
    assert all(f.width >= 40 and f.height >= 40 for f in found)


def test_each_distinct_picture_is_rendered_once_as_a_png() -> None:
    found = pdf_figures.figures(FIGURES)

    images = pdf_figures.render(FIGURES, found)

    assert set(images) == {f.sha256 for f in found}
    assert all(png.startswith(b"\x89PNG") for png in images.values())


# ---------------------------------------------------------------------- into the paragraphs


def test_a_description_is_written_into_the_paragraph_the_picture_sits_in() -> None:
    found = pdf_figures.figures(FIGURES)
    setup, chart = found[0].sha256, found[1].sha256

    extraction = extract(FIGURES, {setup: "Lamp  0.5 m\nabove ground.", chart: "A curve."})

    text = {p.label: p.text for p in extraction.paragraphs}
    assert text["6.1"].endswith("Figure 1 Mounting\n[Figure: Lamp 0.5 m above ground.]")
    assert text["7.1"].endswith("[Figure: A curve.]")
    # The same picture again, further on: its description again, where it is.
    assert text["7.2"].endswith("[Figure: Lamp 0.5 m above ground.]")
    assert "[Figure" not in text["6.2"]
    assert extraction.figures == found


def test_descriptions_change_no_label_and_no_page() -> None:
    found = pdf_figures.figures(FIGURES)
    without = extract(FIGURES)
    described = extract(FIGURES, {f.sha256: "6.3. Not a paragraph." for f in found})

    # Even a description that reads like a paragraph number does not start a paragraph.
    def where(e: Any) -> list[tuple[Any, ...]]:
        return [(p.label, p.page_start, p.page_end) for p in e.paragraphs]

    assert where(described) == where(without)
    assert "[Figure" not in " ".join(p.text for p in without.paragraphs)


# ------------------------------------------------------------------------ the vision model


async def test_each_distinct_picture_is_described_once_and_kept_with_its_model(
    library: InMemoryLibraryStore, settings: Settings, seen: list[bytes]
) -> None:
    outcome = await step(library, settings)("UN R999 2.1.0", FIGURES, far())

    assert len(seen) == 2
    assert outcome.missing == 0
    assert len(outcome.descriptions) == 2
    kept = list(library.descriptions.values())
    assert {d.model for d in kept} == {MODEL}
    assert all(d.description and "0.5 m" in d.description for d in kept)

    # Another version with the same pictures: nothing is sent again.
    again = await step(library, settings)("UN R999 2.2.0", FIGURES, far())

    assert len(seen) == 2
    assert again.descriptions == outcome.descriptions


async def test_the_calls_are_metered_as_figures(
    library: InMemoryLibraryStore, settings: Settings, seen: list[bytes]
) -> None:
    meter = metering.Meter(ORG)

    await FigureStep(library, settings, ORG, meter)("UN R999 2.1.0", FIGURES, far())
    await meter.flush(library)

    assert {row["process"] for row in library.usage} == {"figures"}
    assert sum(row["requests"] for row in library.usage) == 2


async def test_without_a_figure_model_nothing_is_sent_and_the_pictures_count_as_missing(
    settings: Settings, seen: list[bytes]
) -> None:
    library = InMemoryLibraryStore()  # no model chosen; the tests' FIGURE_MODEL is "scripted"
    described = step(library, settings)

    outcome = await described("UN R999 2.1.0", FIGURES, far())

    assert seen == []
    assert outcome.missing == 2
    assert described.unusable and "Admin" in described.unusable


async def test_a_picture_the_provider_refuses_keeps_the_reason_and_is_not_sent_again(
    library: InMemoryLibraryStore, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[int] = []

    def refuse(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        calls.append(1)
        raise ModelHTTPError(400, MODEL, {"error": "image not supported"})

    monkeypatch.setattr(providers, "build_model", lambda *_: FunctionModel(refuse))

    first = await step(library, settings)("UN R999 2.1.0", FIGURES, far())
    second = await step(library, settings)("UN R999 2.1.0", FIGURES, far())

    assert len(calls) == 2  # the two distinct pictures, once each
    assert first.missing == second.missing == 0
    assert first.descriptions == {}
    assert all(d.description is None and d.error for d in library.descriptions.values())


async def test_a_refused_key_stops_the_step_and_leaves_the_pictures_for_later(
    library: InMemoryLibraryStore, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    def refuse(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        raise ModelHTTPError(401, MODEL, {"error": "invalid x-api-key"})

    monkeypatch.setattr(providers, "build_model", lambda *_: FunctionModel(refuse))
    described = step(library, settings)

    outcome = await described("UN R999 2.1.0", FIGURES, far())

    assert outcome.missing == 2
    assert library.descriptions == {}
    assert described.unusable and MODEL in described.unusable


# ------------------------------------------------------------------------------ the import


async def run(library: InMemoryLibraryStore, settings: Settings, index: list[Any]) -> str:
    job = await regulations.prepare(library, settings, library.add_import(index))
    async with Server({"/UN_R999/2.1.0.pdf": FIGURES}).client() as http:
        return await regulations.execute(
            library, http, settings, job, resolve=public, figures=step(library, settings)
        )


async def test_the_import_describes_the_pictures_and_splits_with_them(
    library: InMemoryLibraryStore, settings: Settings, seen: list[bytes]
) -> None:
    index = [entry("UN R999", ("2.1.0", "base", FIGURES))]

    assert await run(library, settings, index) == "succeeded"

    version = library.version("UN R999", "2.1.0")
    assert [(f.page, f.position) for f in version.figures] == [(1, 0), (2, 0), (2, 1)]
    assert version.figures_missing == 0
    text = {p.label: p.text for p in version.paragraphs}
    assert "[Figure: A picture of" in text["6.1"]


async def test_pictures_left_undescribed_are_described_on_a_later_import(
    settings: Settings, seen: list[bytes]
) -> None:
    library = InMemoryLibraryStore()  # no figure model yet
    index = [entry("UN R999", ("2.1.0", "base", FIGURES))]

    assert await run(library, settings, index) == "succeeded"
    version = library.version("UN R999", "2.1.0")
    assert version.figures_missing == 2
    assert "[Figure" not in " ".join(p.text for p in version.paragraphs)

    # An import without a model again does not split the version again for nothing.
    before = version.paragraphs
    await run(library, settings, index)
    assert version.paragraphs is before  # not saved again

    # Once an admin chooses a model, the next import describes them and splits again.
    library.models[figures.PROCESS] = MODEL
    assert await run(library, settings, index) == "succeeded"

    assert version.figures_missing == 0
    assert "[Figure: A picture of" in {p.label: p.text for p in version.paragraphs}["7.1"]


async def test_a_description_already_kept_is_used_without_calling_the_model(
    library: InMemoryLibraryStore, settings: Settings, seen: list[bytes]
) -> None:
    for f in pdf_figures.figures(FIGURES):
        library.descriptions[(ORG, f.sha256)] = Described("Kept before.", "openai:gpt-5-mini")
    index = [entry("UN R999", ("2.1.0", "base", FIGURES))]

    await run(library, settings, index)

    assert seen == []
    assert "[Figure: Kept before.]" in library.version("UN R999", "2.1.0").paragraphs[3].text
