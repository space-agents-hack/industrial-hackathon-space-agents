"""The domain: what this agent is for. Here, writing the requirements a case must meet, each
linked to the regulation paragraph it comes from (#4; docs/se SYS-25, SYS-28, SYS-29). The
runner (agent_service/runner.py) knows only `agent`, `prepare_deps` and `resolve_model`.

The files: prompt.md (the orchestrator), tools.py (its tools), writer.py with writer.md and
check.md (the two sub-agents and the code around them), scripted.py (a model for tests and demos
with no provider).
"""

import logging
from pathlib import Path
from typing import Any

from pydantic_ai import Agent, DeferredToolRequests, ToolOutput
from pydantic_ai.models import Model

from agent_service.domain import case_ingest, certivity, writer
from agent_service.domain.scripted import scripted_model
from agent_service.domain.tools import Deps, submit, toolset
from agent_service.metering import Credential, Meter, metered
from agent_service.records import Run
from agent_service.settings import Settings
from agent_service.store import RunStore

__all__ = [
    "Deps",
    "agent",
    "prepare_deps",
    "resolve_model",
    "stored_submission",
    "submission_ids",
]

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


async def prepare_deps(
    store: RunStore, run: Run, settings: Settings, meter: Meter | None = None
) -> Deps:
    """What a run's tools need from the database, read once when the request starts. `meter` is
    the run's: the check model and the search vectors are billed to it."""
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
        check_model = metered(
            providers.build_model(name, check_secret, endpoint),
            meter,
            "check",
            name,
            Credential.for_model(name, check_secret, endpoint.root() if endpoint else None),
        )
    team_id, case_name = await submission_ids(store, run)
    parts, chosen = [], None
    if run.case_id is not None:
        parts = (await case_ingest.case_content(store, run.case_id)).parts
        # The project's choice of regulations (SYS-32), read the way the search reads it.
        scope = await store.search_store().project_scope(run.case_id)
        if scope is not None and not scope.all_regulations:
            chosen = set(scope.version_ids)
    return Deps(
        store=store,
        run=run,
        case_name=case_name,
        team_id=team_id,
        case_parts=parts,
        settings=settings,
        check_model=check_model,
        check_secret=check_secret,
        chosen=chosen,
        reference=reference,
        concurrency=settings.writer_concurrency,
        meter=meter,
    )


async def submission_ids(store: RunStore, run: Run) -> tuple[str, str]:
    """`team_id` and `case_id` of the run's submission: the organisation's name and the case's.

    One place for both, so the file `submit` writes and the one built from the stored rows of an
    unfinished run (`stored_submission`) name the same team and case.
    """
    # Never empty: the organisation's name, else its id, which the run summary flags.
    team_id = (await store.organization_name(run.organization_id) or "").strip()
    team_id = team_id or str(run.organization_id)
    case_name = "no-case"
    if run.case_id is not None:
        # Never empty: a file without case_id is scored against nothing (Clemente, 18:22).
        case_name = (await store.case_name(run.case_id) or "").strip() or str(run.case_id)
    return team_id, case_name


async def stored_submission(store: RunStore, run: Run) -> dict[str, Any]:
    """The submission as the run's stored requirements make it now, built the way `submit` builds
    it (rejected rows left out, drafts kept).

    For a run that never reached `submit`: one that ran out of time, hit a limit, failed, or waits
    on an approval. Its requirements are stored the moment each window is written (#36), and
    without this the app had no way to hand them over for upload.
    """
    team_id, case_name = await submission_ids(store, run)
    return writer.submission(team_id, case_name, await store.run_requirements(run.id))


def resolve_model(name: str) -> Model | str:
    return scripted_model() if name == "scripted" else name
