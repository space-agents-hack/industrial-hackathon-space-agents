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
    # The case the run is about (migration 20261024190000_cases), or None for a run started the
    # older way, with files attached to the run itself.
    case_id: UUID | None = None


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
    # As the browser computed it; the agent compares it with what it downloads.
    sha256: str | None = None


CaseFileStatus = Literal["pending", "parsing", "parsed", "failed"]


class CaseFile(BaseModel):
    """One file of a case (case_files). Parsed once into case_file_blocks."""

    id: UUID
    case_id: UUID
    organization_id: UUID
    position: int
    storage_path: str
    filename: str
    format: str
    bytes: int
    sha256: str | None = None
    status: CaseFileStatus
    notes: list[str] = []
    error: str | None = None
    pages: int | None = None


class CaseFileBlock(BaseModel):
    """A row of case_file_blocks: the standard shape of parsed content."""

    file_id: UUID
    seq: int
    kind: Literal["text", "image"]
    page: int | None = None
    label: str = ""
    text: str | None = None
    image_path: str | None = None
    media_type: str | None = None
    parser: str
