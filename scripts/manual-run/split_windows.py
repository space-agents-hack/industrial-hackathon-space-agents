"""Cut regulation PDFs into page windows for the manual parallel-agent run.

Not part of the product: the held-out file of 2026-10-25 was built by hand, one agent per
window, outside the pipeline (Clemente's order, 08:08Z). This script and merge_windows.py are
here so that file traces to a commit. Nothing from the case or the regulations is stored here.

Usage: python3 split_windows.py <work_dir> <code>=<version>=<pdf> ... [--size 12]
Writes <work_dir>/win/<name>.txt (pages marked "PAGE n") and <work_dir>/jobs.json.
"""

import json
import subprocess
import sys
from pathlib import Path


def pages(pdf: Path) -> list[str]:
    text = subprocess.run(
        ["pdftotext", "-layout", str(pdf), "-"], check=True, capture_output=True, text=True
    ).stdout
    return text.split("\f")[:-1] if text.endswith("\f") else text.split("\f")


def main(argv: list[str]) -> None:
    size = 12
    if "--size" in argv:
        i = argv.index("--size")
        size = int(argv[i + 1])
        del argv[i : i + 2]
    work = Path(argv[0])
    (work / "win").mkdir(parents=True, exist_ok=True)
    jobs = []
    for spec in argv[1:]:
        code, version, pdf = spec.split("=", 2)
        texts = pages(Path(pdf))
        for a in range(1, len(texts) + 1, size):
            b = min(a + size - 1, len(texts))
            name = f"{code.replace(' ', '_')}_p{a:03d}-{b:03d}"
            body = "".join(f"\n===== PAGE {n} =====\n{texts[n - 1]}" for n in range(a, b + 1))
            (work / "win" / f"{name}.txt").write_text(body)
            jobs.append([name, code, version, a, b, 0, len(body)])
    (work / "jobs.json").write_text(json.dumps(jobs))
    print(f"{len(jobs)} windows")


if __name__ == "__main__":
    main(sys.argv[1:])
