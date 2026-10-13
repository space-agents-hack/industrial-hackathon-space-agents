from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Everything the service reads from the environment. Provider API keys are not here: the
    agent library reads ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY and DEEPSEEK_API_KEY
    itself, according to the prefix of `agent_model`."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # "provider:model", e.g. "anthropic:claude-opus-5-5". "scripted" plays the example task with
    # no provider and no network, which is also the fallback if the venue network fails mid-demo.
    agent_model: str = "scripted"

    # Shared with the web server. Unset means the service refuses to advance runs.
    agent_shared_secret: str | None = None

    supabase_url: str | None = None
    supabase_secret_key: str | None = None

    # Below the platform's hard limit (300 s on Vercel Hobby, 800 s on Pro) so a slow run ends as
    # a recorded failure instead of a killed function that leaves the run looking alive.
    run_timeout_s: float = 270
    # A loop that keeps calling tools without converging stops here instead of at the bill.
    max_model_requests: int = 30
    heartbeat_s: float = 10
    # A run marked running whose heartbeat is older than this is treated as dead.
    stale_after_s: float = 60


@lru_cache
def get_settings() -> Settings:
    return Settings()
