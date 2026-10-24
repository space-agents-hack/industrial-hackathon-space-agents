"""The sub-goal in the app: two versions of a regulation from an organisation's library and a list
of requirements derived from the older one, in, a sub-goal file out (#5, SYS-19).

The diff itself is `regdiff`; this module only fetches what it needs. The requirements come from
Certivity's `requirements_old.json` loaded into `certivity_reference` (by sub-goal case id), or
from a file the person uploaded, for a client's own requirements. The result is not stored and
not validated here: the web sends it through POST /checks, the same check every file gets.

Paragraphs come from `regulation_paragraphs`, which every import fills (#3). A version imported
before that table existed has none there; its PDF is then downloaded and extracted on the spot,
about a second for a 200-page regulation, with the same extractor.

What this does NOT do: compare two different regulations (refused), or store what it extracted on
the spot (the next import does that).
"""

import asyncio
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Protocol, cast
from uuid import UUID

from supabase import AsyncClient, acreate_client

from agent_service.domain import paragraphs, regdiff
from agent_service.domain.regulations import BUCKET

# PostgREST's page size (supabase/config.toml `max_rows`, and the hosted default).
_PAGE = 1000
# Certivity's schema allows 5,000 changes; requirements in are capped the same way so one
# request cannot keep the function busy for minutes.
MAX_REQUIREMENTS = 5000


@dataclass(frozen=True)
class StoredVersion:
    id: UUID
    organization_id: UUID
    regulation_id: UUID
    regulation: str  # "UN R175", exactly as the index wrote it
    version_label: str
    pdf_path: str


class ChangesRefused(Exception):
    """The request cannot be answered; the message is for the person and becomes a 4xx."""

    def __init__(self, message: str, status: int) -> None:
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class StoredParagraph:
    label: str
    text: str
    page_start: int


class VersionStore(Protocol):
    async def version(self, version_id: UUID) -> StoredVersion | None: ...
    # In document order, numbered ones only; empty if the version was never extracted.
    async def paragraphs(self, version_id: UUID) -> list[StoredParagraph]: ...
    async def download(self, path: str) -> bytes: ...
    async def aclose(self) -> None: ...


class SupabaseVersionStore:
    """With the secret key: the web has already shown the person these versions under RLS, and
    `build` checks again that both belong to the organisation the request names."""

    def __init__(self, client: AsyncClient) -> None:
        self._db = client

    @classmethod
    async def connect(cls, url: str, secret_key: str) -> "SupabaseVersionStore":
        return cls(await acreate_client(url, secret_key))

    async def version(self, version_id: UUID) -> StoredVersion | None:
        res = (
            await self._db.table("regulation_versions")
            .select(
                "id, organization_id, regulation_id, version_label, pdf_path, regulations(code)"
            )
            .eq("id", str(version_id))
            .limit(1)
            .execute()
        )
        rows = cast(list[dict[str, Any]], res.data)
        if not rows:
            return None
        r = rows[0]
        return StoredVersion(
            id=UUID(r["id"]),
            organization_id=UUID(r["organization_id"]),
            regulation_id=UUID(r["regulation_id"]),
            regulation=r["regulations"]["code"],
            version_label=r["version_label"],
            pdf_path=r["pdf_path"],
        )

    async def paragraphs(self, version_id: UUID) -> list[StoredParagraph]:
        out: list[StoredParagraph] = []
        start = 0
        while True:
            res = (
                await self._db.table("regulation_paragraphs")
                .select("label, text, page_start")
                .eq("version_id", str(version_id))
                .is_("superseded_at", "null")
                .not_.is_("label", "null")
                .order("position")
                .range(start, start + _PAGE - 1)
                .execute()
            )
            page = cast(list[dict[str, Any]], res.data)
            out += [StoredParagraph(r["label"], r["text"], r["page_start"]) for r in page]
            if len(page) < _PAGE:
                return out
            start += _PAGE

    async def download(self, path: str) -> bytes:
        return await self._db.storage.from_(BUCKET).download(path)

    async def aclose(self) -> None:
        await self._db.postgrest.aclose()


def subgoal_cases(reference_rows: list[dict[str, Any]]) -> list[dict[str, str | None]]:
    """The sub-goal cases whose requirements_old.json is loaded, each with the regulation its
    requirements cite most, so the page can preselect it."""
    cases: list[dict[str, str | None]] = []
    for row in sorted(reference_rows, key=lambda r: r["case_id"]):
        if row["kind"] != "requirements_old":
            continue
        cited = Counter(
            (r.get("source") or {}).get("regulation")
            for r in row["content"]
            if isinstance(r, dict) and isinstance(r.get("source"), dict)
        )
        cited.pop(None, None)
        regulation = cited.most_common(1)[0][0] if cited else None
        cases.append({"case_id": row["case_id"], "regulation": regulation})
    return cases


async def build(
    store: VersionStore,
    *,
    organization_id: UUID,
    old_version_id: UUID,
    new_version_id: UUID,
    requirements_old: list[dict[str, Any]],
    team_id: str,
    case_id: str,
) -> dict[str, Any]:
    """The sub-goal file, plus counts for the page. Raises ChangesRefused."""
    if old_version_id == new_version_id:
        raise ChangesRefused("Choose two different versions.", 400)
    if len(requirements_old) > MAX_REQUIREMENTS:
        raise ChangesRefused(f"At most {MAX_REQUIREMENTS} requirements.", 413)
    old_v, new_v = await asyncio.gather(
        store.version(old_version_id), store.version(new_version_id)
    )
    # Not found and another organisation's look the same from outside: the page offered neither.
    if (
        old_v is None
        or new_v is None
        or {old_v.organization_id, new_v.organization_id} != {organization_id}
    ):
        raise ChangesRefused("One of the versions is not in this organisation's library.", 404)
    if old_v.regulation_id != new_v.regulation_id:
        raise ChangesRefused(
            f"{old_v.regulation} and {new_v.regulation} are different regulations; the sub-goal "
            "compares two versions of the same one.",
            400,
        )
    old_p, new_p = await asyncio.gather(_paragraphs(store, old_v), _paragraphs(store, new_v))
    # Up to a few seconds of CPU on a rewritten regulation (3.3 s for R40 1.1.0 -> 2.0.0).
    changes = await asyncio.to_thread(_diff, old_p, new_p, old_v, new_v, requirements_old)
    submission = regdiff.submission(team_id, case_id, changes)
    counts = {
        kind: sum(c.change == kind for c in changes) for kind in ("modified", "removed", "added")
    }
    return {
        "submission": submission,
        "counts": counts,
        "requirements": len(requirements_old),
        "regulation": new_v.regulation,
        "old_version": old_v.version_label,
        "new_version": new_v.version_label,
    }


async def _paragraphs(
    store: VersionStore, version: StoredVersion
) -> Sequence[regdiff.ParagraphLike]:
    stored = await store.paragraphs(version.id)
    if stored:
        return stored
    pdf = await store.download(version.pdf_path)
    # CPU work of about a second; off the event loop so other requests are not held.
    extraction = await asyncio.to_thread(paragraphs.extract, pdf)
    return [p for p in extraction.paragraphs if p.label]


def _diff(
    old_p: Sequence[regdiff.ParagraphLike],
    new_p: Sequence[regdiff.ParagraphLike],
    old_v: StoredVersion,
    new_v: StoredVersion,
    requirements_old: list[dict[str, Any]],
) -> list[regdiff.Change]:
    # The names come from the library, not from the PDF: the reasons cite what the index calls
    # the regulation and the version.
    old = regdiff.build_version(old_v.regulation, old_v.version_label, old_p)
    new = regdiff.build_version(new_v.regulation, new_v.version_label, new_p)
    return regdiff.diff_versions(requirements_old, old, new)
