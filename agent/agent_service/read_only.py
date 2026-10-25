"""Read-only organisations (SYS-47, migration 20261025050000): explored, never changed, and never
the reason for a model or embedding call. The database already refuses their members' writes;
this is the agent's half, because the agent writes with the secret key, past RLS, and is where
model calls are made. Checked where work starts (a run, a question, a case's parsing, an import,
indexing), not at each call: refusing half-way would leave the work half-done."""

from typing import Any, cast
from uuid import UUID

from supabase import AsyncClient

REFUSAL = (
    "This organisation is read-only: it can be explored, but nothing in it is changed and no "
    "model is called for it."
)


async def is_read_only(db: AsyncClient, org: UUID) -> bool:
    res = await db.table("organizations").select("read_only").eq("id", str(org)).limit(1).execute()
    rows = cast(list[dict[str, Any]], res.data)
    return bool(rows and rows[0].get("read_only"))
