"""The Supabase store against a real local stack: the same pause-and-resume cycle as
test_runner.py, but through the API gateway, the grants and the triggers of the actual schema.

This is the test that catches a migration the agent can no longer work with. It runs when
SUPABASE_URL and SUPABASE_SECRET_KEY point at a local stack (`make test-integration`).
"""

import os
from collections.abc import AsyncIterator
from typing import Any, cast
from uuid import UUID, uuid4

import pytest
from supabase import AsyncClient, acreate_client

from agent_service import runner
from agent_service.settings import Settings
from agent_service.store import SupabaseRunStore

URL = os.environ.get("SUPABASE_URL", "")
KEY = os.environ.get("SUPABASE_SECRET_KEY", "")

pytestmark = [
    pytest.mark.anyio,
    pytest.mark.integration,
    pytest.mark.skipif(not (URL and KEY), reason="no local Supabase stack configured"),
    # A guard, not a convenience: this test creates and deletes users with the secret key.
    pytest.mark.skipif(
        bool(URL) and "127.0.0.1" not in URL and "localhost" not in URL,
        reason="refusing to run against a non-local Supabase project",
    ),
]


def rows(response: Any) -> list[dict[str, Any]]:
    # The client types rows as "any JSON value"; in these queries they are always objects.
    return cast(list[dict[str, Any]], response.data)


@pytest.fixture
async def db() -> AsyncIterator[AsyncClient]:
    client = await acreate_client(URL, KEY)
    yield client
    await client.postgrest.aclose()


@pytest.fixture
async def user_id(db: AsyncClient) -> AsyncIterator[str]:
    created = await db.auth.admin.create_user(
        {"email": f"it-{uuid4().hex[:12]}@example.test", "email_confirm": True}
    )
    uid = created.user.id
    yield uid
    await db.table("runs").delete().eq("created_by", uid).execute()
    await db.auth.admin.delete_user(uid)


async def test_pause_and_resume_through_the_real_schema(
    db: AsyncClient, user_id: str, settings: Settings
) -> None:
    inserted = (
        await db.table("runs").insert({"task": "Triage ECN-1001.", "created_by": user_id}).execute()
    )
    run_id = UUID(rows(inserted)[0]["id"])
    store = await SupabaseRunStore.connect(URL, KEY)

    plan = await runner.prepare(store, settings, run_id)
    assert await runner.execute(store, settings, plan) == "awaiting_approval"

    # A second request cannot take a run that is waiting for a person.
    with pytest.raises(runner.CannotAdvance):
        await runner.prepare(store, settings, run_id)

    [approval] = await store.list_approvals(run_id)
    assert approval.status == "pending"
    assert approval.tool_name == "plm_set_ecn_status"
    assert await store.load_conversation(run_id) is not None

    await (
        db.table("approvals")
        .update({"status": "approved", "decided_by": user_id})
        .eq("id", str(approval.id))
        .execute()
    )

    plan = await runner.prepare(store, settings, run_id)
    assert await runner.execute(store, settings, plan) == "succeeded"

    run = rows(await db.table("runs").select("*").eq("id", str(run_id)).execute())[0]
    assert run["status"] == "succeeded"
    assert "now on hold" in run["output"]
    assert run["model"] == "scripted"
    assert run["usage"]["requests"] == 5

    events = rows(
        await db.table("run_events").select("kind").eq("run_id", str(run_id)).order("id").execute()
    )
    kinds = [e["kind"] for e in events]
    assert kinds[0] == "status"
    assert kinds[-1] == "status"
    assert kinds.count("approval_requested") == 1
    assert kinds.count("approval_resolved") == 1
    await store.aclose()
