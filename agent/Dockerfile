# The way out of Vercel's limits (run length, bundle size, packages that need system libraries).
# Not used by the default pipeline. Build from the agent/ folder:
#   docker build -t agent-service . && docker run --rm -p 8000:8000 --env-file .env agent-service
FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim

WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy

# Dependencies in their own layer: rebuilding after a code change does not reinstall them.
COPY pyproject.toml uv.lock .python-version ./
RUN uv sync --locked --no-dev

COPY main.py ./
COPY agent_service ./agent_service
# Certivity's checks and the files they read (certivity/README.md).
COPY certivity ./certivity

EXPOSE 8000
CMD ["uv", "run", "--no-sync", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
