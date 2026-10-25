"""Fill the regulation library from an uploaded index file (docs/regulations-store.md).

The index is the challenge's regulations/index.json format: a list of regulations, each with
versions, each version with one PDF given as a temporary download link and its sha256. This is
what the challenge's tools/fetch_regulations.py downloads to a laptop; here the same files go to
the `regulations` bucket and the catalogue tables instead, so the deployment has them.

Like runner.py, two halves so the HTTP layer can refuse with a status code before streaming:

  prepare()  checks the import can advance and claims it. Raises ImportNotFound or CannotAdvance.
  execute()  works through the files until done or until the slice of time runs out. Never
             raises; what happened is in the import's status and in each file's row.

One request handles one slice (`import_slice_s`), because a whole library does not fit in one
serverless call. An import that runs out of time is left `paused`; the web page sends it back.

Once every file is stored, the same import splits into paragraphs (domain/paragraphs.py) every
version of the organisation's library that the current extractor has not split yet: the ones this
import stored, and older ones, so importing an index again fills in a library imported before the
splitter existed, or re-splits it after the splitter changes (`EXTRACTOR`).

Resuming is safe here, unlike a run: a file already stored with the same sha256 is skipped, and
storing one twice writes the same bytes to the same path. So a running import whose heartbeat has
gone stale is simply taken over, not failed.

Before a version is split, its pictures are described by a vision model (figures.py, #52), when
the caller passes `figures`: the descriptions go into the paragraphs. A version split while some
pictures had no description is listed again by the next import, and split again only if more of
its pictures have one by then.

What this does NOT do:
  - delete anything. An import adds and updates; a version missing from a new index stays.
  - compute embeddings. That is the indexing (regulation_search.py), on the stored paragraphs.
  - split a library without an import. Importing the same index again is how to ask for it; it
    downloads nothing.
  - follow redirects or fetch from private addresses. The links come from a file a person
    uploaded, so a link to the deployment's own network must not be fetched (see `fetch_pdf`).
"""

import asyncio
import hashlib
import ipaddress
import logging
import re
import socket
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any, Literal, Protocol
from urllib.parse import urlsplit
from uuid import UUID

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from agent_service import read_only
from agent_service.domain.figures import FigureStore, Outcome
from agent_service.domain.paragraphs import EXTRACTOR, Extraction, ExtractionProblem, extract
from agent_service.domain.pdf_figures import Figure
from agent_service.settings import Settings
from agent_service.slices import each_until

log = logging.getLogger(__name__)

BUCKET = "regulations"

ImportStatus = Literal["queued", "running", "paused", "succeeded", "failed", "cancelled"]
FileStatus = Literal["pending", "stored", "unchanged", "failed"]

_SHA256 = r"^[0-9a-fA-F]{64}$"
# Also a folder name in the bucket, so no slashes and nothing that starts with a dot.
_VERSION_LABEL = r"^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$"
_SLUG = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$")
# Well above the challenge's 92 files; a file with more is more likely a mistake than a library.
MAX_FILES = 2000
# How many problems an index is reported with. A wrong file has hundreds; the first few say why.
_MAX_PROBLEMS = 10


# ------------------------------------------------------------------------------------------
# The index file
# ------------------------------------------------------------------------------------------


# extra="ignore": the challenge may add fields to its index; an unknown field is not an error.
class _IndexFile(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str = Field(min_length=1, max_length=255)
    pdf_url: str = Field(min_length=1, max_length=4000)
    sha256: str = Field(pattern=_SHA256)
    size_bytes: int | None = Field(default=None, gt=0)


class _IndexVersion(BaseModel):
    model_config = ConfigDict(extra="ignore")
    version_label: str = Field(pattern=_VERSION_LABEL)
    role: Literal["base", "latest"] | None = None
    status: str | None = Field(default=None, max_length=50)
    title: str | None = Field(default=None, max_length=500)
    files: list[_IndexFile] = Field(min_length=1)


class _IndexRegulation(BaseModel):
    model_config = ConfigDict(extra="ignore")
    regulation: str = Field(min_length=1, max_length=100)
    title: str | None = Field(default=None, max_length=500)
    source_url: str | None = Field(default=None, max_length=2000)
    versions: list[_IndexVersion] = Field(min_length=1)


class IndexProblem(Exception):
    """The uploaded index cannot be imported. The message is for the person who uploaded it."""


@dataclass(frozen=True)
class PlannedFile:
    """One PDF to store: everything the import needs, flattened from the index."""

    position: int
    regulation_code: str
    regulation_title: str | None
    regulation_source_url: str | None
    version_label: str
    role: Literal["base", "latest"] | None
    status: str | None
    version_title: str | None
    file_name: str
    url: str
    sha256: str
    size_bytes: int | None

    @property
    def slug(self) -> str:
        return slug_of(self.regulation_code)

    @property
    def kind(self) -> str:
        return kind_of(self.regulation_code)

    def path(self, organization_id: UUID) -> str:
        return storage_path(organization_id, self.regulation_code, self.version_label)


def slug_of(code: str) -> str:
    # The same rule as the challenge's fetch script, so the bucket's folders match the folders a
    # person gets on their laptop: "UN R10" -> "UN_R10", "UN GTR 9" -> "UN_GTR_9".
    return "_".join(code.replace("/", " ").split())


def kind_of(code: str) -> str:
    if re.match(r"^UN R\s*\d", code):
        return "UN R"
    if re.match(r"^UN GTR\s*\d", code):
        return "UN GTR"
    return "other"


def storage_path(organization_id: UUID, code: str, version_label: str) -> str:
    # The organisation first: each has its own library, and the bucket's read policy takes the
    # organisation from the path (as for case-files). By version, not by role: the role moves when
    # a newer version arrives, and a path built on it would overwrite the file an older catalogue
    # row still points to.
    slug = slug_of(code)
    return f"{organization_id}/{slug}/{version_label}/{slug}_{version_label}.pdf"


def parse_index(raw: Any) -> list[PlannedFile]:
    """The files to import, in the order of the index, or IndexProblem saying what is wrong."""
    if not isinstance(raw, list) or not raw:
        raise IndexProblem("The index must be a non-empty list of regulations.")

    problems: list[str] = []
    regulations: list[_IndexRegulation] = []
    for number, entry in enumerate(raw, start=1):
        name = entry.get("regulation") if isinstance(entry, dict) else None
        where = f"Entry {number}" + (f" ({name})" if isinstance(name, str) else "")
        try:
            regulations.append(_IndexRegulation.model_validate(entry))
        except ValidationError as exc:
            for error in exc.errors():
                field = ".".join(str(part) for part in error["loc"])
                problems.append(f"{where}, {field}: {error['msg']}")

    files: list[PlannedFile] = []
    seen_codes: set[str] = set()
    for reg in regulations:
        # Kept exactly as written, spaces included: Certivity's validate.py compares a submission's
        # `regulation` with this file, not with our tables (docs/se/requirements.md, SYS-5).
        code = reg.regulation
        if not _SLUG.match(slug_of(code)):
            problems.append(f"{code}: the name cannot be used as a folder name.")
            continue
        if code in seen_codes:
            problems.append(f"{code}: appears twice in the index.")
            continue
        seen_codes.add(code)
        labels: set[str] = set()
        roles: set[str] = set()
        for version in reg.versions:
            where = f"{code} {version.version_label}"
            if version.version_label in labels:
                problems.append(f"{where}: the same version appears twice.")
            labels.add(version.version_label)
            if version.role is not None:
                if version.role in roles:
                    problems.append(f"{code}: two versions are marked {version.role}.")
                roles.add(version.role)
            if len(version.files) != 1:
                # One PDF per version is what the bucket layout and the page citations assume.
                count = len(version.files)
                problems.append(f"{where}: has {count} files; one PDF per version is supported.")
                continue
            file = version.files[0]
            if urlsplit(file.pdf_url).scheme != "https":
                problems.append(f"{where}: the download link must start with https://.")
                continue
            files.append(
                PlannedFile(
                    position=len(files),
                    regulation_code=code,
                    regulation_title=reg.title,
                    regulation_source_url=reg.source_url,
                    version_label=version.version_label,
                    role=version.role,
                    status=version.status,
                    version_title=version.title,
                    file_name=file.name,
                    url=file.pdf_url,
                    sha256=file.sha256.lower(),
                    size_bytes=file.size_bytes,
                )
            )

    if len(files) > MAX_FILES:
        problems.append(f"The index lists {len(files)} files; at most {MAX_FILES} are accepted.")
    if problems:
        shown = problems[:_MAX_PROBLEMS]
        more = len(problems) - len(shown)
        raise IndexProblem("; ".join(shown) + (f"; and {more} more." if more else "."))
    return files


# ------------------------------------------------------------------------------------------
# Downloading one PDF
# ------------------------------------------------------------------------------------------


class FileProblem(Exception):
    """This file could not be stored. The message goes to the file's row as it is."""


Resolver = Callable[[str, int], Awaitable[list[str]]]


async def resolve_host(host: str, port: int) -> list[str]:
    infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return [str(info[4][0]) for info in infos]


async def fetch_pdf(
    http: httpx.AsyncClient,
    url: str,
    sha256: str,
    *,
    max_bytes: int,
    timeout_s: float,
    resolve: Resolver = resolve_host,
    retries: int = 2,
) -> bytes:
    """The verified bytes of the PDF at `url`, or FileProblem.

    The link comes from a file someone uploaded, and this service holds the database's secret key,
    so the request must not reach anything private: https only, every address of the host must be
    public, and no redirects (a public URL could otherwise bounce to an internal one). DNS could
    still change between this check and the connection; the sha256 check below means such a
    response is never stored, though the request itself would have been made.
    """
    parts = urlsplit(url)
    if parts.scheme != "https" or not parts.hostname:
        raise FileProblem("The download link must be an https:// address.")
    try:
        addresses = await resolve(parts.hostname, parts.port or 443)
    except OSError:
        raise FileProblem(f"The host {parts.hostname} could not be found.") from None
    if not addresses or not all(ipaddress.ip_address(a).is_global for a in addresses):
        raise FileProblem(f"The host {parts.hostname} is not a public address; not downloaded.")

    last = "unknown error"
    for attempt in range(1, retries + 1):
        try:
            # A total bound per attempt: httpx's own timeout is per read, and a server that trickles
            # one byte at a time would never trip it.
            async with asyncio.timeout(timeout_s):
                return await _download(http, url, sha256, max_bytes)
        except FileProblem:
            raise  # a wrong checksum or an oversized file will not change on a retry
        except (httpx.HTTPError, TimeoutError) as exc:
            last = "timed out" if isinstance(exc, TimeoutError) else type(exc).__name__
            if attempt < retries:
                await asyncio.sleep(attempt)
    raise FileProblem(f"The download failed {retries} times ({last}).")


async def _download(http: httpx.AsyncClient, url: str, sha256: str, max_bytes: int) -> bytes:
    async with http.stream("GET", url, follow_redirects=False) as response:
        if response.status_code in (401, 403, 404, 410):
            # Signed links expire: after the event the challenge's links answer like this.
            raise FileProblem(f"The link answered {response.status_code}; it may have expired.")
        if response.status_code != 200:
            raise FileProblem(f"The link answered {response.status_code}.")
        declared = response.headers.get("content-length")
        if declared is not None and declared.isdigit() and int(declared) > max_bytes:
            raise FileProblem(f"The file is larger than {max_bytes // 1_000_000} MB.")
        digest = hashlib.sha256()
        chunks: list[bytes] = []
        size = 0
        async for chunk in response.aiter_bytes():
            size += len(chunk)
            if size > max_bytes:
                raise FileProblem(f"The file is larger than {max_bytes // 1_000_000} MB.")
            digest.update(chunk)
            chunks.append(chunk)
    data = b"".join(chunks)
    if digest.hexdigest() != sha256:
        raise FileProblem("The downloaded file does not match the sha256 in the index; not stored.")
    if not data.startswith(b"%PDF-"):
        raise FileProblem("The downloaded file is not a PDF.")
    return data


# ------------------------------------------------------------------------------------------
# Where an import lives
# ------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class VersionToSplit:
    """A stored version whose paragraphs are missing, were cut by an older extractor, or were
    cut while some of its pictures had no description yet (figures.py)."""

    id: UUID
    regulation_code: str
    version_label: str
    sha256: str
    pdf_path: str
    extracted_with: str | None = None
    # Distinct pictures without a description or a recorded error when it was last split.
    figures_missing: int = 0

    @property
    def name(self) -> str:
        return f"{self.regulation_code} {self.version_label}"


# The PDF, and the descriptions of its pictures by sha256 (figures.py).
Splitter = Callable[[bytes, Mapping[str, str]], Extraction]


class DescribeFigures(Protocol):
    """figures.FigureStep, or a fake in tests."""

    # Why pictures cannot be described in this slice, once found out. None while they can.
    unusable: str | None
    described: int

    async def __call__(self, label: str, pdf: bytes, deadline: float) -> Outcome: ...


class ImportRow(BaseModel):
    id: UUID
    # Whose library this import fills.
    organization_id: UUID
    status: ImportStatus
    index: Any
    updated_at: Any


class SplitStore(FigureStore, Protocol):
    """What splitting one stored version needs (`split_one`): the import, and a sub-goal run that
    puts a version through the same steps (subgoal_library.py)."""

    async def download_pdf(self, path: str) -> bytes: ...

    async def save_paragraphs(
        self, version: VersionToSplit, extractor: str, extraction: Extraction
    ) -> bool:
        """Replaces the version's paragraphs at once. False if the version's file changed since
        it was listed, in which case nothing is written."""
        ...

    async def splitting_failed(self, version: VersionToSplit, extractor: str, error: str) -> None:
        """The version's file cannot be split by `extractor`: record why, drop its paragraphs."""
        ...

    async def save_figures(
        self, version: VersionToSplit, figures: list[Figure], missing: int
    ) -> None:
        """Replaces where the version's pictures are, and records how many have no description."""
        ...


class LibraryStore(SplitStore, Protocol):
    """The import's tables and bucket, and what figures.FigureStep reads and writes."""

    async def get_import(self, import_id: UUID) -> ImportRow | None: ...

    async def organization_read_only(self, org: UUID) -> bool: ...

    async def claim_import(
        self, import_id: UUID, expected: ImportStatus, *, idle_s: float = 0
    ) -> bool:
        """Move the import from `expected` to running. With idle_s, only if its heartbeat is at
        least that old. False if someone else got there first."""
        ...

    async def touch_import(self, import_id: UUID) -> bool:
        """Heartbeat. False if the import is no longer running (cancelled from the app)."""
        ...

    async def end_import(
        self, import_id: UUID, status: ImportStatus, error: str | None = None
    ) -> None:
        """Paused, succeeded or failed; only while it is still running."""
        ...

    async def has_files(self, import_id: UUID) -> bool: ...

    async def add_files(self, import_id: UUID, files: list[PlannedFile]) -> None: ...

    async def pending_files(self, import_id: UUID) -> list[PlannedFile]: ...

    async def failed_count(self, import_id: UUID) -> int: ...

    async def set_file(
        self, import_id: UUID, position: int, status: FileStatus, error: str | None = None
    ) -> None: ...

    async def stored_file(
        self, organization_id: UUID, code: str, version_label: str
    ) -> tuple[str, int] | None:
        """(sha256, size in bytes) of the version already in this organisation's library."""
        ...

    async def object_exists(self, path: str) -> bool: ...

    async def upload_pdf(self, path: str, data: bytes) -> None: ...

    async def record_version(self, job: ImportRow, file: PlannedFile, size_bytes: int) -> None: ...

    async def versions_to_split(
        self, organization_id: UUID, extractor: str
    ) -> list[VersionToSplit]:
        """Versions of the library not split by `extractor` yet, failures included."""
        ...

    async def splitting_errors(self, organization_id: UUID, extractor: str) -> list[str]:
        """ "UN R10 7.2.0: reason" for every version `extractor` could not split."""
        ...

    async def aclose(self) -> None: ...


# ------------------------------------------------------------------------------------------
# One slice of an import
# ------------------------------------------------------------------------------------------


class ImportNotFound(Exception):
    pass


class CannotAdvance(Exception):
    """The import exists but is not in a state this request can move forward."""


async def prepare(store: LibraryStore, settings: Settings, import_id: UUID) -> ImportRow:
    job = await store.get_import(import_id)
    if job is None:
        raise ImportNotFound(str(import_id))
    # Before the claim, so a refused import is left as it was: an import describes figures with a
    # model, which a read-only organisation never pays for (SYS-47).
    if await store.organization_read_only(job.organization_id):
        raise CannotAdvance(read_only.REFUSAL)
    if job.status in ("queued", "paused"):
        if not await store.claim_import(import_id, job.status):
            raise CannotAdvance("Another request picked this import up first.")
        return job
    if job.status == "running":
        if not await store.claim_import(import_id, "running", idle_s=settings.import_stale_after_s):
            raise CannotAdvance("The import is already running.")
        log.warning("Import %s had no heartbeat; taking it over.", import_id)
        return job
    if job.status == "failed":
        # Resumed from the page (#57). An unexpected error, often a database timeout, ends an
        # import as failed and asks for a Resume. Like a takeover, resuming is safe: stored files
        # are skipped and only versions without paragraphs are split. Another import of the same
        # organisation that is active refuses the claim (regulation_imports_one_active).
        if not await store.claim_import(import_id, "failed"):
            raise CannotAdvance(
                "Another import of this organisation is active, or this one was resumed already."
            )
        return job
    raise CannotAdvance(f"The import is already {job.status}.")


async def execute(
    store: LibraryStore,
    http: httpx.AsyncClient,
    settings: Settings,
    job: ImportRow,
    *,
    resolve: Resolver = resolve_host,
    split: Splitter = extract,
    figures: DescribeFigures | None = None,
) -> ImportStatus:
    """Never raises: an unexpected error ends the import as failed, with the reason.

    With `figures`, each version's pictures are described before it is split (figures.py)."""
    try:
        return await _execute(store, http, settings, job, resolve, split, figures)
    except Exception as exc:
        log.exception("Import %s failed", job.id)
        message = f"The import stopped on an unexpected error ({type(exc).__name__}). Resume it."
        await store.end_import(job.id, "failed", message)
        return "failed"


async def _execute(
    store: LibraryStore,
    http: httpx.AsyncClient,
    settings: Settings,
    job: ImportRow,
    resolve: Resolver,
    split: Splitter,
    figures: DescribeFigures | None,
) -> ImportStatus:
    deadline = time.monotonic() + settings.import_slice_s

    if not await store.has_files(job.id):
        try:
            planned = parse_index(job.index)
        except IndexProblem as exc:
            await store.end_import(job.id, "failed", str(exc))
            return "failed"
        await store.add_files(job.id, planned)

    # Several at once (#43; settings.import_concurrency). The import's heartbeat goes with each
    # file started, as it did one at a time, so a cancellation stops new files within one file.
    # Downloads and uploads overlap; recording a version does not. record_regulation_version
    # creates the regulation row on its first version and moves roles between versions, and two
    # versions of one regulation recorded at once both tried to create the row (CI, 10abe05:
    # duplicate key on regulations_organization_id_slug_key).
    cancelled = False
    recording = asyncio.Lock()

    async def store_file(file: PlannedFile) -> bool:
        nonlocal cancelled
        if not await store.touch_import(job.id):
            cancelled = True
            return False
        status, error = await _store_one(store, http, settings, job, file, resolve, recording)
        await store.set_file(job.id, file.position, status, error)
        return True

    stored = await each_until(
        await store.pending_files(job.id),
        store_file,
        limit=settings.import_concurrency,
        deadline=deadline,
    )
    if cancelled:
        return "cancelled"
    if not stored:
        await store.end_import(job.id, "paused")
        return "paused"

    # Paragraphs, for the whole library and not only this import's files (module docstring).
    # A version that fails for a reason that may pass (the bucket did not answer) is skipped for
    # the rest of this slice and not recorded, so the next import tries it again. Fewer at once
    # than downloads (settings.split_concurrency says why).
    skipped: list[str] = []

    async def split_version(version: VersionToSplit) -> bool:
        nonlocal cancelled
        if not await store.touch_import(job.id):
            cancelled = True
            return False
        if not await split_one(store, version, split, figures, deadline):
            skipped.append(version.name)
        return True

    split_all = await each_until(
        await store.versions_to_split(job.organization_id, EXTRACTOR),
        split_version,
        limit=settings.split_concurrency,
        deadline=deadline,
    )
    if cancelled:
        return "cancelled"
    if not split_all:
        await store.end_import(job.id, "paused")
        return "paused"

    problems: list[str] = []
    failed = await store.failed_count(job.id)
    if failed:
        problems.append(f"{failed} file(s) could not be stored; see the list.")
    unsplit = await store.splitting_errors(job.organization_id, EXTRACTOR)
    if unsplit:
        shown = "; ".join(unsplit[:3]) + ("; and more" if len(unsplit) > 3 else "")
        problems.append(f"{len(unsplit)} version(s) could not be split into paragraphs: {shown}.")
    if skipped:
        problems.append(
            f"{len(skipped)} version(s) were not split this time ({', '.join(skipped[:3])}); "
            "import the index again to retry."
        )
    if figures is not None and figures.unusable:
        problems.append(
            f"Pictures were not described: {figures.unusable}. Import the index again once that "
            "is fixed; only the versions with undescribed pictures are split again."
        )
    # Only a file that could not be stored fails the import: a version without paragraphs is
    # still in the library, can be opened and cited by page, and is named in the message.
    outcome: ImportStatus = "failed" if failed else "succeeded"
    await store.end_import(job.id, outcome, " ".join(problems) or None)
    return outcome


async def split_one(
    store: SplitStore,
    version: VersionToSplit,
    split: Splitter,
    figures: DescribeFigures | None,
    deadline: float,
) -> bool:
    """False if it failed for a reason that may pass; a PDF that cannot be split is recorded."""
    fresh = version.extracted_with != EXTRACTOR
    if not fresh and (figures is None or figures.unusable):
        # Listed only for pictures without a description, which cannot be described now.
        return True
    try:
        data = await store.download_pdf(version.pdf_path)
    except Exception:
        log.exception("Paragraphs of %s: download from the bucket failed", version.name)
        return False
    outcome = Outcome()
    if figures is not None and hashlib.sha256(data).hexdigest() == version.sha256:
        try:
            outcome = await figures(version.name, data, deadline)
        except Exception:
            # The paragraphs do not wait for the pictures: split without them, and count the
            # version as having some missing so a later import comes back to it.
            log.exception("Figures of %s: failed", version.name)
            outcome = Outcome(missing=max(version.figures_missing, 1))
        if not fresh and outcome.missing >= version.figures_missing:
            # Nothing new to write: the same paragraphs would be saved again.
            return True
    try:
        if hashlib.sha256(data).hexdigest() != version.sha256:
            raise ExtractionProblem("The stored PDF does not match its sha256; import it again.")
        # Splitting is CPU work (about 0.6 s per 100 pages since tables are read, #52); in a
        # thread, the request keeps streaming its heartbeat meanwhile.
        extraction = await asyncio.to_thread(split, data, outcome.descriptions)
    except ExtractionProblem as exc:
        await store.splitting_failed(version, EXTRACTOR, str(exc))
        return True
    except Exception as exc:
        # A PDF that breaks the splitter breaks it again on the next import: recorded, so the
        # import does not trip over it every time with the same extractor.
        log.exception("Paragraphs of %s: the splitter failed", version.name)
        await store.splitting_failed(
            version, EXTRACTOR, f"The splitter failed on this PDF ({type(exc).__name__})."
        )
        return True
    if extraction.version_label not in (None, version.version_label):
        # Not fatal: the paragraphs and pages are right either way, and a submission cites the
        # index's label (SYS-5). But someone should know the file and the index disagree.
        log.warning("%s: the PDF's footers say version %s", version.name, extraction.version_label)
    for warning in extraction.warnings:
        log.info("Paragraphs of %s: %s", version.name, warning)
    try:
        await store.save_paragraphs(version, EXTRACTOR, extraction)
        await store.save_figures(version, extraction.figures, outcome.missing)
    except Exception:
        log.exception("Paragraphs of %s: saving failed", version.name)
        return False
    return True


async def _store_one(
    store: LibraryStore,
    http: httpx.AsyncClient,
    settings: Settings,
    job: ImportRow,
    file: PlannedFile,
    resolve: Resolver,
    recording: asyncio.Lock,
) -> tuple[FileStatus, str | None]:
    path = file.path(job.organization_id)
    limit = settings.import_max_file_bytes
    if file.size_bytes is not None and file.size_bytes > limit:
        return "failed", f"The index says {file.size_bytes} bytes; the limit is {limit}."
    try:
        # Same file already in the library: record it again (its role or title may have changed in
        # this index) without downloading. This is what makes re-importing an index cheap.
        stored = await store.stored_file(
            job.organization_id, file.regulation_code, file.version_label
        )
        if stored is not None and stored[0] == file.sha256 and await store.object_exists(path):
            async with recording:
                await store.record_version(job, file, stored[1])
            return "unchanged", None
        data = await fetch_pdf(
            http,
            file.url,
            file.sha256,
            max_bytes=settings.import_max_file_bytes,
            timeout_s=settings.import_download_timeout_s,
            resolve=resolve,
        )
        await store.upload_pdf(path, data)
        async with recording:
            await store.record_version(job, file, len(data))
        return "stored", None
    except FileProblem as exc:
        return "failed", str(exc)
    except Exception as exc:
        # The storage API or the database refused. Logged in full here; the row gets the type,
        # which is enough to tell a network failure from a refusal without leaking a response body.
        log.exception("Import %s: %s %s", job.id, file.regulation_code, file.version_label)
        return "failed", f"Could not be stored ({type(exc).__name__})."
