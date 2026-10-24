"""The Supabase store against a real local stack: the same pause-and-resume cycle as
test_runner.py, but through the API gateway, the grants and the triggers of the actual schema.

This is the test that catches a migration the agent can no longer work with. It runs when
SUPABASE_URL and SUPABASE_SECRET_KEY point at a local stack (`make test-integration`).

Each test makes its own organisation, so nothing here reads or changes the stack's "Default" one
or the keys a developer may have connected to it.
"""

import os
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Any, cast
from uuid import UUID, uuid4

import pytest
from postgrest.exceptions import APIError
from supabase import AsyncClient, acreate_client

from agent_service import runner
from agent_service.records import CaseFileBlock, OrganizationSettings
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
    await close(client)


async def close(client: AsyncClient) -> None:
    await client.postgrest.aclose()
    await client.auth.close()


@pytest.fixture
async def store() -> AsyncIterator[SupabaseRunStore]:
    store = await SupabaseRunStore.connect(URL, KEY)
    yield store
    await store.aclose()


PASSWORD = "integration-test-password"


@pytest.fixture
async def user(db: AsyncClient) -> AsyncIterator[tuple[str, str]]:
    """(id, email) of a confirmed user whose password is PASSWORD."""
    email = f"it-{uuid4().hex[:12]}@example.test"
    created = await db.auth.admin.create_user(
        {"email": email, "password": PASSWORD, "email_confirm": True}
    )
    uid = created.user.id
    yield uid, email
    # Runs go with the user (on delete cascade); memberships too.
    await db.auth.admin.delete_user(uid)


@pytest.fixture
def user_id(user: tuple[str, str]) -> str:
    return user[0]


@pytest.fixture
async def org(db: AsyncClient, user_id: str) -> AsyncIterator[str]:
    """An organisation of its own with the user as its admin."""
    created = await db.table("organizations").insert({"name": f"it-{uuid4().hex[:8]}"}).execute()
    org_id = rows(created)[0]["id"]
    await (
        db.table("memberships")
        .insert({"organization_id": org_id, "user_id": user_id, "role": "admin"})
        .execute()
    )
    yield org_id
    await db.table("organizations").delete().eq("id", org_id).execute()


async def insert_run(db: AsyncClient, org: str, user_id: str, **fields: Any) -> UUID:
    row = {"task": "Triage ECN-1001.", "created_by": user_id, "organization_id": org, **fields}
    return UUID(rows(await db.table("runs").insert(row).execute())[0]["id"])


async def test_pause_and_resume_through_the_real_schema(
    db: AsyncClient, store: SupabaseRunStore, org: str, user_id: str, settings: Settings
) -> None:
    run_id = await insert_run(db, org, user_id)

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


async def test_a_run_reads_its_organisation(
    db: AsyncClient, store: SupabaseRunStore, org: str, user_id: str
) -> None:
    run_id = await insert_run(db, org, user_id)
    run = await store.get_run(run_id)
    assert run is not None
    assert str(run.organization_id) == org


async def test_organisation_settings_hold_only_what_was_changed(
    db: AsyncClient, store: SupabaseRunStore, org: str
) -> None:
    assert await store.organization_settings(UUID(org)) is None

    await (
        db.table("organization_settings")
        .insert({"organization_id": org, "max_model_requests": 7, "monthly_cost_cap_usd": 12.5})
        .execute()
    )

    assert await store.organization_settings(UUID(org)) == OrganizationSettings(
        model=None, max_model_requests=7, monthly_cost_cap_usd=12.5
    )


async def test_month_cost_sums_this_months_runs_of_this_organisation_only(
    db: AsyncClient, store: SupabaseRunStore, org: str, user_id: str
) -> None:
    month_start = datetime.now(UTC).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    await insert_run(db, org, user_id, usage={"cost_usd": 1.25})
    await insert_run(db, org, user_id, usage={"cost_usd": 0.5})
    # Unpriced model, and a run that has not recorded usage yet.
    await insert_run(db, org, user_id, usage={"cost_usd": None})
    await insert_run(db, org, user_id)
    # Last month.
    await insert_run(
        db,
        org,
        user_id,
        usage={"cost_usd": 100},
        created_at=(month_start - timedelta(seconds=1)).isoformat(),
    )
    other = rows(await db.table("organizations").insert({"name": "it-other"}).execute())[0]["id"]
    try:
        await insert_run(db, other, user_id, usage={"cost_usd": 1000})

        assert await store.month_cost(UUID(org)) == pytest.approx(1.75)
    finally:
        await db.table("organizations").delete().eq("id", other).execute()


async def test_a_run_past_the_organisations_cap_is_refused_through_the_real_schema(
    db: AsyncClient, store: SupabaseRunStore, org: str, user_id: str, settings: Settings
) -> None:
    await insert_run(db, org, user_id, usage={"cost_usd": 3})
    await (
        db.table("organization_settings")
        .insert({"organization_id": org, "monthly_cost_cap_usd": 2})
        .execute()
    )
    run_id = await insert_run(db, org, user_id)

    with pytest.raises(runner.CannotAdvance, match="monthly cap of"):
        await runner.prepare(store, settings, run_id)

    run = rows(await db.table("runs").select("*").eq("id", str(run_id)).execute())[0]
    assert run["status"] == "failed"
    assert run["error"].startswith("This organisation has reached its monthly cap of $2.00")
    assert run["model"] is None


async def test_a_key_stored_by_an_admin_is_readable_by_the_agent_only(
    db: AsyncClient, store: SupabaseRunStore, user: tuple[str, str], org: str
) -> None:
    # Signed in as the admin, the way the web stores a key. A client created with the secret key
    # but signed in sends the person's token, so the database sees the person, not the service
    # (my_access below proves it); the gateway only needs some valid key as `apikey`.
    _, email = user
    person = await acreate_client(URL, KEY)
    await person.auth.sign_in_with_password({"email": email, "password": PASSWORD})
    access = cast(dict[str, Any], (await person.rpc("my_access").execute()).data)
    assert [o["id"] for o in access["organizations"]] == [org]

    api_key = f"sk-it-{uuid4().hex}"
    try:
        await person.rpc(
            "set_provider_key", {"org": org, "key_provider": "openrouter", "api_key": api_key}
        ).execute()

        assert await store.provider_key(UUID(org), "openrouter") == api_key
        assert await store.provider_key(UUID(org), "anthropic") is None

        with pytest.raises(APIError) as denied:
            await person.rpc(
                "read_provider_key", {"org": org, "key_provider": "openrouter"}
            ).execute()
        assert denied.value.code == "42501"
    finally:
        # Deleting the organisation would leave the Vault secret behind; this removes both.
        await person.rpc(
            "delete_provider_key", {"org": org, "key_provider": "openrouter"}
        ).execute()
        await close(person)

    assert await store.provider_key(UUID(org), "openrouter") is None


async def test_users_are_created_once_and_passwords_set_through_real_auth(
    db: AsyncClient, store: SupabaseRunStore
) -> None:
    email = f"it-{uuid4().hex[:12]}@example.test"
    user_id, created = await store.create_user(email, "first-password-123")
    try:
        assert created is True

        again, created_again = await store.create_user(email.upper(), "other-password-456")
        assert (again, created_again) == (user_id, False)
        # The existing user kept their password.
        await _sign_in(email, "first-password-123")

        assert await store.set_password(user_id, "second-password-789") is True
        await _sign_in(email, "second-password-789")

        assert await store.set_password(uuid4(), "second-password-789") is False
    finally:
        await db.auth.admin.delete_user(str(user_id))


async def _sign_in(email: str, password: str) -> None:
    client = await acreate_client(URL, KEY)
    session = await client.auth.sign_in_with_password({"email": email, "password": password})
    assert session.user is not None
    await close(client)


async def test_certivity_reference_is_replaced_and_read_back(store: SupabaseRunStore) -> None:
    # The table is shared by the whole local stack: put back what a developer had loaded.
    before = await store.certivity_reference()
    rows_v1 = [
        {"kind": "index", "case_id": "", "content": [], "certivity_commit": "test-1"},
        {"kind": "expected", "case_id": "gone-case", "content": {}, "certivity_commit": "test-1"},
    ]
    rows_v2 = [
        {
            "kind": "index",
            "case_id": "",
            "content": [{"regulation": "UN R900"}],
            "certivity_commit": "test-2",
        },
    ]
    try:
        await store.replace_certivity_reference(rows_v1)
        await store.replace_certivity_reference(rows_v2)
        stored = await store.certivity_reference()
        assert [(r["kind"], r["case_id"], r["certivity_commit"]) for r in stored] == [
            ("index", "", "test-2")
        ]
        assert stored[0]["content"] == [{"regulation": "UN R900"}]
    finally:
        await store.replace_certivity_reference(before)


async def test_a_case_files_parse_status_and_blocks_through_the_real_schema(
    db: AsyncClient, store: SupabaseRunStore, org: str, user_id: str
) -> None:
    # Storage is not started in CI, so the rows are written as the agent would find them after
    # an upload; the policies on uploads are pgTAP's (supabase/tests/cases_test.sql).
    project = rows(
        await db.table("projects").insert({"organization_id": org, "name": "Rear lamp"}).execute()
    )[0]["id"]
    case = rows(
        await db.table("cases")
        .insert({"project_id": project, "organization_id": org, "name": "dev"})
        .execute()
    )[0]["id"]
    for position, name in [(1, "view.png"), (0, "spec.md")]:
        await (
            db.table("case_files")
            .insert(
                {
                    "case_id": case,
                    "organization_id": org,
                    "position": position,
                    "storage_path": f"{org}/{case}/{position + 1}-{name}",
                    "filename": name,
                    "format": name.rpartition(".")[2],
                    "bytes": 10,
                }
            )
            .execute()
        )

    spec, view = await store.case_files(UUID(case))
    assert (spec.filename, view.filename) == ("spec.md", "view.png")
    assert spec.status == "pending"

    assert await store.set_case_file(spec.id, "parsing", only_if="pending")
    # A second ingest request does not get the same file.
    assert not await store.set_case_file(spec.id, "parsing", only_if="pending")
    block = CaseFileBlock(file_id=spec.id, seq=0, kind="text", text="M1", parser="text")
    await store.replace_blocks(spec.id, UUID(org), [block])
    await store.replace_blocks(spec.id, UUID(org), [block])  # a re-parse replaces, not appends
    assert await store.set_case_file(spec.id, "parsed", only_if="parsing", notes=["ok"], pages=1)

    [stored] = await store.case_blocks(UUID(case))
    assert (stored.text, stored.parser) == ("M1", "text")
    [spec, _] = await store.case_files(UUID(case))
    assert (spec.status, spec.notes, spec.pages) == ("parsed", ["ok"], 1)

    run_id = await insert_run(db, org, user_id, case_id=case)
    run = await store.get_run(run_id)
    assert run is not None and run.case_id == UUID(case)


async def test_regulation_index_is_read_from_the_organisations_library(
    db: AsyncClient, store: SupabaseRunStore, org: str
) -> None:
    reg = rows(
        await db.table("regulations")
        .insert({"organization_id": org, "code": "UN R900", "slug": "UN_R900", "kind": "UN R"})
        .execute()
    )[0]["id"]
    for label, role in (("1.0.0", "base"), ("0.9.0", None)):
        await (
            db.table("regulation_versions")
            .insert(
                {
                    "regulation_id": reg,
                    "organization_id": org,
                    "version_label": label,
                    "role": role,
                    "file_name": f"r900-{label}.pdf",
                    "sha256": "0" * 64,
                    "size_bytes": 1,
                    "pdf_path": f"{org}/UN_R900/{label}/UN_R900_{label}.pdf",
                }
            )
            .execute()
        )

    index = await store.regulation_index(UUID(org))

    assert [e["regulation"] for e in index] == ["UN R900"]
    assert sorted((v["version_label"], v["role"]) for v in index[0]["versions"]) == [
        ("0.9.0", ""),
        ("1.0.0", "base"),
    ]
    assert await store.regulation_index(uuid4()) == []
