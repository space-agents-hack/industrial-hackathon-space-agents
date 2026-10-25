"""Pictures in the regulation PDFs, described by a vision model during the import (#52, SYS-23).

Why: the PDFs put test set-ups, dimensions, angles and charts in raster pictures that have no
text layer (2,569 of the 2,572 of at least 40 pt in the challenge's 92 PDFs). The writer reads
text, so those values were never seen. In 8 pictures picked at random, 6 carried values a
requirement needs: dimensions with tolerances, a test set-up, a correction formula, a curve with
its lookup table (the counts are on #52).

How: during the import, before a version is split, each of its pictures (pdf_figures.py) that the
organisation has no description of yet is rendered and sent to the vision model, a few at a time.
Each description is saved as soon as it comes back, under the picture's sha256, with the model
that wrote it: the same picture in another version or regulation is not sent again, and a slice
that runs out of time loses nothing. The split then writes each description into the paragraph
the picture sits in (paragraphs.py).

The model is the organisation's choice for process "figures" (Admin, "Figures and part
pictures"), else FIGURE_MODEL. The same choice reads the part's pictures at case upload (api.py).
Every call is metered like the summaries (IF-7).

What this does NOT do:
  - judge what applies. The model is told to transcribe, not to conclude.
  - retry a picture the provider refused as such (a 400 on that image): the error is kept with
    the picture and shown on the regulation page. A refused key or a rate limit stops the step
    instead, and the next import tries again.
  - store the pictures. They are rendered again from the stored PDF when needed.
"""

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Protocol
from uuid import UUID

from pydantic_ai import Agent, BinaryContent

from agent_service import metering, providers
from agent_service.domain import pdf_figures
from agent_service.domain.pdf_figures import Figure
from agent_service.metering import Meter
from agent_service.settings import Settings
from agent_service.slices import each_until

log = logging.getLogger(__name__)

PROCESS = "figures"
# What one description may hold. A dense chart or a drawn table can need a few hundred words; a
# description longer than this is a model that started inventing.
MAX_CHARS = 3000
# Status codes that mean "this picture", not "this key" or "this provider right now".
_PICTURE_ERRORS = {400, 413, 422}

# Describe, do not conclude: the writer decides what is a requirement. Nothing here names a
# regulation, a figure or a value (SYS-42): it has to work on any case.
_INSTRUCTIONS = """You transcribe figures from technical regulations for a requirements engineer
who cannot see them.
Write down everything the figure states: every number with its unit and tolerance, dimensions,
angles, distances, positions, limits, the axes and scales of a chart, the values a curve or a
table in the picture gives, labels and callouts, and what is measured from where.
Then say in one sentence what the figure shows (a test set-up, a measuring arrangement, a chart,
a drawing of a part, a marking).
Do not add what the figure does not show, and do not say what applies or what is required.
If the figure is only a mark, a logo or a symbol with no values, say what it is in one sentence.
Plain text, no headings, at most 250 words. If something is unreadable, write [unreadable]."""

_agent = Agent(output_type=str, instructions=_INSTRUCTIONS)


@dataclass(frozen=True)
class Described:
    """What the organisation has for one picture: a description, or why there is none."""

    description: str | None
    model: str
    error: str | None = None


class FigureStore(providers.CredentialStore, metering.UsageSink, Protocol):
    async def organization_model(self, org: UUID, process: str) -> str | None: ...

    async def figure_descriptions(self, org: UUID, shas: list[str]) -> dict[str, Described]:
        """The organisation's descriptions (and recorded errors) of these pictures."""
        ...

    async def save_figure_description(
        self, org: UUID, sha256: str, described: Described
    ) -> None: ...


@dataclass
class Outcome:
    # sha256 -> description, for the split.
    descriptions: dict[str, str] = field(default_factory=dict)
    # Distinct pictures of the version with neither a description nor a recorded error.
    missing: int = 0


@dataclass
class FigureStep:
    """One import slice's figure work for an organisation. Once the model is found unusable (no
    model chosen, a refused key), it stops calling it for the rest of the slice."""

    store: FigureStore
    settings: Settings
    org: UUID
    meter: Meter
    unusable: str | None = None
    described: int = 0
    _model: object | None = None
    _name: str = ""
    _secret: str | None = None
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def _ready(self) -> bool:
        async with self._lock:
            if self._model is not None or self.unusable:
                return self.unusable is None
            name = (
                await self.store.organization_model(self.org, PROCESS) or self.settings.figure_model
            ).strip()
            if name in ("", "scripted"):
                self.unusable = (
                    "no figure model: choose one in Admin under Figures and part pictures, "
                    "or set FIGURE_MODEL"
                )
                return False
            key, endpoint = await providers.credentials(self.store, self.org, name)
            credential = metering.Credential.for_model(
                name, key, endpoint.root() if endpoint else None
            )
            self._model = metering.metered(
                providers.build_model(name, key, endpoint), self.meter, PROCESS, name, credential
            )
            self._name, self._secret = name, key
            return True

    async def __call__(self, label: str, pdf: bytes, deadline: float) -> Outcome:
        """Descriptions for the pictures of one version (`label` names it for the model and the
        log), describing the missing ones until `deadline`."""
        found = await asyncio.to_thread(pdf_figures.figures, pdf)
        first: dict[str, Figure] = {}
        for figure in found:
            first.setdefault(figure.sha256, figure)
        known = await self.store.figure_descriptions(self.org, list(first)) if first else {}
        todo = [f for sha, f in first.items() if sha not in known]
        if todo and await self._ready():
            images = await asyncio.to_thread(pdf_figures.render, pdf, todo)

            async def describe(figure: Figure) -> bool:
                if self.unusable:
                    return False
                done = await self._describe(label, figure, images[figure.sha256])
                if done is not None:
                    known[figure.sha256] = done
                return self.unusable is None

            await each_until(
                todo, describe, limit=self.settings.figure_concurrency, deadline=deadline
            )
        return Outcome(
            descriptions={
                sha: d.description for sha, d in known.items() if d.description is not None
            },
            missing=sum(1 for sha in first if sha not in known),
        )

    async def _describe(self, label: str, figure: Figure, png: bytes) -> Described | None:
        what = f"A figure on page {figure.page} of {label}."
        try:
            result = await _agent.run(
                [what, BinaryContent(data=png, media_type="image/png")],
                model=self._model,  # pyright: ignore[reportArgumentType]
            )
        except Exception as exc:
            reason = providers.scrub(f"{type(exc).__name__}: {exc}", self._secret)[:300]
            if getattr(exc, "status_code", None) in _PICTURE_ERRORS:
                # This picture, not the key: kept, so it is not sent again on every import.
                described = Described(None, self._name, reason)
                await self.store.save_figure_description(self.org, figure.sha256, described)
                return described
            log.warning("Figures of %s stopped with %s: %s", label, self._name, reason)
            self.unusable = f"{self._name} failed: {reason}"
            return None
        text = " ".join(result.output.split())[:MAX_CHARS]
        described = Described(text, self._name)
        await self.store.save_figure_description(self.org, figure.sha256, described)
        self.described += 1
        return described
