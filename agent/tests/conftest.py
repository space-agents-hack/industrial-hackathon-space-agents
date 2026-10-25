import pytest
from pydantic_ai import models

from agent_service.settings import Settings
from tests.fakes import InMemoryRunStore

# No test may reach a model provider. A test that tries fails loudly instead of spending money.
models.ALLOW_MODEL_REQUESTS = False


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
def store() -> InMemoryRunStore:
    return InMemoryRunStore()


@pytest.fixture
def settings() -> Settings:
    # Built by hand, not from the environment, so a developer's .env cannot change a test.
    return Settings(
        _env_file=None,  # pyright: ignore[reportCallIssue]
        agent_model="scripted",
        agent_shared_secret="test-secret",
        heartbeat_s=0.01,
        # No transcription model in tests; case_ingest tests pass a fake one.
        ingest_model="",
        # The assistant and the indexer on the scripted model too, unless a test chooses one.
        chat_model="scripted",
        summary_model="scripted",
        figure_model="scripted",
    )
