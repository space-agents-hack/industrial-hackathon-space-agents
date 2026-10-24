from dataclasses import dataclass
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict

from agent_service.records import OrganizationSettings


class Settings(BaseSettings):
    """Everything the service reads from the environment, and the defaults for every organisation
    that has not changed them (see `effective`). Provider API keys are not here: an organisation's
    own key comes from the database at run time, and without one the agent library reads
    ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY or DEEPSEEK_API_KEY itself, according to
    the prefix of the model."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # "provider:model", e.g. "anthropic:claude-opus-5-5". "scripted" plays the example task with
    # no provider and no network, which is also the fallback if the venue network fails mid-demo.
    agent_model: str = "scripted"

    # Shared with the web server. Unset means the service refuses to advance runs.
    agent_shared_secret: str | None = None

    supabase_url: str | None = None
    supabase_secret_key: str | None = None

    # Below the platform's hard limit (800 s on Vercel Pro, which this project uses; `maxDuration`
    # in vercel.json) so a slow run ends as a recorded failure instead of a killed function that
    # leaves the run looking alive. On Hobby the limit is 300 s: set RUN_TIMEOUT_S=270 there.
    run_timeout_s: float = 770
    # A loop that keeps calling tools without converging stops here instead of at the bill.
    max_model_requests: int = 30
    # Spending per organisation and calendar month (UTC), from the cost recorded on each run. None
    # means no cap.
    monthly_cost_cap_usd: float | None = None
    heartbeat_s: float = 10
    # A run marked running whose heartbeat is older than this is treated as dead.
    stale_after_s: float = 60

    # Case ingestion (domain/case_ingest.py): the model that reads what the parsers cannot (a
    # scanned page, a drawing, a file a parser fails on). Small and cheap on purpose: it
    # transcribes, it does not reason. Empty or "scripted" means no fallback: the trace says what
    # was left unread instead.
    ingest_model: str = "anthropic:claude-haiku-5-5"
    # Model transcriptions per file. A 200-page scan would otherwise cost 200 calls and outlast
    # the function; the rest is reported as not transcribed.
    ingest_max_model_pages: int = 12

    # Regulation imports (domain/regulations.py). One request starts new files for this long, then
    # leaves the import paused for the next request. The worst case is a file started just before
    # the end: 2 attempts of import_download_timeout_s plus its upload, about 260 s in all. That
    # fits Vercel Hobby's 300 s as well as Pro's 800 s, and keeps progress visible between slices.
    import_slice_s: float = 150
    import_download_timeout_s: float = 45
    # An import heartbeats after every file; longer than one download can take.
    import_stale_after_s: float = 150
    # The bucket's limit, which is the Supabase free plan's limit per file.
    import_max_file_bytes: int = 50 * 1024 * 1024

    # Regulation search (domain/regulation_search.py). "openai:<model>" or "openrouter:<model>";
    # changing it starts the vectors from nothing, because vectors of two models are never compared.
    embedding_model: str = "openai:text-embedding-3-small"
    # Writes the scope summary of each regulation version. None uses AGENT_MODEL. A cheap model is
    # enough: it reads the first pages of 92 PDFs once.
    summary_model: str | None = None
    # Same budget as an import slice, for the same reason: it fits Vercel Hobby and Pro alike.
    index_slice_s: float = 150


@dataclass(frozen=True)
class RunSettings:
    """What one run uses: the organisation's value where it set one, else the service's."""

    model: str
    max_model_requests: int
    monthly_cost_cap_usd: float | None


def effective(settings: Settings, org: OrganizationSettings | None) -> RunSettings:
    org = org or OrganizationSettings()

    def pick[T](own: T | None, default: T) -> T:
        # `is None`, not `or`: a cap of 0 is a real choice ("spend nothing"), not "unset".
        return default if own is None else own

    return RunSettings(
        model=pick(org.model, settings.agent_model),
        max_model_requests=pick(org.max_model_requests, settings.max_model_requests),
        monthly_cost_cap_usd=pick(org.monthly_cost_cap_usd, settings.monthly_cost_cap_usd),
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
