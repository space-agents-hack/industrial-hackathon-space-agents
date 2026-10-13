"""Rows of the shared schema (supabase/migrations) as the agent sees them."""

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel

RunStatus = Literal["queued", "running", "awaiting_approval", "succeeded", "failed"]
ApprovalStatus = Literal["pending", "approved", "denied"]
EventKind = Literal[
    "status",
    "text",
    "tool_call",
    "tool_result",
    "approval_requested",
    "approval_resolved",
    "error",
]


class Run(BaseModel):
    id: UUID
    task: str
    status: RunStatus
    updated_at: datetime


class ApprovalRequest(BaseModel):
    tool_call_id: str
    tool_name: str
    args: dict[str, Any]


class Approval(ApprovalRequest):
    id: UUID
    run_id: UUID
    status: ApprovalStatus
    note: str | None = None
