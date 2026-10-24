"""The tools the model can call. Thin on purpose: the logic lives in `systems.py`, where it is
tested without a model. A tool's docstring is what the model reads to decide when to call it.

`requires_approval=True` is the human-in-the-loop switch: the run stops before that tool executes
and waits for a person to approve or deny it in the web UI. Put it on anything that writes to a
system of record. It is a pause, not a permission check: it does not verify WHO approved.
"""

from dataclasses import dataclass
from typing import Any, Literal

from pydantic_ai import FunctionToolset, ModelRetry, RunContext

from agent_service.domain import certivity
from agent_service.domain.systems import Systems, UnknownRecord


@dataclass
class Deps:
    systems: Systems


toolset = FunctionToolset[Deps]()


@toolset.tool
def plm_get_ecn(ctx: RunContext[Deps], ecn_id: str) -> dict[str, Any]:
    """Read an engineering change notice from the PLM system.

    Args:
        ecn_id: The notice id, for example "ECN-1001".
    """
    try:
        return ctx.deps.systems.get_ecn(ecn_id)
    except UnknownRecord as exc:
        raise ModelRetry(str(exc)) from exc


@toolset.tool
def plm_affected_assemblies(ctx: RunContext[Deps], part_id: str) -> list[dict[str, Any]]:
    """List every assembly that uses a part.

    Args:
        part_id: The part id, for example "BR-204".
    """
    try:
        return ctx.deps.systems.affected_assemblies(part_id)
    except UnknownRecord as exc:
        raise ModelRetry(str(exc)) from exc


@toolset.tool
def cad_check_fit(
    ctx: RunContext[Deps], assembly_id: str, part_id: str, new_value_mm: float
) -> dict[str, Any]:
    """Check whether a part still fits in one assembly at its new dimension.

    Args:
        assembly_id: The assembly to check, for example "ASM-310".
        part_id: The part being changed.
        new_value_mm: The new value of the changed dimension, in millimetres.
    """
    try:
        return ctx.deps.systems.check_fit(assembly_id, part_id, new_value_mm)
    except UnknownRecord as exc:
        raise ModelRetry(str(exc)) from exc


@toolset.tool
def erp_open_orders(ctx: RunContext[Deps], part_id: str) -> list[dict[str, Any]]:
    """List open customer orders that contain a part.

    Args:
        part_id: The part id.
    """
    try:
        return ctx.deps.systems.open_orders(part_id)
    except UnknownRecord as exc:
        raise ModelRetry(str(exc)) from exc


@toolset.tool
def certivity_check(ctx: RunContext[Deps], submission_json: str) -> dict[str, Any]:
    """Check a Certivity submission file the way the submission platform does, before giving it
    as your answer. Returns `valid`, and every problem with its JSON path and how to fix it. Fix
    every problem and check again; give your answer only when it is valid.

    Args:
        submission_json: The whole submission, as JSON text.
    """
    # No score here on purpose (certivity.check): it would let the model tune to the worked example.
    return certivity.check(submission_json, with_score=False)


@toolset.tool(requires_approval=True)
def plm_set_ecn_status(
    ctx: RunContext[Deps],
    ecn_id: str,
    status: Literal["open", "hold", "released", "rejected"],
    reason: str,
) -> dict[str, Any]:
    """Change the status of an engineering change notice. A person must approve this call.

    Args:
        ecn_id: The notice id.
        status: The new status.
        reason: One sentence a reviewer can check, with the ids and numbers it rests on.
    """
    try:
        return {**ctx.deps.systems.set_ecn_status(ecn_id, status), "reason": reason}
    except UnknownRecord as exc:
        raise ModelRetry(str(exc)) from exc
