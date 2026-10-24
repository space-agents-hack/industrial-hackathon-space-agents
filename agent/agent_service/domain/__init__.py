"""The domain: what this agent is for. To point the template at a new problem, change the files
in this folder (prompt.md, tools.py, systems.py, scripted.py) and nothing outside it."""

import logging
from pathlib import Path
from typing import Any, Protocol

from pydantic_ai import Agent, DeferredToolRequests
from pydantic_ai.models import Model

from agent_service.domain import certivity
from agent_service.domain.scripted import scripted_model
from agent_service.domain.systems import Systems
from agent_service.domain.tools import Deps, toolset

__all__ = ["Deps", "agent", "new_deps", "prepare_deps", "resolve_model"]

log = logging.getLogger(__name__)

# No model here: it is chosen per run from AGENT_MODEL, so switching provider is configuration.
# `DeferredToolRequests` in the output type is what lets a run end early to wait for approval.
agent = Agent(
    name="industrial-agent",
    deps_type=Deps,
    output_type=[str, DeferredToolRequests],
    instructions=(Path(__file__).parent / "prompt.md").read_text(),
    toolsets=[toolset],
)


def new_deps(reference: certivity.Reference = certivity.EMPTY) -> Deps:
    return Deps(systems=Systems.from_fixture(), reference=reference)


class _Store(Protocol):
    async def certivity_reference(self) -> list[dict[str, Any]]: ...


async def prepare_deps(store: _Store) -> Deps:
    """What a run's tools need from the database, read once when the run starts."""
    try:
        reference = await certivity.load_reference(store)
    except Exception:
        # A run that cannot read the reference still runs: its checks say what was not checked.
        log.exception("could not read certivity_reference; checks run without it")
        reference = certivity.EMPTY
    return new_deps(reference)


def resolve_model(name: str) -> Model | str:
    return scripted_model() if name == "scripted" else name
