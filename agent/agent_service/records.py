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
    # Another writer model a member asked for, for this run only (migration
    # 20261024220000_hierarchy_edits, SYS-33). None uses the organisation's.
    requested_model: str | None = None


class RunOutcome(BaseModel):
    """What a run produced, as the run page shows it: the model it ran with (set when it was
    claimed), the output when it succeeded and the error when it failed."""

    model: str | None = None
    output: str | None = None
    error: str | None = None


class RunEvent(BaseModel):
    """A row of run_events: the trace, in the order it was written."""

    kind: str
    payload: dict[str, Any] = {}


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


class LibraryVersion(BaseModel):
    """One version of a regulation in the organisation's library (regulation_versions), with the
    regulation's code exactly as the index wrote it ("UN R148"): what a submission cites."""

    id: UUID
    regulation: str
    title: str | None = None
    version_label: str
    role: str | None = None
    page_count: int | None = None
    paragraph_count: int | None = None
    # What the version says it applies to, written once per version by the indexer
    # (domain/regulation_search.py). None until the library was indexed.
    scope_summary: str | None = None


class Paragraph(BaseModel):
    """A row of regulation_paragraphs, in document order (`position`)."""

    id: UUID
    version_id: UUID
    position: int
    label: str | None = None
    heading: str = ""
    kind: Literal["paragraph", "text"]
    text: str
    page_start: int
    page_end: int
    content_hash: str


RequirementStatus = Literal["draft", "approved", "rejected"]


class NewRequirement(BaseModel):
    """What the writer adds (requirements). The citation fields are copied from the paragraph by
    code (domain/writer.py `cite`), never written by a model."""

    case_id: UUID
    organization_id: UUID
    run_id: UUID
    ext_id: str
    text: str
    test_case: str | None = None
    version_id: UUID
    paragraph_id: UUID
    paragraph_hash: str
    regulation: str
    version_label: str
    page: int
    paragraph: str | None = None


class Requirement(NewRequirement):
    id: UUID
    # Null only for a paragraph deleted before 20261024270000_superseded_paragraphs. Since then a
    # re-extraction with different text keeps the link on the superseded row, which
    # version_paragraphs does not return.
    version_id: UUID | None = None  # pyright: ignore[reportIncompatibleVariableOverride]
    paragraph_id: UUID | None = None  # pyright: ignore[reportIncompatibleVariableOverride]
    # When a re-extraction superseded the cited paragraph and brought no paragraph back with the
    # same label and text (20261024280000_purge_superseded_paragraphs). None while it is current.
    paragraph_superseded_at: datetime | None = None
    status: RequirementStatus = "draft"
    findings: list[dict[str, Any]] = []
