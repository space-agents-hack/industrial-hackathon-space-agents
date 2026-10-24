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
