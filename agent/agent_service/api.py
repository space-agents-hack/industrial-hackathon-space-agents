"""HTTP surface: a health check, the operations "advance this run" and "advance this regulation
import", and the few things the web's admin pages need a secret for (creating users, checking
keys, listing models).

The admin endpoints trust the web to have checked the person's role in the database first: this
service sees the shared secret, not who is behind it. That is why each one does one narrow thing
and none of them reads or returns anything about other users or organisations.

The run executes INSIDE the request. The response is a stream so that the caller gets an answer
at once (accepted, or a 4xx with the reason) and the connection carries a heartbeat while the
agent works. Nothing the UI needs travels in the body; it reads the database.
"""

import asyncio
import hashlib
import hmac
import json
import logging
import re
from collections.abc import AsyncIterator, Callable
from datetime import UTC, datetime
from typing import Annotated, Any, Literal
from uuid import UUID, uuid4

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field
from supabase_auth.errors import AuthApiError

from agent_service import domain, metering, providers, read_only, runner, storage_copies
from agent_service.domain import (
    assistant,
    case_ingest,
    certivity,
    figures,
    paragraphs,
    regulation_search,
    regulations,
    subgoal,
)
from agent_service.domain.library_store import SupabaseLibraryStore
from agent_service.domain.project_store import SupabaseProjectStore
from agent_service.domain.regulation_search import SearchStore
from agent_service.domain.regulations import LibraryStore
from agent_service.domain.search_store import SupabaseSearchStore
from agent_service.providers import AuthScheme, Provider
from agent_service.records import Run
from agent_service.settings import Settings, agent_version, effective, get_settings
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


async def get_library(settings: Annotated[Settings, Depends(get_settings)]) -> LibraryStore:
    if not settings.supabase_url or not settings.supabase_secret_key:
        raise HTTPException(503, "SUPABASE_URL and SUPABASE_SECRET_KEY are not configured.")
    return await SupabaseLibraryStore.connect(settings.supabase_url, settings.supabase_secret_key)


async def get_search_store(
    settings: Annotated[Settings, Depends(get_settings)],
) -> SearchStore:
    if not settings.supabase_url or not settings.supabase_secret_key:
        raise HTTPException(503, "SUPABASE_URL and SUPABASE_SECRET_KEY are not configured.")
    return await SupabaseSearchStore.connect(settings.supabase_url, settings.supabase_secret_key)


DownloadClient = Callable[[], httpx.AsyncClient]


def get_download_client() -> DownloadClient:
    # A factory, not a client: the import outlives this request's dependencies (it keeps going if
    # the caller hangs up), so it opens and closes its own client. Replaced in tests by one on
    # httpx.MockTransport, so no test downloads anything.
    return lambda: httpx.AsyncClient(timeout=30)


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
def health(settings: Annotated[Settings, Depends(get_settings)]) -> dict[str, object]:
    return {
        "status": "ok",
        "model": settings.agent_model,
        "version": agent_version() or "unknown",
        # What each process uses where an organisation chose nothing, for the Admin page's
        # "deployment default" (organization_models, SYS-33). Model names only, never a key.
        "processes": {
            "transcription": settings.ingest_model,
            "summary": settings.summary_model,
            "chat": settings.chat_model,
            "embedding": settings.embedding_model,
            "figures": settings.figure_model,
        },
        # The paragraph reader this version splits with: a version split by another one is split
        # again by the next import, and the Regulations page counts how many are done (#52).
        "extractor": paragraphs.EXTRACTOR,
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


async def get_project_store(
    settings: Annotated[Settings, Depends(get_settings)],
) -> assistant.ProjectStore:
    if not settings.supabase_url or not settings.supabase_secret_key:
        raise HTTPException(503, "SUPABASE_URL and SUPABASE_SECRET_KEY are not configured.")
    return await SupabaseProjectStore.connect(settings.supabase_url, settings.supabase_secret_key)


# The submission as the run's stored requirements make it now (#36): for a run that never reached
# `submit` (out of time, a limit, a failure, an approval nobody gave), whose requirements are
# stored but which has no output. Writes nothing and calls no model. The web has checked that the
# caller can read the run's organisation.
@app.get("/runs/{run_id}/submission", dependencies=[Depends(require_secret)])
async def run_submission(
    run_id: UUID, store: Annotated[RunStore, Depends(get_store)]
) -> dict[str, Any]:
    try:
        run = await store.get_run(run_id)
        if run is None:
            raise HTTPException(404, "No such run.")
        if run.case_id is None:
            raise HTTPException(409, "This run has no case, so it stored no requirements.")
        data = await domain.stored_submission(store, run)
    finally:
        await store.aclose()
    return {"status": run.status, "submission": data}


class ChatRequest(BaseModel):
    project_id: UUID
    page: assistant.Page = Field(default_factory=assistant.Page)
    # The whole conversation as the browser holds it, the question last (domain/assistant.py).
    messages: list[assistant.Turn] = Field(min_length=1, max_length=200)


# A question to the assistant of a project (SYS-39, #31). Not streamed: one answer takes seconds,
# not minutes, and nothing is written. The web has checked that the person can read the project's
# organisation; this reads that project only.
@app.post("/chat", dependencies=[Depends(require_secret)])
async def chat(
    body: ChatRequest,
    settings: Annotated[Settings, Depends(get_settings)],
    store: Annotated[RunStore, Depends(get_store)],
    projects: Annotated[assistant.ProjectStore, Depends(get_project_store)],
) -> dict[str, Any]:
    try:
        result = await assistant.answer(
            store, projects, settings, body.project_id, body.page, body.messages
        )
    except assistant.ChatRefused as exc:
        raise HTTPException(exc.status, str(exc)) from None
    finally:
        await store.aclose()
        await projects.aclose()
    return {
        "answer": result.text,
        "model": result.model,
        "usage": result.usage,
        "notices": result.notices,
    }


# The model that will answer, for the panel to name before the first question.
@app.get("/chat/model", dependencies=[Depends(require_secret)])
async def chat_model(
    project_id: UUID,
    settings: Annotated[Settings, Depends(get_settings)],
    store: Annotated[RunStore, Depends(get_store)],
    projects: Annotated[assistant.ProjectStore, Depends(get_project_store)],
) -> dict[str, str]:
    try:
        project = await projects.project(project_id)
        if project is None:
            raise HTTPException(404, "No such project.")
        return {"model": await assistant.model_name(store, settings, project.organization_id)}
    finally:
        await store.aclose()
        await projects.aclose()


# One slice of a regulation import (domain/regulations.py), streamed like a run: accepted at once,
# heartbeats while it works, done with the import's status. The web sends a paused import back
# here for the next slice.
@app.post("/regulations/imports/{import_id}/advance", dependencies=[Depends(require_secret)])
async def advance_import(
    import_id: UUID,
    settings: Annotated[Settings, Depends(get_settings)],
    library: Annotated[LibraryStore, Depends(get_library)],
    download_client: Annotated[DownloadClient, Depends(get_download_client)],
) -> StreamingResponse:
    try:
        job = await regulations.prepare(library, settings, import_id)
    except regulations.ImportNotFound:
        await library.aclose()
        raise HTTPException(404, "No such import.") from None
    except regulations.CannotAdvance as exc:
        await library.aclose()
        raise HTTPException(409, str(exc)) from None

    async def work() -> str:
        # The pictures are described in the import itself (#52), metered like any model call.
        meter = metering.Meter(job.organization_id)
        step = figures.FigureStep(library, settings, job.organization_id, meter)
        try:
            async with download_client() as http:
                return await regulations.execute(library, http, settings, job, figures=step)
        finally:
            await meter.flush(library)

    async def body() -> AsyncIterator[str]:
        yield _line(event="accepted", import_id=str(import_id))
        task = asyncio.create_task(work())
        try:
            while True:
                done, _ = await asyncio.wait({task}, timeout=settings.heartbeat_s)
                if done:
                    break
                yield _line(event="heartbeat")
            yield _line(event="done", status=task.result())
        finally:
            if not task.done():
                await asyncio.shield(task)
            await library.aclose()

    return StreamingResponse(body(), media_type="application/x-ndjson")


# Parse a case's pending files once (domain/case_ingest.py). The web calls this after the files are
# uploaded and their rows inserted; a requirements run never parses, it reads what is stored.
def _is_local(model: str) -> bool:
    return providers.provider_of(model) in providers.ENDPOINT_PROVIDERS


# Streamed like a run, because a scanned PDF with model transcription can take a minute.
@app.post("/cases/{case_id}/ingest", dependencies=[Depends(require_secret)])
async def ingest_case(
    case_id: UUID,
    settings: Annotated[Settings, Depends(get_settings)],
    store: Annotated[RunStore, Depends(get_store)],
) -> StreamingResponse:
    files = await store.case_files(case_id)
    if not files:
        await store.aclose()
        raise HTTPException(404, "No files in this case.")
    if await store.organization_read_only(files[0].organization_id):
        # Parsing can call a model (scanned pages, pictures), and it rewrites the case's blocks.
        await store.aclose()
        raise HTTPException(409, read_only.REFUSAL)

    async def work() -> dict[str, int]:
        org = files[0].organization_id
        if await store.case_kind(case_id) == subgoal.KIND:
            # Certivity's sub-goal folder: nothing to transcribe, only to recognise (#42), and
            # both versions into the regulation library with their figures, metered on the case.
            meter = metering.Meter(org, case_id=case_id)
            library = store.subgoal_library()
            step = None if library is None else figures.FigureStep(library, settings, org, meter)
            try:
                return await subgoal.ingest_case(store, case_id, figures=step)
            finally:
                await meter.flush(store)
        # The organisation's choice first (Admin, SYS-33), then the deployment's.
        chosen = await store.organization_model(org, "transcription")
        name = (chosen or settings.ingest_model).strip()
        own = effective(settings, await store.organization_settings(org)).model
        if chosen is None and _is_local(own) and not _is_local(name):
            # An organisation that runs its models on its own server did it so case files do not
            # reach a hosted model (SYS-30). A scanned page sent to INGEST_MODEL would undo that
            # without anyone choosing it; it stays untranscribed and the file's notes say so. A
            # hosted model the organisation picked itself in Admin is its choice, and is used.
            name = ""
        # The pictures (photos, drawings, pages without text) go to the vision model the
        # organisation chose for figures, when it chose one (Ramón, 2026-10-25: one model reads
        # every picture, the regulations' and the part's). Only an explicit choice: without one
        # they stay on the transcription model, so an organisation on its own server keeps its
        # pictures there (SYS-30), and nothing changes for one that never opened that row.
        figure_choice = await store.organization_model(org, figures.PROCESS)
        picture_name = (figure_choice or "").strip() or name
        meter = metering.Meter(org, case_id=case_id)
        secrets: list[str | None] = []

        async def reader(model_name: str) -> case_ingest.Transcriber | None:
            if not model_name or model_name == "scripted":
                return None
            key, endpoint = await providers.credentials(store, org, model_name)
            secrets.append(key)
            credential = metering.Credential.for_model(
                model_name, key, endpoint.root() if endpoint else None
            )
            model = providers.build_model(model_name, key, endpoint)
            # Metered as transcription either way: the work is the case's, and Usage shows it
            # with the case, not with the regulation library.
            return case_ingest.transcriber(
                metering.metered(model, meter, "transcription", model_name, credential)
            )

        transcribe = await reader(name)
        describe = transcribe if picture_name == name else await reader(picture_name)
        try:
            return await case_ingest.ingest_case(
                store,
                case_id,
                transcribe=transcribe,
                parser_name=f"model:{name}",
                describe=describe,
                describer_name=f"model:{picture_name}",
                max_model_pages=settings.ingest_max_model_pages,
            )
        except Exception as exc:
            # The files that failed say so in their rows; this keeps the key out of the log.
            reason = str(exc)
            for secret in secrets:
                reason = providers.scrub(reason, secret)
            log.error("ingest of case %s failed: %s", case_id, reason)
            raise
        finally:
            await meter.flush(store)

    async def body() -> AsyncIterator[str]:
        yield _line(event="accepted", case_id=str(case_id))
        task = asyncio.create_task(work())
        try:
            while True:
                done, _ = await asyncio.wait({task}, timeout=settings.heartbeat_s)
                if done:
                    break
                yield _line(event="heartbeat")
            counts = task.result()
            yield _line(event="done", parsed=str(counts["parsed"]), failed=str(counts["failed"]))
        finally:
            if not task.done():
                await asyncio.shield(task)
            await store.aclose()

    return StreamingResponse(body(), media_type="application/x-ndjson")


def _line(**fields: Any) -> str:
    return json.dumps(fields) + "\n"


# One slice of indexing an organisation's regulation library for search
# (domain/regulation_search.py): vectors for new paragraphs, then scope summaries. Streamed like an
# import; `done` says what was done and whether anything is left, and the caller sends the next
# request while `finished` is false. Two requests at once only duplicate work: every write is
# idempotent.
@app.post("/regulations/index/{organization_id}/advance", dependencies=[Depends(require_secret)])
async def advance_index(
    organization_id: UUID,
    settings: Annotated[Settings, Depends(get_settings)],
    store: Annotated[SearchStore, Depends(get_search_store)],
    download_client: Annotated[DownloadClient, Depends(get_download_client)],
) -> StreamingResponse:
    async def work() -> regulation_search.Progress:
        async with download_client() as http:
            return await regulation_search.index_library(store, http, settings, organization_id)

    async def body() -> AsyncIterator[str]:
        yield _line(event="accepted", organization_id=str(organization_id))
        task = asyncio.create_task(work())
        try:
            while True:
                done, _ = await asyncio.wait({task}, timeout=settings.heartbeat_s)
                if done:
                    break
                yield _line(event="heartbeat")
            try:
                p = task.result()
            except Exception as exc:
                # The provider refused or the database did: the message says which, never a key
                # (EmbeddingError scrubs it), and the next request starts where this one stopped.
                log.exception("Indexing %s failed", organization_id)
                yield _line(
                    event="done", status="failed", error=f"{type(exc).__name__}: {exc}"[:500]
                )
                return
            yield _line(
                event="done",
                status="finished" if p.done else "paused",
                finished=p.done,
                keys_changed=p.keys_changed,
                embedded=p.embedded,
                pruned=p.pruned,
                summarized=p.summarized,
                notes=p.notes,
            )
        finally:
            if not task.done():
                await asyncio.shield(task)
            await store.aclose()

    return StreamingResponse(body(), media_type="application/x-ndjson")


# ------------------------------------------------------------------------------------------
# Admin: files queued for copying inside Storage (agent_service/storage_copies.py). Called by
# .github/workflows/demo-org.yml after scripts/demo-org.sql, again while `remaining` is not 0. Not
# by the web: no page queues copies.
# ------------------------------------------------------------------------------------------

# Under Vercel's 800 s, with room for the count at the end. About 92 PDFs and a dozen case files
# for the demo copy; a copy is one request each.
STORAGE_COPY_SLICE_S = 240.0


async def get_copy_queue(
    settings: Annotated[Settings, Depends(get_settings)],
) -> storage_copies.CopyQueue:
    if not settings.supabase_url or not settings.supabase_secret_key:
        raise HTTPException(503, "SUPABASE_URL and SUPABASE_SECRET_KEY are not configured.")
    return await storage_copies.SupabaseCopyQueue.connect(
        settings.supabase_url, settings.supabase_secret_key
    )


@app.post("/admin/storage-copies/advance", dependencies=[Depends(require_secret)])
async def advance_storage_copies(
    queue: Annotated[storage_copies.CopyQueue, Depends(get_copy_queue)],
) -> dict[str, int]:
    try:
        progress = await storage_copies.advance(queue, slice_s=STORAGE_COPY_SLICE_S)
    finally:
        await queue.aclose()
    return {"copied": progress.copied, "failed": progress.failed, "remaining": progress.remaining}


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
    if body.provider in providers.ENDPOINT_PROVIDERS:
        raise HTTPException(422, f"{body.provider} is checked with its URL, not a key.")
    if not body.api_key.strip():
        raise HTTPException(422, "The key is empty.")
    check = await providers.check_key(http, body.provider, body.api_key)
    return {"ok": check.ok, "detail": check.detail}


class EndpointToCheck(BaseModel):
    organization_id: UUID
    provider: Literal["ollama"]
    base_url: str = Field(pattern=r"^https?://[^/@\s?#]+(/[^\s?#@]*)?$", max_length=500)
    auth_scheme: AuthScheme
    username: str | None = Field(default=None, max_length=200)
    # None keeps the stored one, as set_provider_endpoint does: changing the port does not mean
    # typing the token again, so checking that change must not need it either.
    secret: str | None = Field(default=None, max_length=1000)


@app.post("/providers/endpoint/check", dependencies=[Depends(require_secret)])
async def check_provider_endpoint(
    body: EndpointToCheck,
    store: Annotated[RunStore, Depends(get_store)],
    http: Annotated[httpx.AsyncClient, Depends(get_http)],
) -> dict[str, str | bool]:
    secret = body.secret or None
    try:
        if secret is None and body.auth_scheme != "none":
            stored = await store.provider_endpoint(body.organization_id, body.provider)
            if stored is None or stored.auth_scheme != body.auth_scheme or not stored.secret:
                raise HTTPException(422, "Enter the token or password for this server.")
            secret = stored.secret
    finally:
        await store.aclose()
    endpoint = providers.Endpoint(
        base_url=body.base_url,
        auth_scheme=body.auth_scheme,
        username=body.username,
        secret=secret if body.auth_scheme != "none" else None,
    )
    check = await providers.check_endpoint(http, endpoint)
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
        elif provider == "ollama":
            endpoint = await store.provider_endpoint(organization_id, provider)
            if endpoint is None:
                raise HTTPException(409, "No Ollama server is connected for this organisation.")
            options = await providers.ollama_models(http, endpoint)
        else:
            key = await store.provider_key(organization_id, provider)
            if key is None:
                raise HTTPException(409, f"No {provider} key is connected for this organisation.")
            options = await providers.list_models(http, provider, key)
    except providers.KeyRejected as exc:
        if provider in providers.ENDPOINT_PROVIDERS:
            raise HTTPException(502, f"{exc} Update the server in Admin, Providers.") from None
        raise HTTPException(
            502, f"{provider} rejected the stored key. Replace it in Admin, Providers."
        ) from None
    except providers.ProviderError as exc:
        raise HTTPException(502, str(exc)) from None
    finally:
        await store.aclose()
    return {"models": [vars(o) for o in options]}


# ------------------------------------------------------------------------------------------
# Certivity: validate a submission and score it where an expected file exists. The reference files
# come from the database; nothing is written and no model is called. The web sends the text (a
# run's output or a file someone dropped) and shows the answer.
# ------------------------------------------------------------------------------------------


class SubmissionText(BaseModel):
    text: str
    # Whose regulation library to check citations against. The web has checked the caller can
    # read this organisation; without it validate.py skips the regulation check.
    organization_id: UUID | None = None
    # An expected.json the user chose in the web, scored against for this one check and not
    # stored (the release reloads certivity_reference from Certivity's package and would delete
    # it). Like score_local.py --expected: it is used whatever case_id the submission names.
    expected: dict[str, Any] | None = None
    # The run the text comes from, which the web has checked the caller can read. The citations
    # are then checked against the run's own organisation, and the result is stored with the run
    # (run_checks, #51) when the text is that run's file: its output, or for a run without one the
    # file its stored requirements make now. Anything else is checked and not stored, so a score
    # sits only next to the file it was computed on.
    run_id: UUID | None = None


@app.post("/checks", dependencies=[Depends(require_secret)])
async def certivity_checks(
    body: SubmissionText, store: Annotated[RunStore, Depends(get_store)]
) -> dict[str, Any]:
    try:
        run = await store.get_run(body.run_id) if body.run_id else None
        if body.run_id and run is None:
            raise HTTPException(404, "No such run.")
        organization_id = run.organization_id if run else body.organization_id
        reference = await certivity.load_reference(store, organization_id)
        result = certivity.check(body.text, reference, expected=body.expected)
        source = None
        # A score against an answer key someone chose is theirs to read, not the draft's score.
        # A read-only organisation is checked like any other but keeps the checks it has (SYS-47).
        if (
            run
            and body.expected is None
            and not await store.organization_read_only(run.organization_id)
        ):
            source = await _save_run_check(store, run, body.text, reference.commit, result)
    finally:
        await store.aclose()
    return {**result, "saved_as": source}


async def _save_run_check(
    store: RunStore, run: Run, text: str, certivity_commit: str, result: dict[str, Any]
) -> Literal["output", "stored"] | None:
    """Store the check with the run when `text` is one of its files. A failure here is logged and
    the check still answers: the person came for the result, the stored copy is for later."""
    try:
        source = await _run_source(store, run, text)
        if source:
            await store.save_check(
                {
                    "run_id": str(run.id),
                    "source": source,
                    "checked_at": datetime.now(UTC).isoformat(),
                    "submission_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                    "certivity_commit": certivity_commit,
                    "agent_version": agent_version(),
                    "result": result,
                }
            )
        return source
    except Exception:
        log.exception("Could not store the check of run %s", run.id)
        return None


async def _run_source(store: RunStore, run: Run, text: str) -> Literal["output", "stored"] | None:
    """Which of the run's files `text` is, if any. The stored file is compared as JSON, not as
    text: the web formats it (JSON.stringify) and Python would space it differently."""
    outcome = await store.run_outcome(run.id)
    if outcome and outcome.output is not None:
        return "output" if outcome.output == text else None
    if run.case_id is None:
        return None
    try:
        sent = json.loads(text)
    except json.JSONDecodeError:
        return None
    return "stored" if sent == await domain.stored_submission(store, run) else None
