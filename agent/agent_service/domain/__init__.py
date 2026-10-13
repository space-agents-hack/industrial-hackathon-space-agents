"""The domain: what this agent is for. To point the template at a new problem, change the files
in this folder (prompt.md, tools.py, systems.py, scripted.py) and nothing outside it."""

from pathlib import Path

from pydantic_ai import Agent, DeferredToolRequests
from pydantic_ai.models import Model

from agent_service.domain.scripted import scripted_model
from agent_service.domain.systems import Systems
from agent_service.domain.tools import Deps, toolset

__all__ = ["Deps", "agent", "new_deps", "resolve_model"]

# No model here: it is chosen per run from AGENT_MODEL, so switching provider is configuration.
# `DeferredToolRequests` in the output type is what lets a run end early to wait for approval.
agent = Agent(
    name="industrial-agent",
    deps_type=Deps,
    output_type=[str, DeferredToolRequests],
    instructions=(Path(__file__).parent / "prompt.md").read_text(),
    toolsets=[toolset],
)


def new_deps() -> Deps:
    return Deps(systems=Systems.from_fixture())


def resolve_model(name: str) -> Model | str:
    return scripted_model() if name == "scripted" else name
