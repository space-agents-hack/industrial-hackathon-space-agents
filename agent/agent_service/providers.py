"""Model providers: building a model with an organisation's own key, checking a key, and listing
what a provider offers. The model string is always "provider:model", as in AGENT_MODEL.

What this does NOT do: store keys (the database does, in Vault), or decide who may see a model
list (the web checks the person's role before it calls the agent).
"""

import time
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any, Literal, get_args

import httpx
from genai_prices import Usage, calc_price
from pydantic_ai.models import Model
from pydantic_ai.models.anthropic import AnthropicModel
from pydantic_ai.models.openai import OpenAIChatModel, OpenAIResponsesModel
from pydantic_ai.models.openrouter import OpenRouterModel
from pydantic_ai.providers.anthropic import AnthropicProvider
from pydantic_ai.providers.deepseek import DeepSeekProvider
from pydantic_ai.providers.openai import OpenAIProvider
from pydantic_ai.providers.openrouter import OpenRouterProvider

from agent_service import domain

Provider = Literal["anthropic", "openai", "openrouter", "deepseek"]
PROVIDERS: tuple[Provider, ...] = get_args(Provider)

TIMEOUT_S = 10
# The catalogue changes a few times a day; one fetch per instance every ten minutes keeps the
# settings page fast without showing a model that was withdrawn this morning for long.
CATALOGUE_TTL_S = 600

_ANTHROPIC_VERSION = "2023-06-01"
REDACTED = "[redacted]"


def provider_of(model: str) -> Provider | None:
    """The provider whose key this model needs, or None (scripted, or a provider this layer does
    not manage keys for, which then reads its key from the environment as before)."""
    prefix, sep, _ = model.partition(":")
    return next((p for p in PROVIDERS if sep and p == prefix), None)


def build_model(name: str, api_key: str | None) -> Model | str:
    """With a key, the model is built around it explicitly. Without one, the name goes to the
    library as before and it reads the provider's environment variable, so a deployment that only
    has keys in Vercel keeps working."""
    provider = provider_of(name)
    if api_key is None or provider is None:
        return domain.resolve_model(name)
    model_name = name.partition(":")[2]
    # The same classes the library picks for these prefixes (tests/test_providers.py checks it),
    # so a run behaves the same with the organisation's key as with the environment's.
    match provider:
        case "anthropic":
            return AnthropicModel(model_name, provider=AnthropicProvider(api_key=api_key))
        case "openai":
            return OpenAIResponsesModel(model_name, provider=OpenAIProvider(api_key=api_key))
        case "openrouter":
            return OpenRouterModel(model_name, provider=OpenRouterProvider(api_key=api_key))
        case "deepseek":
            return OpenAIChatModel(model_name, provider=DeepSeekProvider(api_key=api_key))


def scrub(text: str, secret: str | None) -> str:
    # Providers' error messages are copied into the run for people to read. Most do not quote the
    # key, but nothing guarantees it, and the run's error is visible to every member.
    return text.replace(secret, REDACTED) if secret else text


# ------------------------------------------------------------------------------------------
# Checking a key and listing models. Every call goes through an httpx client the caller owns, so
# tests pass one on a mock transport and no test reaches the network.
# ------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Check:
    ok: bool
    detail: str


@dataclass(frozen=True)
class ModelOption:
    id: str
    label: str
    prompt_usd_per_mtok: float | None
    completion_usd_per_mtok: float | None


class ProviderError(Exception):
    """The provider could not be reached or refused. The message never contains the key."""


class KeyRejected(ProviderError):
    pass


def _auth(provider: Provider, api_key: str) -> dict[str, str]:
    if provider == "anthropic":
        return {"x-api-key": api_key, "anthropic-version": _ANTHROPIC_VERSION}
    return {"Authorization": f"Bearer {api_key}"}


# One cheap authenticated call each. OpenRouter's model list is public, so it would accept any
# key; /key is the endpoint that actually reads it.
_CHECK_URLS: dict[Provider, str] = {
    "anthropic": "https://api.anthropic.com/v1/models",
    "openai": "https://api.openai.com/v1/models",
    "openrouter": "https://openrouter.ai/api/v1/key",
    "deepseek": "https://api.deepseek.com/models",
}

_LIST_URLS: dict[Provider, str] = {
    # The default page is 20 models; 1000 is the maximum and covers the whole list.
    "anthropic": "https://api.anthropic.com/v1/models?limit=1000",
    "openai": "https://api.openai.com/v1/models",
    "deepseek": "https://api.deepseek.com/models",
}

_OPENROUTER_CATALOGUE = "https://openrouter.ai/api/v1/models"


async def _get(
    http: httpx.AsyncClient, url: str, provider: Provider, api_key: str | None
) -> httpx.Response:
    headers = _auth(provider, api_key) if api_key else {}
    try:
        response = await http.get(url, headers=headers, timeout=TIMEOUT_S)
    except httpx.TimeoutException:
        raise ProviderError(f"{provider} did not answer within {TIMEOUT_S} s.") from None
    except httpx.HTTPError as exc:
        reason = scrub(f"{type(exc).__name__}: {exc}", api_key)[:200]
        raise ProviderError(f"Could not reach {provider} ({reason}).") from None
    if response.status_code in (401, 403):
        raise KeyRejected("The provider rejected this key.")
    if response.is_error:
        raise ProviderError(f"{provider} answered {response.status_code}.")
    return response


async def check_key(http: httpx.AsyncClient, provider: Provider, api_key: str) -> Check:
    try:
        await _get(http, _CHECK_URLS[provider], provider, api_key)
    except ProviderError as exc:
        return Check(False, str(exc))
    return Check(True, "The provider accepted this key.")


async def list_models(
    http: httpx.AsyncClient, provider: Provider, api_key: str
) -> list[ModelOption]:
    """Anthropic, OpenAI and DeepSeek, with the organisation's key. Prices come from the same
    price list the runner uses to record each run's cost, so what the settings page shows is what
    the monthly cap will count; None where that list does not know the model."""
    response = await _get(http, _LIST_URLS[provider], provider, api_key)
    try:
        data: list[dict[str, Any]] = response.json()["data"]
    except (ValueError, KeyError, TypeError):
        raise ProviderError(f"{provider} answered with a list this service cannot read.") from None
    options = []
    for item in data:
        model_id = item.get("id")
        if not isinstance(model_id, str) or not _is_chat_model(provider, model_id):
            continue
        prompt, completion = _known_prices(provider, model_id)
        options.append(
            ModelOption(
                id=f"{provider}:{model_id}",
                label=str(item.get("display_name") or model_id),
                prompt_usd_per_mtok=prompt,
                completion_usd_per_mtok=completion,
            )
        )
    return _sorted(options)


# OpenAI lists every model the key can use, including ones that cannot hold a conversation with
# tools. Offering them would let an admin save a model on which every run fails. A list of
# exclusions, not inclusions, so a new chat family shows up without a code change.
_OPENAI_NOT_CHAT = (
    "embedding",
    "whisper",
    "tts",
    "dall-e",
    "image",
    "moderation",
    "davinci",
    "babbage",
    "audio",
    "realtime",
    "transcribe",
    "sora",
)


def _is_chat_model(provider: Provider, model_id: str) -> bool:
    return provider != "openai" or not any(word in model_id for word in _OPENAI_NOT_CHAT)


def _known_prices(provider: Provider, model_id: str) -> tuple[float | None, float | None]:
    try:
        prompt = calc_price(Usage(input_tokens=1_000_000), model_id, provider_id=provider)
        completion = calc_price(Usage(output_tokens=1_000_000), model_id, provider_id=provider)
    except LookupError:
        return None, None
    return float(prompt.total_price), float(completion.total_price)


_catalogue: tuple[float, list[ModelOption]] | None = None


def clear_catalogue_cache() -> None:
    global _catalogue
    _catalogue = None


async def openrouter_catalogue(http: httpx.AsyncClient) -> list[ModelOption]:
    """OpenRouter's public list, with its own prices. Needs no key."""
    global _catalogue
    if _catalogue is not None and time.monotonic() - _catalogue[0] < CATALOGUE_TTL_S:
        return _catalogue[1]
    response = await _get(http, _OPENROUTER_CATALOGUE, "openrouter", None)
    try:
        data: list[dict[str, Any]] = response.json()["data"]
    except (ValueError, KeyError, TypeError):
        raise ProviderError("openrouter answered with a list this service cannot read.") from None
    options = []
    for item in data:
        pricing = item.get("pricing") or {}
        prompt = _per_mtok(pricing.get("prompt"))
        completion = _per_mtok(pricing.get("completion"))
        model_id = item.get("id")
        # Negative prices mark routers whose price depends on the model they pick (e.g.
        # openrouter/auto); without a price the cap cannot be honoured, so they are left out.
        if not isinstance(model_id, str) or prompt is None or completion is None:
            continue
        options.append(
            ModelOption(
                id=f"openrouter:{model_id}",
                label=str(item.get("name") or model_id),
                prompt_usd_per_mtok=prompt,
                completion_usd_per_mtok=completion,
            )
        )
    options = _sorted(options)
    _catalogue = (time.monotonic(), options)
    return options


def _per_mtok(per_token: object) -> float | None:
    # Decimal, not float: "0.000003" * 1e6 in floats is 2.9999999999999996.
    try:
        value = Decimal(str(per_token)) * 1_000_000
    except InvalidOperation:
        return None
    if not value.is_finite() or value < 0:
        return None
    return float(value)


def _sorted(options: list[ModelOption]) -> list[ModelOption]:
    return sorted(options, key=lambda o: (o.label.casefold(), o.id))
