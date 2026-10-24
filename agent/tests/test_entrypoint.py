import subprocess
import sys
from pathlib import Path


def test_main_imports_in_a_fresh_interpreter() -> None:
    # Vercel imports main.py first and nothing else. Inside pytest the store or the domain is
    # usually imported before it, which hid a circular import that took the release of 797bb0a
    # down with a 500 on /health.
    result = subprocess.run(
        [sys.executable, "-c", "import main"],
        cwd=Path(__file__).parents[1],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, result.stderr
