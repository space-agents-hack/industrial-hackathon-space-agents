"""HTTP surface: a health check and one operation, "advance this run".

The run executes INSIDE the request. The response is a stream so that the caller gets an answer
at once (accepted, or a 4xx with the reason) and the connection carries a heartbeat while the
agent works. Nothing the UI needs travels in the body; it reads the database.
"""

import asyncio
import hmac
import json
import os
from collections.abc import AsyncIterator
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import StreamingResponse

from agent_service import runner
from agent_service.settings import Settings, get_settings
from agent_service.store import RunStore, SupabaseRunStore

app = FastAPI(title="Agent service", docs_url=None, redoc_url=None, openapi_url=None)


async def get_store(settings: Annotated[Settings, Depends(get_settings)]) -> RunStore:
    if not settings.supabase_url or not settings.supabase_secret_key:
        raise HTTPException(503, "SUPABASE_URL and SUPABASE_SECRET_KEY are not configured.")
    # One client per request: a function instance may be reused across event loops, and a client
    # kept from a previous one fails in ways that only show up in production.
    return await SupabaseRunStore.connect(settings.supabase_url, settings.supabase_secret_key)


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
