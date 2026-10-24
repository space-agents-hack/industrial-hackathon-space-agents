from dataclasses import dataclass
from functools import lru_cache
from typing import Literal

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

    # The requirement writer (domain/writer.py). Writers and check calls in flight at once: the
    # dev case is about 25 windows, so 6 reads it in about 5 rounds. Higher hits the provider's
    # rate limit before it saves time on a Tier 2 Anthropic key (an estimate, not measured: #14).
    writer_concurrency: int = 6
    # "two": per window, one agent decides clause by clause what applies, and translators write
    # each obligation, ten at a time (domain/writer.py, #48). "one": a single writer per window
    # does both, as before. Set WRITER_STAGES=one to go back without a code change if a run gets
    # too slow for run_timeout_s: two stages make about twice the calls.
    writer_stages: Literal["one", "two"] = "two"
    # One writer, check or screen call that has not answered in this long is stopped and reported
    # as failed (its window can be written again), so one stalled provider request no longer holds
    # the whole run until RUN_TIMEOUT_S kills it before `submit` (#36). Under a third of the run's
    # budget so a single stall leaves time to check and submit; above what a window takes when the
    # provider is healthy (an estimate: per-window times are not measured yet, #14).
    subagent_timeout_s: float = 240
    # Sub-goal runs (domain/subgoal.py, #42): whether reviewer agents re-read the requirements
    # whose cited paragraph changed. Off means the rules diff alone, at no model cost.
    subgoal_review: bool = True
    # The reviewer's model when the organisation chose no check model in Admin. Not the run's
    # model: that is the writer's, often the largest one, and the reviewer only compares short
    # passages. The first production run on the run's model (Opus) was slow.
    subgoal_review_model: str = "anthropic:claude-sonnet-5-5"
    # Sized for wall time, not cost (Clemente, 2026-10-24: Certivity's own run takes about a
    # minute; ten is not acceptable). 4 requirements per call keeps an answer to a few hundred
    # output tokens, and 16 calls at once put the dev case's 15 reviewed requirements, or a
    # rewritten regulation's 60, in one round. 90 s per call, one retry: a stalled call costs at
    # most 3 minutes, and then the rules' answer stands for its requirements. Estimates, not
    # measured on a real model yet.
    subgoal_review_batch: int = 4
    subgoal_review_concurrency: int = 16
    subgoal_review_timeout_s: float = 90

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
    # Files downloaded at once in an import slice (#43): a download is network time, and one at a
    # time a slice of 92 PDFs spent most of its 150 s waiting. The bucket and the source sites
    # take a few at once without complaint; tens would look like abuse to a public site.
    import_concurrency: int = 6
    # Versions split into paragraphs at once. Lower than downloads on purpose: the split is CPU
    # (one core, whatever the number), and saving one version's paragraphs already took up to
    # 6.4 s in production against the 8 s statement timeout, so several large saves at once could
    # pass it. 2 lets one version download or save while the other is split.
    split_concurrency: int = 2

    # Regulation search (domain/regulation_search.py). "openai:<model>" or "openrouter:<model>";
    # changing it starts the vectors from nothing, because vectors of two models are never compared.
    embedding_model: str = "openai:text-embedding-3-small"
    # Writes the scope summary of each regulation version, where the organisation chose no model
    # (Admin, Models). A cheap model is enough: it reads the first pages of each PDF once. It used
    # to fall back to AGENT_MODEL, which in production is Opus: about $3.50 for 92 summaries
    # instead of about $0.44 (estimate, #37). "scripted" writes none.
    summary_model: str = "anthropic:claude-haiku-5-5"
    # Same budget as an import slice, for the same reason: it fits Vercel Hobby and Pro alike.
    index_slice_s: float = 150
    # Embedding requests in flight at once (#43). One at a time, production wrote about 110
    # vectors a second, most of it waiting on the provider. A refusal for rate (429) is waited out
    # and retried, so a value too high for the key's tier is slower, not a failed slice.
    embedding_concurrency: int = 4
    # Summary calls in flight at once. Each sends about 8,000 tokens, so 4 at once is about the
    # input-tokens-per-minute of a low Anthropic tier (an estimate: the tier is per key); the
    # Anthropic client waits out a 429 and retries by itself.
    summary_concurrency: int = 4

    # The assistant's model (domain/assistant.py), where the organisation chose none (Admin,
    # Models, process "chat"). Not the run's model: an answer reads the project's rows and a few
    # paragraphs, which a small model does well, and a person asks many questions (#37).
    chat_model: str = "anthropic:claude-haiku-5-5"

    # One answer of the assistant (domain/assistant.py). A person is waiting at the keyboard;
    # the web stops waiting at 120 s, so the agent gives up first and says why.
    chat_timeout_s: float = 100


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
