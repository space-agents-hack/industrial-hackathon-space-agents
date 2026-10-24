"""The domain: what this agent is for. Here, writing the requirements a case must meet, each
linked to the regulation paragraph it comes from (#4; docs/se SYS-25, SYS-28, SYS-29). The
runner (agent_service/runner.py) knows only `agent`, `prepare_deps` and `resolve_model`.

The files: prompt.md (the orchestrator), tools.py (its tools), writer.py with writer.md and
check.md (the two sub-agents and the code around them), scripted.py (a model for tests and demos
with no provider).
"""

import logging
from pathlib import Path

from pydantic_ai import Agent, DeferredToolRequests, ToolOutput
from pydantic_ai.models import Model

from agent_service.domain import case_ingest, certivity
from agent_service.domain.scripted import scripted_model
from agent_service.domain.tools import Deps, submit, toolset
from agent_service.records import Run
from agent_service.settings import Settings
from agent_service.store import RunStore

__all__ = ["Deps", "agent", "prepare_deps", "resolve_model"]

log = logging.getLogger(__name__)

# No model here: it is chosen per run from AGENT_MODEL, so switching provider is configuration.
# The run ends either with `submit` (the submission file, built by code from the stored rows; the
# model never types the JSON) or early, with `DeferredToolRequests`, to wait for an approval.
agent = Agent(
    name="requirements-orchestrator",
    deps_type=Deps,
    output_type=[ToolOutput(submit, name="submit"), DeferredToolRequests],
    instructions=(Path(__file__).parent / "prompt.md").read_text(),
    toolsets=[toolset],
)


async def prepare_deps(store: RunStore, run: Run, settings: Settings) -> Deps:
    """What a run's tools need from the database, read once when the request starts."""
    try:
        reference = await certivity.load_reference(store, run.organization_id)
    except Exception:
        # A run that cannot read the reference still runs: its checks say what was not checked.
        log.exception("could not read certivity_reference; checks run without it")
        reference = certivity.EMPTY
    check_model: Model | str | None = None
    check_secret: str | None = None
    if name := await store.organization_model(run.organization_id, "check"):
        # Imported here: providers imports this package (resolve_model).
        from agent_service import providers

        check_secret, endpoint = await providers.credentials(store, run.organization_id, name)
        check_model = providers.build_model(name, check_secret, endpoint)
    case_name, parts, chosen = "no-case", [], None
    if run.case_id is not None:
        # Never empty: a file without case_id is scored against nothing (Clemente, 18:22).
        case_name = (await store.case_name(run.case_id) or "").strip() or str(run.case_id)
        parts = (await case_ingest.case_content(store, run.case_id)).parts
        # The project's choice of regulations (SYS-32), read the way the search reads it.
        scope = await store.search_store().project_scope(run.case_id)
        if scope is not None and not scope.all_regulations:
            chosen = set(scope.version_ids)
    return Deps(
        store=store,
        run=run,
        case_name=case_name,
        case_parts=parts,
        settings=settings,
        check_model=check_model,
        check_secret=check_secret,
        chosen=chosen,
        reference=reference,
        concurrency=settings.writer_concurrency,
    )


def resolve_model(name: str) -> Model | str:
    return scripted_model() if name == "scripted" else name
