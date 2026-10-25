"""The regulation import: reading an index, downloading safely, working through an import in
slices, and splitting the stored PDFs into paragraphs. Downloads go to httpx.MockTransport and host
lookups to a fake resolver, so nothing here touches the network. The PDFs are a few made-up bytes,
not challenge material; the splitter is replaced by `split_fake` except where a test says so, and
there it reads the made-up regulation in tests/fixtures/regulation."""

import asyncio
import hashlib
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient

from agent_service.api import app, get_download_client, get_library
from agent_service.domain import regulations
from agent_service.domain.paragraphs import (
    EXTRACTOR,
    Extraction,
    ExtractionProblem,
    Paragraph,
    extract,
)
from agent_service.domain.regulations import (
    CannotAdvance,
    FileProblem,
    ImportNotFound,
    IndexProblem,
    VersionToSplit,
    fetch_pdf,
    parse_index,
)
from agent_service.settings import Settings, get_settings
from tests.library_fakes import ORG, OTHER_ORG, InMemoryLibraryStore

pytestmark = pytest.mark.anyio

AUTH = {"Authorization": "Bearer test-secret"}
HOST = "files.example.org"


def pdf(text: str) -> bytes:
    return b"%PDF-1.7\n" + text.encode()


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def entry(code: str, *versions: tuple[str, str | None, bytes]) -> dict[str, Any]:
    return {
        "regulation": code,
        "title": f"Title of {code}",
        "source_url": "https://unece.org/",
        "versions": [
            {
                "version_label": label,
                "role": role,
                "status": "adopted",
                "title": f"{code}, version {label}",
                "files": [
                    {
                        "name": f"{code.replace(' ', '_')}_{role}.pdf",
                        "pdf_url": f"https://{HOST}/{code.replace(' ', '_')}/{label}.pdf?sig=x",
                        "sha256": sha(data),
                        "size_bytes": len(data),
                    }
                ],
            }
            for label, role, data in versions
        ],
    }


R10_BASE = pdf("R10 base")
R10_LATEST = pdf("R10 latest")
GTR9 = pdf("GTR 9")
INDEX = [
    entry("UN R10", ("7.2.0", "base", R10_BASE), ("7.3.0", "latest", R10_LATEST)),
    entry("UN GTR 9", ("2.0.0", "base", GTR9)),
]
BODIES = {
    "/UN_R10/7.2.0.pdf": R10_BASE,
    "/UN_R10/7.3.0.pdf": R10_LATEST,
    "/UN_GTR_9/2.0.0.pdf": GTR9,
}


async def public(_host: str, _port: int) -> list[str]:
    return ["93.184.216.34"]


async def private(_host: str, _port: int) -> list[str]:
    return ["10.0.0.5"]


class Server:
    """Serves BODIES and counts requests."""

    def __init__(self, bodies: dict[str, bytes] | None = None) -> None:
        self.bodies = BODIES if bodies is None else bodies
        self.requests: list[str] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request.url.path)
        body = self.bodies.get(request.url.path)
        return httpx.Response(200, content=body) if body is not None else httpx.Response(404)

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(self))


@pytest.fixture
def library() -> InMemoryLibraryStore:
    return InMemoryLibraryStore()


def split_fake(data: bytes, _figures: object = None) -> Extraction:
    """One paragraph per PDF, holding its bytes, so a test can tell which file was split."""
    text = data.decode(errors="replace")
    paragraph = Paragraph(0, "1", None, None, None, "1", "", "paragraph", text, 1, 1)
    return Extraction(page_count=1, version_label=None, paragraphs=[paragraph])


async def run(
    library: InMemoryLibraryStore,
    settings: Settings,
    import_id: Any,
    server: Server,
    split: regulations.Splitter = split_fake,
) -> str:
    job = await regulations.prepare(library, settings, import_id)
    async with server.client() as http:
        return await regulations.execute(library, http, settings, job, resolve=public, split=split)


# ---------------------------------------------------------------------------------- the index


def test_an_index_becomes_one_file_per_version_with_paths_by_version() -> None:
    files = parse_index(INDEX)
    assert [(f.regulation_code, f.version_label, f.role) for f in files] == [
        ("UN R10", "7.2.0", "base"),
        ("UN R10", "7.3.0", "latest"),
        ("UN GTR 9", "2.0.0", "base"),
    ]
    assert files[1].path(ORG) == f"{ORG}/UN_R10/7.3.0/UN_R10_7.3.0.pdf"
    assert [f.kind for f in files] == ["UN R", "UN R", "UN GTR"]


def test_fields_the_index_may_add_later_are_ignored() -> None:
    index = json.loads(json.dumps(INDEX))
    index[0]["new_field"] = 1
    index[0]["versions"][0]["files"][0]["mirror"] = "x"
    assert len(parse_index(index)) == 3


@pytest.mark.parametrize(
    ("change", "says"),
    [
        (lambda i: i[0]["versions"][0]["files"][0].update(sha256="abc"), "sha256"),
        (lambda i: i[0]["versions"][0]["files"][0].update(pdf_url="http://x.org/a.pdf"), "https"),
        (lambda i: i[0]["versions"][1].update(role="base"), "two versions are marked base"),
        (lambda i: i[0]["versions"][1].update(version_label="7.2.0"), "same version appears twice"),
        (lambda i: i[0]["versions"][0].update(version_label="../x"), "version_label"),
        (lambda i: i.append(i[0]), "appears twice"),
        (
            lambda i: i[0]["versions"][0]["files"].append(i[0]["versions"][0]["files"][0]),
            "one PDF per version",
        ),
    ],
)
def test_a_broken_index_is_refused_with_the_reason(
    change: Callable[[list[Any]], None], says: str
) -> None:
    index = json.loads(json.dumps(INDEX))
    change(index)
    with pytest.raises(IndexProblem, match=says):
        parse_index(index)


@pytest.mark.parametrize("raw", [{}, [], "text", None])
def test_something_that_is_not_a_list_of_regulations_is_refused(raw: Any) -> None:
    with pytest.raises(IndexProblem, match="non-empty list"):
        parse_index(raw)


# ---------------------------------------------------------------------------------- downloading


async def test_a_download_is_returned_once_its_checksum_matches() -> None:
    server = Server()
    async with server.client() as http:
        data = await fetch_pdf(
            http,
            f"https://{HOST}/UN_R10/7.2.0.pdf",
            sha(R10_BASE),
            max_bytes=1000,
            timeout_s=5,
            resolve=public,
        )
    assert data == R10_BASE


async def test_a_private_address_is_never_requested() -> None:
    # The link comes from an uploaded file; this service holds the database's secret key.
    server = Server()
    async with server.client() as http:
        with pytest.raises(FileProblem, match="not a public address"):
            await fetch_pdf(
                http,
                f"https://{HOST}/x.pdf",
                sha(b""),
                max_bytes=1000,
                timeout_s=5,
                resolve=private,
            )
    assert server.requests == []


@pytest.mark.parametrize(
    ("response", "says"),
    [
        (httpx.Response(302, headers={"location": "https://10.0.0.5/"}), "answered 302"),
        (httpx.Response(403), "may have expired"),
        (httpx.Response(200, content=b"not the file"), "does not match the sha256"),
        (httpx.Response(200, content=b"x" * 2000), "larger than"),
    ],
)
async def test_a_bad_response_is_not_kept(response: httpx.Response, says: str) -> None:
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _r: response)) as http:
        with pytest.raises(FileProblem, match=says):
            await fetch_pdf(
                http,
                f"https://{HOST}/x.pdf",
                sha(R10_BASE),
                max_bytes=1000,
                timeout_s=5,
                resolve=public,
            )


async def test_a_file_with_the_right_checksum_that_is_not_a_pdf_is_refused() -> None:
    body = b"<html>sign in</html>"
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _r: httpx.Response(200, content=body))
    ) as http:
        with pytest.raises(FileProblem, match="not a PDF"):
            await fetch_pdf(
                http,
                f"https://{HOST}/x.pdf",
                sha(body),
                max_bytes=1000,
                timeout_s=5,
                resolve=public,
            )


# ---------------------------------------------------------------------------------- an import


async def test_an_import_stores_every_file_and_records_the_catalogue(
    library: InMemoryLibraryStore, settings: Settings
) -> None:
    import_id = library.add_import(INDEX)

    assert await run(library, settings, import_id, Server()) == "succeeded"

    assert library.statuses(import_id) == ["stored", "stored", "stored"]
    assert library.objects[f"{ORG}/UN_R10/7.3.0/UN_R10_7.3.0.pdf"] == R10_LATEST
    assert library.role_of("UN R10", "7.3.0") == "latest"
    assert library.imports[import_id].status == "succeeded"


async def test_importing_the_same_index_again_downloads_nothing(
    library: InMemoryLibraryStore, settings: Settings
) -> None:
    await run(library, settings, library.add_import(INDEX), Server())
    server = Server()
    again = library.add_import(INDEX)

    assert await run(library, settings, again, server) == "succeeded"

    assert library.statuses(again) == ["unchanged", "unchanged", "unchanged"]
    assert server.requests == []


async def test_each_organisation_gets_its_own_copy_of_the_library(
    library: InMemoryLibraryStore, settings: Settings
) -> None:
    await run(library, settings, library.add_import(INDEX), Server())
    server = Server()
    other = library.add_import(INDEX, org=OTHER_ORG)

    assert await run(library, settings, other, server) == "succeeded"

    # Stored again, not "unchanged": another organisation's copy is not this one's.
    assert library.statuses(other) == ["stored", "stored", "stored"]
    assert len(server.requests) == 3
    assert library.objects[f"{OTHER_ORG}/UN_R10/7.3.0/UN_R10_7.3.0.pdf"] == R10_LATEST
    assert library.role_of("UN R10", "7.3.0", org=OTHER_ORG) == "latest"


async def test_a_newer_latest_takes_the_role_and_the_older_file_stays(
    library: InMemoryLibraryStore, settings: Settings
) -> None:
    await run(library, settings, library.add_import(INDEX), Server())
    newer = pdf("R10 newer")
    index = [entry("UN R10", ("7.4.0", "latest", newer))]

    await run(library, settings, library.add_import(index), Server({"/UN_R10/7.4.0.pdf": newer}))

    assert library.role_of("UN R10", "7.4.0") == "latest"
    assert library.role_of("UN R10", "7.3.0") is None
    assert library.objects[f"{ORG}/UN_R10/7.3.0/UN_R10_7.3.0.pdf"] == R10_LATEST


async def test_one_failed_file_fails_the_import_but_keeps_the_others(
    library: InMemoryLibraryStore, settings: Settings
) -> None:
    import_id = library.add_import(INDEX)
    server = Server({k: v for k, v in BODIES.items() if k != "/UN_R10/7.3.0.pdf"})

    assert await run(library, settings, import_id, server) == "failed"

    assert library.statuses(import_id) == ["stored", "failed", "stored"]
    assert "404" in (library.file_errors(import_id)[1] or "")
    assert library.errors[import_id] == "1 file(s) could not be stored; see the list."


async def test_an_index_that_cannot_be_read_fails_with_the_reason(
    library: InMemoryLibraryStore, settings: Settings
) -> None:
    import_id = library.add_import([{"regulation": "UN R10"}])

    assert await run(library, settings, import_id, Server()) == "failed"

    assert "versions" in (library.errors[import_id] or "")


async def test_an_import_out_of_time_pauses_and_the_next_request_finishes_it(
    library: InMemoryLibraryStore, settings: Settings
) -> None:
    import_id = library.add_import(INDEX)

    settings.import_slice_s = 0
    assert await run(library, settings, import_id, Server()) == "paused"
    assert library.statuses(import_id) == ["pending", "pending", "pending"]

    settings.import_slice_s = 150
    assert await run(library, settings, import_id, Server()) == "succeeded"


async def test_a_cancelled_import_stops_before_the_next_file(
    library: InMemoryLibraryStore, settings: Settings
) -> None:
    import_id = library.add_import(INDEX)
    library.cancel_on_touch = True
    server = Server()

    assert await run(library, settings, import_id, server) == "cancelled"

    assert server.requests == []
    assert library.imports[import_id].status == "cancelled"


async def test_prepare_refuses_what_it_cannot_advance(
    library: InMemoryLibraryStore, settings: Settings
) -> None:
    with pytest.raises(ImportNotFound):
        await regulations.prepare(library, settings, uuid4())
    with pytest.raises(CannotAdvance, match="already running"):
        await regulations.prepare(library, settings, library.add_import(INDEX, "running"))
    with pytest.raises(CannotAdvance, match="already succeeded"):
        await regulations.prepare(library, settings, library.add_import(INDEX, "succeeded"))


async def test_a_running_import_without_a_heartbeat_is_taken_over(
    library: InMemoryLibraryStore, settings: Settings
) -> None:
    # Unlike a run, an import is safe to resume: a stored file is skipped, not written twice.
    import_id = library.add_import(INDEX, "running", idle_s=settings.import_stale_after_s + 1)
    assert await run(library, settings, import_id, Server()) == "succeeded"


async def test_an_import_that_failed_on_an_unexpected_error_is_resumed(
    library: InMemoryLibraryStore, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    # As on production (#57): a read of the library hit the statement timeout after every file
    # was stored.
    async def times_out(*_args: object) -> list[VersionToSplit]:
        raise RuntimeError("canceling statement due to statement timeout")

    monkeypatch.setattr(library, "versions_to_split", times_out)
    import_id = library.add_import(INDEX)
    server = Server()
    assert await run(library, settings, import_id, server) == "failed"
    assert "Resume it" in (library.errors[import_id] or "")
    downloads = len(server.requests)

    monkeypatch.undo()
    assert await run(library, settings, import_id, server) == "succeeded"

    assert len(server.requests) == downloads  # every file was stored before the error
    assert all(v.paragraphs for v in library.versions)


async def test_a_failed_import_waits_while_another_of_its_organisation_is_active(
    library: InMemoryLibraryStore, settings: Settings
) -> None:
    failed = library.add_import(INDEX, "failed")
    library.add_import(INDEX, "paused")

    with pytest.raises(CannotAdvance, match="Another import"):
        await regulations.prepare(library, settings, failed)
    assert library.imports[failed].status == "failed"


# ---------------------------------------------------------------------------------- HTTP


# ---------------------------------------------------------------------------------- paragraphs

SAMPLE = (Path(__file__).parent / "fixtures" / "regulation" / "sample.pdf").read_bytes()


async def test_an_import_splits_every_stored_version_into_paragraphs(
    library: InMemoryLibraryStore, settings: Settings
) -> None:
    index = [entry("UN R999", ("2.1.0", "base", SAMPLE))]
    server = Server({"/UN_R999/2.1.0.pdf": SAMPLE})

    # The real splitter, on the made-up regulation.
    assert await run(library, settings, library.add_import(index), server, split=extract) == (
        "succeeded"
    )

    version = library.version("UN R999", "2.1.0")
    assert version.extracted_with == EXTRACTOR
    assert version.page_count == 3
    labels = [p.label for p in version.paragraphs]
    assert "Annex 2 Part 1 1.1" in labels
    assert len(labels) == 25


async def test_versions_imported_before_the_splitter_get_paragraphs_on_the_next_import(
    library: InMemoryLibraryStore, settings: Settings
) -> None:
    await run(library, settings, library.add_import(INDEX), Server())
    for version in library.versions:
        version.extracted_with, version.paragraphs = None, []
    server = Server()

    assert await run(library, settings, library.add_import(INDEX), server) == "succeeded"

    assert server.requests == []  # nothing downloaded again
    assert library.version("UN R10", "7.3.0").paragraphs[0].text == R10_LATEST.decode()
    assert all(v.extracted_with == EXTRACTOR for v in library.versions)


async def test_a_version_already_split_by_this_extractor_is_not_split_again(
    library: InMemoryLibraryStore, settings: Settings
) -> None:
    await run(library, settings, library.add_import(INDEX), Server())
    calls: list[bytes] = []

    def counting(data: bytes, _figures: object = None) -> Extraction:
        calls.append(data)
        return split_fake(data)

    await run(library, settings, library.add_import(INDEX), Server(), split=counting)

    assert calls == []


async def test_a_new_file_under_the_same_version_is_split_again(
    library: InMemoryLibraryStore, settings: Settings
) -> None:
    await run(library, settings, library.add_import(INDEX), Server())
    replaced = pdf("R10 latest, corrected")
    index = [entry("UN R10", ("7.3.0", "latest", replaced))]

    await run(library, settings, library.add_import(index), Server({"/UN_R10/7.3.0.pdf": replaced}))

    assert library.version("UN R10", "7.3.0").paragraphs[0].text == replaced.decode()


async def test_a_pdf_that_cannot_be_split_is_named_and_the_import_still_succeeds(
    library: InMemoryLibraryStore, settings: Settings
) -> None:
    def refuse_r10(data: bytes, _figures: object = None) -> Extraction:
        if b"R10" in data:
            raise ExtractionProblem("No text layer.")
        return split_fake(data)

    import_id = library.add_import(INDEX)

    assert await run(library, settings, import_id, Server(), split=refuse_r10) == "succeeded"

    assert library.version("UN R10", "7.2.0").extraction_error == "No text layer."
    assert library.version("UN R10", "7.2.0").paragraphs == []
    assert library.version("UN GTR 9", "2.0.0").paragraphs != []
    assert library.errors[import_id] == (
        "2 version(s) could not be split into paragraphs: UN R10 7.2.0: No text layer.; "
        "UN R10 7.3.0: No text layer.."
    )


async def test_a_splitter_crash_is_recorded_so_the_next_import_does_not_trip_on_it(
    library: InMemoryLibraryStore, settings: Settings
) -> None:
    def crash(_data: bytes, _figures: object = None) -> Extraction:
        raise IndexError("list index out of range")

    await run(library, settings, library.add_import(INDEX), Server(), split=crash)
    calls: list[bytes] = []

    def counting(data: bytes, _figures: object = None) -> Extraction:
        calls.append(data)
        return split_fake(data)

    await run(library, settings, library.add_import(INDEX), Server(), split=counting)

    assert calls == []
    assert "IndexError" in (library.version("UN R10", "7.2.0").extraction_error or "")


async def test_a_bucket_that_does_not_answer_leaves_the_version_for_the_next_import(
    library: InMemoryLibraryStore, settings: Settings
) -> None:
    await run(library, settings, library.add_import(INDEX), Server())
    gtr = library.version("UN GTR 9", "2.0.0")
    gtr.extracted_with, gtr.paragraphs = None, []
    library.unreachable.add(gtr.path)
    import_id = library.add_import(INDEX)

    assert await run(library, settings, import_id, Server()) == "succeeded"

    assert gtr.extracted_with is None
    assert "UN GTR 9 2.0.0" in (library.errors[import_id] or "")
    assert "import the index again" in (library.errors[import_id] or "")

    library.unreachable.clear()
    await run(library, settings, library.add_import(INDEX), Server())
    assert gtr.extracted_with == EXTRACTOR


async def test_a_stored_pdf_that_does_not_match_its_checksum_is_not_split(
    library: InMemoryLibraryStore, settings: Settings
) -> None:
    await run(library, settings, library.add_import(INDEX), Server())
    gtr = library.version("UN GTR 9", "2.0.0")
    gtr.extracted_with, gtr.paragraphs = None, []
    library.objects[gtr.path] = pdf("something else")

    await run(library, settings, library.add_import(INDEX), Server())

    assert "sha256" in (gtr.extraction_error or "")
    assert gtr.paragraphs == []


async def test_splitting_pauses_when_the_slice_ends_and_resumes_where_it_stopped(
    library: InMemoryLibraryStore, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    await run(library, settings, library.add_import(INDEX), Server())
    for version in library.versions:
        version.extracted_with, version.paragraphs = None, []
    clock = [0.0]
    monkeypatch.setattr(regulations.time, "monotonic", lambda: clock[0])

    def slow(data: bytes, _figures: object = None) -> Extraction:
        clock[0] += settings.import_slice_s  # the first versions use up the whole slice
        return split_fake(data)

    import_id = library.add_import(INDEX)

    # The versions started together before the slice ran out finish; no other one starts.
    started = settings.split_concurrency
    assert 0 < started < len(library.versions)
    assert await run(library, settings, import_id, Server(), split=slow) == "paused"
    assert [v.extracted_with for v in library.versions] == [EXTRACTOR] * started + [None] * (
        len(library.versions) - started
    )

    assert await run(library, settings, import_id, Server()) == "succeeded"
    assert all(v.extracted_with == EXTRACTOR for v in library.versions)


@pytest.fixture
def client(library: InMemoryLibraryStore, settings: Settings):
    app.dependency_overrides[get_library] = lambda: library
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_download_client] = lambda: Server().client
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_advancing_an_import_needs_the_secret(client: TestClient) -> None:
    url = "/regulations/imports/00000000-0000-4000-8000-000000000009/advance"
    assert client.post(url).status_code == 401
    assert client.post(url, headers=AUTH).status_code == 404


def test_advancing_an_import_streams_accepted_then_done(
    client: TestClient, library: InMemoryLibraryStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The endpoint uses the real resolver; this test has no network, so it gets the fake one.
    original = regulations.execute

    async def execute(*args: Any, **kwargs: Any) -> str:
        return await original(*args, **kwargs, resolve=public)

    monkeypatch.setattr(regulations, "execute", execute)
    import_id = library.add_import(INDEX)

    response = client.post(f"/regulations/imports/{import_id}/advance", headers=AUTH)

    lines = [json.loads(line) for line in response.text.splitlines()]
    assert lines[0] == {"event": "accepted", "import_id": str(import_id)}
    assert lines[-1] == {"event": "done", "status": "succeeded"}
    assert library.closed
    assert client.post(f"/regulations/imports/{import_id}/advance", headers=AUTH).status_code == 409


async def test_files_are_downloaded_several_at_once(
    library: InMemoryLibraryStore, settings: Settings
) -> None:
    # A download is network time: one at a time, a slice spent most of its 150 s waiting (#43).
    class SlowServer(Server):
        active = peak = 0

        async def __call__(self, request: httpx.Request) -> httpx.Response:  # pyright: ignore[reportIncompatibleMethodOverride]
            SlowServer.active += 1
            SlowServer.peak = max(SlowServer.peak, SlowServer.active)
            await asyncio.sleep(0.01)
            SlowServer.active -= 1
            return super().__call__(request)

    assert await run(library, settings, library.add_import(INDEX), SlowServer()) == "succeeded"
    assert SlowServer.peak == min(len(BODIES), settings.import_concurrency) > 1
