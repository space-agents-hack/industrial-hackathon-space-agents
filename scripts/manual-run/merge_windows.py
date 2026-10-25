"""Merge the per-window agent outputs into one Certivity main-goal submission.

Each <work_dir>/out/<name>.json is an array of {"page", "paragraph", "text", "test_case"}.
Exact duplicate texts within a regulation are dropped; --drop "<code>|<paragraph>" removes items
a reviewer judged to repeat another (passed on the command line so no regulation is named here).
--extra "<submission.json>:R-001,R-002" appends chosen items of an earlier submission, for a
reading of the case the agents' brief left out.

Usage: python3 merge_windows.py <work_dir> <team_id> <case_id> <out.json> [--drop "code|para"]...
    [--extra "file:ids"]...
"""

import json
import sys
from pathlib import Path


def main(argv: list[str]) -> None:
    drop = {argv[i + 1] for i, a in enumerate(argv) if a == "--drop"}
    extras = [argv[i + 1] for i, a in enumerate(argv) if a == "--extra"]
    work, team_id, case_id, out = argv[:4]
    jobs = json.loads((Path(work) / "jobs.json").read_text())
    reqs, seen, dropped = [], set(), 0
    for name, code, version, first, last, *_ in jobs:
        for item in json.loads((Path(work) / "out" / f"{name}.json").read_text()):
            if not first <= item["page"] <= last:
                raise SystemExit(f"{name}: page {item['page']} outside the window")
            key = (code, item["text"].strip())
            if f"{code}|{item['paragraph']}" in drop or key in seen:
                dropped += 1
                continue
            seen.add(key)
            reqs.append(
                {
                    "id": f"R-{len(reqs) + 1:03d}",
                    "text": item["text"].strip(),
                    "source": {
                        "regulation": code,
                        "version": version,
                        "page": item["page"],
                        "paragraph": item["paragraph"],
                    },
                    "test_case": item.get("test_case", "").strip(),
                }
            )
    for extra in extras:
        path, ids = extra.rsplit(":", 1)
        wanted = set(ids.split(","))
        earlier = json.loads(Path(path).read_text())["requirements"]
        for item in earlier:
            if item["id"] not in wanted:
                continue
            key = (item["source"]["regulation"], item["text"].strip())
            if key in seen:
                continue
            seen.add(key)
            reqs.append({**item, "id": f"R-{len(reqs) + 1:03d}"})
    doc = {"team_id": team_id, "case_id": case_id, "requirements": reqs}
    Path(out).write_text(json.dumps(doc, indent=2, ensure_ascii=False))
    print(f"{len(reqs)} requirements, {dropped} dropped")


if __name__ == "__main__":
    main(sys.argv[1:])
