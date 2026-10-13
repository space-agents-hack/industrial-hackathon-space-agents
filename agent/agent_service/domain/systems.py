"""Stand-ins for the company systems the agent calls (PLM, CAD, ERP), backed by one JSON file.

This is the part a real project replaces: keep the method names, point them at the partner's
API. Everything here is deterministic on purpose, so it can be unit-tested without a model and
the agent's answers can be checked against known numbers.

What it does NOT do: persist writes. `set_ecn_status` changes this object in memory and is gone
when the request ends.
"""

import json
from copy import deepcopy
from pathlib import Path
from typing import Any

_FIXTURE = Path(__file__).parent / "fixtures" / "plant.json"

ECN_STATUSES = ("open", "hold", "released", "rejected")


class UnknownRecord(LookupError):
    """The id does not exist. Tools turn this into a retry so the model can correct itself."""


class Systems:
    def __init__(self, data: dict[str, Any]) -> None:
        self._data = deepcopy(data)

    @classmethod
    def from_fixture(cls, path: Path = _FIXTURE) -> "Systems":
        return cls(json.loads(path.read_text()))

    def get_ecn(self, ecn_id: str) -> dict[str, Any]:
        ecn = self._data["ecns"].get(ecn_id)
        if ecn is None:
            raise UnknownRecord(f"No ECN with id {ecn_id!r}. Known: {sorted(self._data['ecns'])}.")
        return {"ecn_id": ecn_id, **ecn}

    def affected_assemblies(self, part_id: str) -> list[dict[str, Any]]:
        self._require_part(part_id)
        return [
            {"assembly_id": assembly_id, "name": a["name"], "qty": a["uses"][part_id]["qty"]}
            for assembly_id, a in self._data["assemblies"].items()
            if part_id in a["uses"]
        ]

    def check_fit(self, assembly_id: str, part_id: str, new_value_mm: float) -> dict[str, Any]:
        """Does the part still fit in the assembly at its new dimension?

        The part grows by (new - nominal) into the free clearance recorded for that assembly.
        It fits if what is left is at least the plant's minimum clearance.
        """
        part = self._require_part(part_id)
        assembly = self._data["assemblies"].get(assembly_id)
        if assembly is None:
            raise UnknownRecord(f"No assembly with id {assembly_id!r}.")
        usage = assembly["uses"].get(part_id)
        if usage is None:
            raise UnknownRecord(f"Assembly {assembly_id} does not use part {part_id}.")

        growth = new_value_mm - part["nominal_mm"]
        remaining = round(usage["free_clearance_mm"] - growth, 3)
        minimum = self._data["min_clearance_mm"]
        return {
            "assembly_id": assembly_id,
            "part_id": part_id,
            "fits": remaining >= minimum,
            "remaining_clearance_mm": remaining,
            "min_clearance_mm": minimum,
        }

    def open_orders(self, part_id: str) -> list[dict[str, Any]]:
        self._require_part(part_id)
        return [o for o in self._data["orders"] if o["part_id"] == part_id]

    def set_ecn_status(self, ecn_id: str, status: str) -> dict[str, Any]:
        if status not in ECN_STATUSES:
            raise ValueError(f"Status must be one of {ECN_STATUSES}, got {status!r}.")
        ecn = self._data["ecns"].get(ecn_id)
        if ecn is None:
            raise UnknownRecord(f"No ECN with id {ecn_id!r}.")
        previous = ecn["status"]
        ecn["status"] = status
        return {"ecn_id": ecn_id, "previous_status": previous, "status": status}

    def _require_part(self, part_id: str) -> dict[str, Any]:
        part = self._data["parts"].get(part_id)
        if part is None:
            raise UnknownRecord(
                f"No part with id {part_id!r}. Known: {sorted(self._data['parts'])}."
            )
        return part
