"""Who spent which tokens on which model, with which key (docs/se SYS-40, issue #29). Every model
the agent builds is wrapped in `MeteredModel`, and the two embedding calls report to the same
`Meter`; the meter is written to `model_usage` once per piece of work (a run segment, a case
ingest, an index slice), which is what Admin, Usage and the monthly cap read.

Recorded per request as the response arrives, not from the run's result at the end: a run that
fails or times out has no result, and its tokens were spent all the same.

What this does NOT do: know the provider's bill. The cost is genai-prices' estimate from public
price lists; a model it does not know is recorded with no cost and counted in
`unpriced_requests`, so the page can say the total is a lower bound instead of showing $0.
"""

import logging
from collections.abc import AsyncGenerator, Awaitable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, Literal, Protocol
from uuid import UUID

from genai_prices import Usage, calc_price
from pydantic_ai import RunContext
from pydantic_ai.messages import ModelMessage, ModelResponse
from pydantic_ai.models import Model, ModelRequestParameters, StreamedResponse
from pydantic_ai.models.wrapper import WrapperModel
from pydantic_ai.settings import ModelSettings

log = logging.getLogger(__name__)

# The processes of organization_models plus those with no setting of their own: the run's model
# ("writer"), the query vector of a search during a run, and the run page's chat (#28). The
# database checks the same list (migration 20261024300000_model_usage).
Process = Literal[
    "writer", "check", "transcription", "summary", "embedding", "search", "chat", "figures"
]
KeySource = Literal["organization", "deployment", "server"]

# What the agent library reads when the organisation connected no key (settings.py says the same).
ENV_KEYS = {
    "anthropic": "ANTHROPIC_API_KEY",
    "openai": "OPENAI_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
    "ollama": "OLLAMA_BASE_URL",
}
# Runs on the organisation's own hardware: the provider bills nothing. Recorded as $0 rather than
# "no price", which would make every Ollama total read as a lower bound.
FREE_PROVIDERS = frozenset({"ollama"})


@dataclass(frozen=True)
class Credential:
    """Which key paid, in words a person can match with Admin, Providers. Never the key itself."""

    source: KeySource
    hint: str | None = None

    @classmethod
    def of(cls, provider: str, key: str | None, server_url: str | None = None) -> "Credential":
        if server_url:
            return cls("server", server_url)
        if key:
            # The same last 4 set_provider_key stores and the providers page shows.
            return cls("organization", key[-4:])
        return cls("deployment", ENV_KEYS.get(provider))

    @classmethod
    def for_model(cls, name: str, key: str | None, server_url: str | None) -> "Credential":
        """For a "provider:model" name and what providers.credentials() returned for it."""
        return cls.of(name.partition(":")[0], key, server_url)


@dataclass
class _Line:
    requests: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    cost: Decimal | None = None
    unpriced_requests: int = 0


@dataclass
class Meter:
    """The usage of one piece of work, summed per process, model and key until it is written."""

    organization_id: UUID
    run_id: UUID | None = None
    case_id: UUID | None = None
    _lines: dict[tuple[Process, str, str, Credential], _Line] = field(
        default_factory=dict[tuple[Process, str, str, Credential], _Line]
    )

    def add(
        self,
        process: Process,
        model: str,
        credential: Credential,
        *,
        input_tokens: int = 0,
        output_tokens: int = 0,
        cache_read_tokens: int = 0,
        cache_write_tokens: int = 0,
        cost: Decimal | None,
    ) -> None:
        provider = model.partition(":")[0] or "unknown"
        if provider in FREE_PROVIDERS:
            cost = Decimal(0)
        line = self._lines.setdefault((process, provider, model, credential), _Line())
        line.requests += 1
        line.input_tokens += input_tokens
        line.output_tokens += output_tokens
        line.cache_read_tokens += cache_read_tokens
        line.cache_write_tokens += cache_write_tokens
        if cost is None:
            line.unpriced_requests += 1
        else:
            line.cost = (line.cost or Decimal(0)) + cost

    def take(self) -> list[dict[str, Any]]:
        """The rows for model_usage, and an empty meter: writing twice never counts twice."""
        now = datetime.now(UTC).isoformat()
        rows = [
            {
                "organization_id": str(self.organization_id),
                "created_at": now,
                "process": process,
                "provider": provider,
                "model": model,
                "key_source": credential.source,
                "key_hint": credential.hint,
                "run_id": str(self.run_id) if self.run_id else None,
                "case_id": str(self.case_id) if self.case_id else None,
                "requests": line.requests,
                "input_tokens": line.input_tokens,
                "output_tokens": line.output_tokens,
                "cache_read_tokens": line.cache_read_tokens,
                "cache_write_tokens": line.cache_write_tokens,
                # numeric(20, 10), the column's own precision (migration 20261024300000).
                "cost_usd": float(round(line.cost, 10)) if line.cost is not None else None,
                "unpriced_requests": line.unpriced_requests,
            }
            for (process, provider, model, credential), line in self._lines.items()
        ]
        self._lines.clear()
        return rows

    async def flush(self, sink: "UsageSink") -> None:
        """Write what was used since the last flush. A failure is logged, never raised: losing a
        usage row must not fail the run that spent it."""
        rows = self.take()
        if not rows:
            return
        try:
            await sink.record_usage(rows)
        except Exception:
            log.exception(
                "could not record %d usage row(s) for %s", len(rows), self.organization_id
            )


class UsageSink(Protocol):
    def record_usage(self, rows: list[dict[str, Any]]) -> Awaitable[None]: ...


def response_cost(response: ModelResponse) -> Decimal | None:
    """The library's own estimate for this response, or None when the price list does not know the
    model. The library fills `usage.cost` only after the model returns, so it is computed here."""
    if response.usage.cost is not None:
        return response.usage.cost
    try:
        return response.cost().total_price
    except Exception:
        # LookupError for an unknown model, ValueError for usage it cannot price. Pricing never
        # fails a run.
        return None


def embedding_cost(provider: str, model: str, tokens: int) -> Decimal | None:
    """Embeddings bill input tokens only. OpenRouter passes OpenAI's models through at OpenAI's
    price, and genai-prices lists them under OpenAI only ("openai/text-embedding-3-small")."""
    attempts = [(provider, model)]
    if provider == "openrouter" and "/" in model:
        attempts.append(tuple(model.split("/", 1)))  # pyright: ignore[reportArgumentType]
    for provider_id, name in attempts:
        try:
            return calc_price(Usage(input_tokens=tokens), name, provider_id=provider_id).total_price
        except Exception:
            continue
    return None


class MeteredModel(WrapperModel):
    """A model that reports each response's tokens and cost to a meter, under the model name the
    organisation chose ("anthropic:claude-opus-5-5") and the key it was built with."""

    def __init__(
        self,
        wrapped: Model | str,
        meter: Meter,
        process: Process,
        name: str,
        credential: Credential,
    ) -> None:
        super().__init__(wrapped)  # pyright: ignore[reportArgumentType]
        self.meter = meter
        self.process: Process = process
        self.name = name
        self.credential = credential

    def as_process(self, process: Process) -> "MeteredModel":
        """The same model and key counted under another process: the check agent runs on the
        run's model when the organisation chose no check model of its own."""
        return MeteredModel(self.wrapped, self.meter, process, self.name, self.credential)

    def _record(self, response: ModelResponse) -> None:
        usage = response.usage
        self.meter.add(
            self.process,
            self.name,
            self.credential,
            input_tokens=usage.input_tokens,
            output_tokens=usage.output_tokens,
            cache_read_tokens=usage.cache_read_tokens,
            cache_write_tokens=usage.cache_write_tokens,
            cost=response_cost(response),
        )

    async def request(
        self,
        messages: list[ModelMessage],
        model_settings: ModelSettings | None,
        model_request_parameters: ModelRequestParameters,
    ) -> ModelResponse:
        response = await self.wrapped.request(messages, model_settings, model_request_parameters)
        self._record(response)
        return response

    @asynccontextmanager
    async def request_stream(
        self,
        messages: list[ModelMessage],
        model_settings: ModelSettings | None,
        model_request_parameters: ModelRequestParameters,
        run_context: RunContext[Any] | None = None,
    ) -> AsyncGenerator[StreamedResponse]:
        async with self.wrapped.request_stream(
            messages, model_settings, model_request_parameters, run_context
        ) as stream:
            try:
                yield stream
            finally:
                # Also when the stream is cut off (a timeout): the tokens received so far were
                # billed. A broken stream must not hide the error that broke it.
                try:
                    self._record(stream.get())
                except Exception:
                    log.exception("could not meter a streamed response of %s", self.name)


def metered(
    model: Model | str,
    meter: Meter | None,
    process: Process,
    name: str,
    credential: Credential,
) -> Model | str:
    """`model`, metered when there is a meter and the model has a provider. The scripted model has
    none: it costs nothing and its token counts are made up."""
    if meter is None or ":" not in name:
        return model
    try:
        return MeteredModel(model, meter, process, name, credential)
    except Exception:
        # A name with no key behind it cannot be built until it is called, and then fails with a
        # message that says which key is missing. Unmetered, it still fails there, the same way;
        # it never reaches a provider, so nothing goes uncounted.
        return model
