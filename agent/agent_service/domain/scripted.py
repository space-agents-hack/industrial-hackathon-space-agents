"""A model that is not a model: a fixed policy for the example task, with no provider and no
network. `AGENT_MODEL=scripted` selects it.

Why it exists: the whole loop (tools, the approval pause, the resume) can run in tests, on a fresh
clone with no API key, and on stage if the network goes down. It reads the same tool results a
real model would and decides from them, so it follows the collision and no-collision paths
honestly. Replace or delete it when the domain changes.
"""

import json
import re
from collections.abc import AsyncIterator
from typing import Any

from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.models.function import AgentInfo, DeltaToolCall, DeltaToolCalls, FunctionModel

Call = tuple[str, dict[str, Any]]


def _next_step(messages: list[ModelMessage]) -> tuple[str, list[Call]]:
    """What a careful engineer would do next, given the tool results so far."""
    prompt = ""
    # Typed as Any: the library types a tool result as "anything a tool may return", and here we
    # know they are the dicts and lists from systems.py.
    returns: dict[str, list[Any]] = {}
    denied: dict[str, bool] = {}
    for message in messages:
        if not isinstance(message, ModelRequest):
            continue
        for part in message.parts:
            if isinstance(part, UserPromptPart) and isinstance(part.content, str):
                prompt = part.content
            elif isinstance(part, ToolReturnPart):
                returns.setdefault(part.tool_name, []).append(part.content)
                denied[part.tool_name] = part.outcome == "denied"

    ecn_returns = returns.get("plm_get_ecn")
    if not ecn_returns:
        match = re.search(r"ECN-\d+", prompt)
        ecn_id = match.group(0) if match else "ECN-1001"
        return f"Reading {ecn_id}.", [("plm_get_ecn", {"ecn_id": ecn_id})]

    ecn = ecn_returns[0]
    ecn_id, part_id, new_value = ecn["ecn_id"], ecn["part_id"], ecn["to_mm"]

    if "plm_affected_assemblies" not in returns:
        return f"{ecn_id} changes {part_id}. Looking up where it is used and what is on order.", [
            ("plm_affected_assemblies", {"part_id": part_id}),
            ("erp_open_orders", {"part_id": part_id}),
        ]

    assemblies = returns["plm_affected_assemblies"][0]
    fits = returns.get("cad_check_fit", [])
    if len(fits) < len(assemblies):
        return "Checking the fit in each assembly.", [
            (
                "cad_check_fit",
                {"assembly_id": a["assembly_id"], "part_id": part_id, "new_value_mm": new_value},
            )
            for a in assemblies
        ]

    orders = returns["erp_open_orders"][0]
    collisions = [f for f in fits if not f["fits"]]
    lines = [f"{ecn_id}: {ecn['title']}."]
    for f in fits:
        verdict = "fits" if f["fits"] else "DOES NOT FIT"
        lines.append(
            f"- {f['assembly_id']}: {verdict}, {f['remaining_clearance_mm']} mm left "
            f"(minimum {f['min_clearance_mm']} mm)."
        )
    at_risk = [o for o in orders if o["assembly_id"] in {c["assembly_id"] for c in collisions}]
    for o in orders:
        flag = " (uses a colliding assembly)" if o in at_risk else ""
        lines.append(f"- Order {o['order_id']}: {o['qty']} units due {o['due']}{flag}.")

    if not collisions:
        lines.append("Every assembly fits. I did not change the status of the notice.")
        return "\n".join(lines), []

    status_returns = returns.get("plm_set_ecn_status")
    if not status_returns:
        worst = min(collisions, key=lambda c: c["remaining_clearance_mm"])
        reason = (
            f"{worst['assembly_id']} is left with {worst['remaining_clearance_mm']} mm at "
            f"{new_value} mm; the minimum is {worst['min_clearance_mm']} mm."
        )
        return "At least one assembly collides. Requesting a hold.", [
            ("plm_set_ecn_status", {"ecn_id": ecn_id, "status": "hold", "reason": reason})
        ]

    if denied["plm_set_ecn_status"]:
        lines.append(
            f"The hold was denied by the reviewer ({status_returns[0]}). "
            f"{ecn_id} is unchanged. Left to decide: how to handle the colliding assemblies."
        )
    else:
        lines.append(
            f"{ecn_id} is now on hold. Left to decide: redesign the colliding assemblies or "
            "reject the change."
        )
    return "\n".join(lines), []


async def _stream(
    messages: list[ModelMessage], _info: AgentInfo
) -> AsyncIterator[str | DeltaToolCalls]:
    text, calls = _next_step(messages)
    yield text
    for index, (name, args) in enumerate(calls):
        yield {index: DeltaToolCall(name=name, json_args=json.dumps(args))}


def _respond(messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
    text, calls = _next_step(messages)
    return ModelResponse(
        parts=[TextPart(text), *(ToolCallPart(name, args) for name, args in calls)]
    )


def scripted_model() -> FunctionModel:
    # Both forms: the service streams (to record events as they happen), the evals do not.
    return FunctionModel(_respond, stream_function=_stream, model_name="scripted")
