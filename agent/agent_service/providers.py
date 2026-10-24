"""Model providers: building a model with an organisation's own key, checking a key, and listing
what a provider offers. The model string is always "provider:model", as in AGENT_MODEL.

Ollama is the one provider that is not a hosted API with a key: it is a server the organisation
runs itself (SYS-30), reached at the URL it gave in Admin, sometimes behind a proxy that wants a
bearer token or a user name and password. That is an `Endpoint`, not a key.

What this does NOT do: store keys (the database does, in Vault), or decide who may see a model
list (the web checks the person's role before it calls the agent).
"""

import base64
import time
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any, Literal, Protocol, get_args
from uuid import UUID

import httpx
from genai_prices import Usage, calc_price
from openai import AsyncOpenAI
from pydantic_ai.models import Model
from pydantic_ai.models.anthropic import AnthropicModel
from pydantic_ai.models.openai import OpenAIChatModel, OpenAIResponsesModel
from pydantic_ai.models.openrouter import OpenRouterModel
from pydantic_ai.providers.anthropic import AnthropicProvider
from pydantic_ai.providers.deepseek import DeepSeekProvider
from pydantic_ai.providers.ollama import OllamaProvider
from pydantic_ai.providers.openai import OpenAIProvider
from pydantic_ai.providers.openrouter import OpenRouterProvider

from agent_service import domain

Provider = Literal["anthropic", "openai", "openrouter", "deepseek", "ollama"]
PROVIDERS: tuple[Provider, ...] = get_args(Provider)
# The ones configured with a URL instead of a key.
ENDPOINT_PROVIDERS: tuple[Provider, ...] = ("ollama",)
AuthScheme = Literal["none", "bearer", "basic"]

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


@dataclass(frozen=True)
class Endpoint:
    """A self-hosted server as Admin, Providers stored it (public.read_provider_endpoint)."""

    base_url: str
    auth_scheme: AuthScheme = "none"
    username: str | None = None
    secret: str | None = None

    def headers(self) -> dict[str, str]:
        if self.auth_scheme == "bearer" and self.secret:
            return {"Authorization": f"Bearer {self.secret}"}
        if self.auth_scheme == "basic" and self.secret:
            pair = f"{self.username or ''}:{self.secret}".encode()
            return {"Authorization": f"Basic {base64.b64encode(pair).decode()}"}
        return {}

    def root(self) -> str:
        # People paste what their tools showed them: the server ("http://host:11434"), the
        # OpenAI-compatible path (".../v1") or the native one (".../api"). All mean the server.
        url = self.base_url.strip().rstrip("/")
        for suffix in ("/v1", "/api"):
            if url.endswith(suffix):
                url = url[: -len(suffix)]
        return url


class CredentialStore(Protocol):
    async def provider_key(self, org: UUID, provider: str) -> str | None: ...
    async def provider_endpoint(self, org: UUID, provider: str) -> Endpoint | None: ...


async def credentials(
    store: CredentialStore, org: UUID, name: str
) -> tuple[str | None, Endpoint | None]:
    """What `build_model` needs for this model: the organisation's key, or its server for Ollama.
    The first value is also the one secret every error message must be scrubbed of."""
    provider = provider_of(name)
    if provider is None:
        return None, None
    if provider in ENDPOINT_PROVIDERS:
        endpoint = await store.provider_endpoint(org, provider)
        return (endpoint.secret if endpoint else None), endpoint
    return await store.provider_key(org, provider), None


def build_model(name: str, api_key: str | None, endpoint: Endpoint | None = None) -> Model | str:
    """With a key, the model is built around it explicitly. Without one, the name goes to the
    library as before and it reads the provider's environment variable, so a deployment that only
    has keys in Vercel keeps working (for Ollama, OLLAMA_BASE_URL: handy when the agent runs on
    the same machine as the server)."""
    provider = provider_of(name)
    model_name = name.partition(":")[2]
    if provider == "ollama" and endpoint is not None:
        return _ollama_model(model_name, endpoint)
    if api_key is None or provider is None or provider in ENDPOINT_PROVIDERS:
        return domain.resolve_model(name)
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
        case "ollama":  # pragma: no cover - returned above
            raise AssertionError(provider)


def _ollama_model(
    model_name: str, endpoint: Endpoint, http_client: httpx.AsyncClient | None = None
) -> Model:
    # The OpenAI client sends "Bearer <api_key>" on every request: Ollama ignores it, a proxy in
    # front reads it. For basic auth the header is set as a default, which the client lets win
    # over its own, so exactly one Authorization header leaves with each call
    # (tests/test_providers.py looks at what goes out).
    client = AsyncOpenAI(
        base_url=f"{endpoint.root()}/v1",
        # The client refuses an empty key; Ollama without a proxy needs none.
        api_key=endpoint.secret if endpoint.auth_scheme == "bearer" and endpoint.secret else "none",
        default_headers=endpoint.headers() or None,
        http_client=http_client,  # pyright: ignore[reportArgumentType]
    )
    return OpenAIChatModel(model_name, provider=OllamaProvider(openai_client=client))


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
    http: httpx.AsyncClient,
    url: str,
    provider: Provider,
    api_key: str | None,
    *,
    endpoint: Endpoint | None = None,
) -> httpx.Response:
    if endpoint is not None:
        headers, secret = endpoint.headers(), endpoint.secret
    else:
        headers, secret = (_auth(provider, api_key) if api_key else {}), api_key
    try:
        response = await http.get(url, headers=headers, timeout=TIMEOUT_S)
    except httpx.TimeoutException:
        raise ProviderError(f"{provider} did not answer within {TIMEOUT_S} s.") from None
    except httpx.HTTPError as exc:
        reason = scrub(f"{type(exc).__name__}: {exc}", secret)[:200]
        raise ProviderError(f"Could not reach {provider} ({reason}).") from None
    if response.status_code in (401, 403):
        raise KeyRejected(
            "The server refused these credentials."
            if endpoint is not None
            else "The provider rejected this key."
        )
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


# ------------------------------------------------------------------------------------------
# Ollama. Its native /api/tags lists what is pulled on the server; it is also the cheapest call
# that goes through a proxy's authentication, so it serves as the check too. What comes back is
# never quoted to the person: the URL is the admin's to choose, and echoing whatever answers at
# it would turn this into a way to read pages the agent can reach and the admin cannot.
# ------------------------------------------------------------------------------------------


async def check_endpoint(http: httpx.AsyncClient, endpoint: Endpoint) -> Check:
    try:
        models = await ollama_models(http, endpoint)
    except ProviderError as exc:
        return Check(False, str(exc))
    if not models:
        return Check(True, "The server answered, but has no chat models pulled yet.")
    return Check(True, f"The server answered with {len(models)} chat model(s).")


async def ollama_models(http: httpx.AsyncClient, endpoint: Endpoint) -> list[ModelOption]:
    """The chat models pulled on the server, free: the organisation runs the hardware, so the
    monthly cap counts nothing for them."""
    response = await _get(http, f"{endpoint.root()}/api/tags", "ollama", None, endpoint=endpoint)
    try:
        data: list[dict[str, Any]] = response.json()["models"]
    except (ValueError, KeyError, TypeError):
        raise ProviderError(
            "The server answered, but not like Ollama. Check the URL and port."
        ) from None
    options = []
    for item in data:
        name = item.get("model") or item.get("name")
        if not isinstance(name, str) or not name or _is_embedding(item):
            continue
        size = (item.get("details") or {}).get("parameter_size")
        options.append(
            ModelOption(
                id=f"ollama:{name}",
                label=f"{name} ({size})" if isinstance(size, str) and size else name,
                prompt_usd_per_mtok=0.0,
                completion_usd_per_mtok=0.0,
            )
        )
    return _sorted(options)


def _is_embedding(item: dict[str, Any]) -> bool:
    # An embedding model cannot hold a conversation; offering it lets an admin save a model on
    # which every run fails. Ollama has no "kind" field, so the name and the BERT family (what
    # nomic-embed-text, mxbai-embed-large and all-minilm are built on) are the signs.
    details = item.get("details") or {}
    families = [details.get("family"), *(details.get("families") or [])]
    name = str(item.get("model") or item.get("name") or "")
    return "embed" in name or any(isinstance(f, str) and "bert" in f for f in families)


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
