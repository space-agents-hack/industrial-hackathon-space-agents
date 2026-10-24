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
    "case_file",
]


class Run(BaseModel):
    id: UUID
    organization_id: UUID
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


class OrganizationSettings(BaseModel):
    """What one organisation changed. None means "use the service's default" (settings.py)."""

    model: str | None = None
    max_model_requests: int | None = None
    monthly_cost_cap_usd: float | None = None


class RunFile(BaseModel):
    """One uploaded case file (run_files). The bytes are in Storage, at `storage_path`."""

    id: UUID
    storage_path: str
    filename: str
    format: str
    bytes: int
