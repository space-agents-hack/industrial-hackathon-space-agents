"""Entrypoint. Vercel looks for an ASGI app named `app` in a root `main.py`; keep it here."""

from agent_service.api import app

__all__ = ["app"]
