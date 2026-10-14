"""HTTP surface: a health check, the operation "advance this run", and the few things the web's
admin pages need a secret for (creating users, checking keys, listing models).

The admin endpoints trust the web to have checked the person's role in the database first: this
service sees the shared secret, not who is behind it. That is why each one does one narrow thing
and none of them reads or returns anything about other users or organisations.

The run executes INSIDE the request. The response is a stream so that the caller gets an answer
at once (accepted, or a 4xx with the reason) and the connection carries a heartbeat while the
agent works. Nothing the UI needs travels in the body; it reads the database.
"""

import asyncio
import hmac
import json
import logging
import os
import re
from collections.abc import AsyncIterator
from typing import Annotated
from uuid import UUID, uuid4

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel
from supabase_auth.errors import AuthApiError

from agent_service import providers, runner
from agent_service.providers import Provider
from agent_service.settings import Settings, get_settings
from agent_service.store import RunStore, SupabaseRunStore

log = logging.getLogger(__name__)

app = FastAPI(title="Agent service", docs_url=None, redoc_url=None, openapi_url=None)


# FastAPI's default 422 repeats the rejected input back, which here can be a password or an API
# key. Location and reason are enough to fix the request.
@app.exception_handler(RequestValidationError)
async def _validation_error(_request: Request, exc: RequestValidationError) -> JSONResponse:
    detail = [{key: e.get(key) for key in ("loc", "msg", "type")} for e in exc.errors()]
    return JSONResponse({"detail": detail}, status_code=422)


async def get_store(settings: Annotated[Settings, Depends(get_settings)]) -> RunStore:
    if not settings.supabase_url or not settings.supabase_secret_key:
        raise HTTPException(503, "SUPABASE_URL and SUPABASE_SECRET_KEY are not configured.")
    # One client per request: a function instance may be reused across event loops, and a client
    # kept from a previous one fails in ways that only show up in production.
    return await SupabaseRunStore.connect(settings.supabase_url, settings.supabase_secret_key)


async def get_http() -> AsyncIterator[httpx.AsyncClient]:
    # Replaced in tests by a client on httpx.MockTransport: no test reaches a provider.
    async with httpx.AsyncClient(timeout=providers.TIMEOUT_S) as client:
        yield client


def require_secret(
    settings: Annotated[Settings, Depends(get_settings)],
    authorization: Annotated[str | None, Header()] = None,
) -> None:
    if not settings.agent_shared_secret:
        raise HTTPException(503, "AGENT_SHARED_SECRET is not configured.")
    expected = f"Bearer {settings.agent_shared_secret}"
    if authorization is None or not hmac.compare_digest(authorization.encode(), expected.encode()):
        raise HTTPException(401, "Missing or wrong bearer token.")


@app.get("/health")
def health(settings: Annotated[Settings, Depends(get_settings)]) -> dict[str, str]:
    return {
        "status": "ok",
        "model": settings.agent_model,
        "version": os.environ.get("VERCEL_GIT_COMMIT_SHA", "unknown"),
    }


# /health says the function starts. /ready says it can do its job: the caller holds the shared
# secret (so the web's AGENT_SHARED_SECRET matches) and the database answers with this service's
# key. Smoke tests and the watchdog call it through the web, so one request checks the whole chain.
@app.get("/ready", dependencies=[Depends(require_secret)])
async def ready(
    settings: Annotated[Settings, Depends(get_settings)],
    store: Annotated[RunStore, Depends(get_store)],
) -> dict[str, str]:
    try:
        await store.get_run(uuid4())
    except Exception as exc:
        raise HTTPException(503, f"The database did not answer: {type(exc).__name__}.") from None
    finally:
        await store.aclose()
    return {"status": "ok", "database": "ok", "model": settings.agent_model}


# The secret is checked before the store is built, so an unauthenticated caller learns nothing
# about whether the database is configured.
@app.post("/runs/{run_id}/advance", dependencies=[Depends(require_secret)])
async def advance(
    run_id: UUID,
    settings: Annotated[Settings, Depends(get_settings)],
    store: Annotated[RunStore, Depends(get_store)],
) -> StreamingResponse:
    try:
        plan = await runner.prepare(store, settings, run_id)
    except runner.RunNotFound:
        await store.aclose()
        raise HTTPException(404, "No such run.") from None
    except runner.CannotAdvance as exc:
        await store.aclose()
        raise HTTPException(409, str(exc)) from None

    async def body() -> AsyncIterator[str]:
        yield _line(event="accepted", run_id=str(run_id))
        task = asyncio.create_task(runner.execute(store, settings, plan))
        try:
            while True:
                done, _ = await asyncio.wait({task}, timeout=settings.heartbeat_s)
                if done:
                    break
                # Keeps idle connections open; the run's own heartbeat is in runner.execute.
                yield _line(event="heartbeat")
            yield _line(event="done", status=task.result())
        finally:
            # If the caller hangs up, let the run finish: its results go to the database, not
            # to this response.
            if not task.done():
                await asyncio.shield(task)
            await store.aclose()

    return StreamingResponse(body(), media_type="application/x-ndjson")


def _line(**fields: str) -> str:
    return json.dumps(fields) + "\n"


# ------------------------------------------------------------------------------------------
# Admin: people. The web calls these after checking the person's role (and, for a password,
# the database function can_reset_password).
# ------------------------------------------------------------------------------------------

# Shape only. Whether the address exists is the invitation's problem, not this check's.
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
MIN_PASSWORD = 12
# bcrypt, which Supabase Auth uses, reads only the first 72 bytes; Auth answers a longer password
# with a 500 instead of an explanation, so it is refused here with one.
MAX_PASSWORD_BYTES = 72


class NewUser(BaseModel):
    email: str
    password: str


class NewPassword(BaseModel):
    user_id: UUID
    password: str


def _check_password(password: str) -> None:
    if len(password) < MIN_PASSWORD:
        raise HTTPException(422, f"The password must have at least {MIN_PASSWORD} characters.")
    if len(password.encode()) > MAX_PASSWORD_BYTES:
        raise HTTPException(422, f"The password must fit in {MAX_PASSWORD_BYTES} bytes.")


def _auth_failure(exc: AuthApiError) -> HTTPException:
    # Auth's own validation (a weak-password policy set in the project, for example) is the
    # caller's to fix; anything else is this side's.
    if exc.status == 422 or exc.code == "weak_password":
        return HTTPException(422, exc.message)
    log.error("Supabase Auth answered %s %s: %s", exc.status, exc.code, exc.message)
    return HTTPException(502, "Supabase Auth refused the change.")


@app.post("/admin/users", dependencies=[Depends(require_secret)])
async def create_user(
    body: NewUser, store: Annotated[RunStore, Depends(get_store)]
) -> dict[str, str | bool]:
    try:
        email = body.email.strip().lower()
        if not _EMAIL.match(email):
            raise HTTPException(422, "That is not an email address.")
        _check_password(body.password)
        user_id, created = await store.create_user(email, body.password)
    except AuthApiError as exc:
        raise _auth_failure(exc) from None
    finally:
        await store.aclose()
    return {"user_id": str(user_id), "created": created}


@app.post("/admin/users/password", dependencies=[Depends(require_secret)])
async def set_password(
    body: NewPassword, store: Annotated[RunStore, Depends(get_store)]
) -> dict[str, bool]:
    try:
        _check_password(body.password)
        if not await store.set_password(body.user_id, body.password):
            raise HTTPException(404, "No such user.")
    except AuthApiError as exc:
        raise _auth_failure(exc) from None
    finally:
        await store.aclose()
    return {"ok": True}


# ------------------------------------------------------------------------------------------
# Providers: test a key before it is saved, and list the models an organisation can choose.
# ------------------------------------------------------------------------------------------


class KeyToCheck(BaseModel):
    provider: Provider
    api_key: str


@app.post("/providers/check", dependencies=[Depends(require_secret)])
async def check_provider_key(
    body: KeyToCheck, http: Annotated[httpx.AsyncClient, Depends(get_http)]
) -> dict[str, str | bool]:
    if not body.api_key.strip():
        raise HTTPException(422, "The key is empty.")
    check = await providers.check_key(http, body.provider, body.api_key)
    return {"ok": check.ok, "detail": check.detail}


@app.get("/providers/models", dependencies=[Depends(require_secret)])
async def list_provider_models(
    organization_id: UUID,
    provider: Provider,
    store: Annotated[RunStore, Depends(get_store)],
    http: Annotated[httpx.AsyncClient, Depends(get_http)],
) -> dict[str, list[dict[str, str | float | None]]]:
    try:
        if provider == "openrouter":
            options = await providers.openrouter_catalogue(http)
        else:
            key = await store.provider_key(organization_id, provider)
            if key is None:
                raise HTTPException(409, f"No {provider} key is connected for this organisation.")
            options = await providers.list_models(http, provider, key)
    except providers.KeyRejected:
        raise HTTPException(
            502, f"{provider} rejected the stored key. Replace it in Admin, Providers."
        ) from None
    except providers.ProviderError as exc:
        raise HTTPException(502, str(exc)) from None
    finally:
        await store.aclose()
    return {"models": [vars(o) for o in options]}
