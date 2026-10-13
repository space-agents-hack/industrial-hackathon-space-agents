"""The deterministic layer. If these numbers are wrong, every answer built on them is wrong and
no model will notice."""

import pytest

from agent_service.domain.systems import Systems, UnknownRecord


@pytest.fixture
def systems() -> Systems:
    return Systems.from_fixture()


def test_a_part_that_outgrows_its_clearance_does_not_fit(systems: Systems) -> None:
    # 0.3 mm free, the wall grows 0.5 mm: 0.2 mm of interference.
    result = systems.check_fit("ASM-310", "BR-204", new_value_mm=2.5)
    assert result["fits"] is False
    assert result["remaining_clearance_mm"] == -0.2


def test_fit_needs_the_minimum_clearance_not_just_zero(systems: Systems) -> None:
    # 0.3 mm free, growing 0.15 mm leaves 0.15 mm: positive, but under the 0.2 mm minimum.
    assert systems.check_fit("ASM-310", "BR-204", new_value_mm=2.15)["fits"] is False
    # Growing 0.1 mm leaves exactly the minimum, which is allowed.
    assert systems.check_fit("ASM-310", "BR-204", new_value_mm=2.1)["fits"] is True


def test_affected_assemblies_are_only_those_using_the_part(systems: Systems) -> None:
    ids = [a["assembly_id"] for a in systems.affected_assemblies("BR-204")]
    assert ids == ["ASM-310", "ASM-311"]


def test_open_orders_are_filtered_by_part(systems: Systems) -> None:
    assert [o["order_id"] for o in systems.open_orders("CV-310")] == ["SO-88102"]


def test_unknown_ids_are_errors_not_empty_answers(systems: Systems) -> None:
    # An empty list would read as "nothing is affected", which is the dangerous answer.
    with pytest.raises(UnknownRecord):
        systems.affected_assemblies("BR-999")
    with pytest.raises(UnknownRecord):
        systems.get_ecn("ECN-9999")
    with pytest.raises(UnknownRecord):
        systems.check_fit("ASM-420", "BR-204", 2.5)


def test_setting_a_status_reports_the_previous_one(systems: Systems) -> None:
    assert systems.set_ecn_status("ECN-1001", "hold") == {
        "ecn_id": "ECN-1001",
        "previous_status": "open",
        "status": "hold",
    }
    assert systems.get_ecn("ECN-1001")["status"] == "hold"
    with pytest.raises(ValueError):
        systems.set_ecn_status("ECN-1001", "done")


def test_one_instance_does_not_leak_writes_into_the_next() -> None:
    Systems.from_fixture().set_ecn_status("ECN-1001", "hold")
    assert Systems.from_fixture().get_ecn("ECN-1001")["status"] == "open"
