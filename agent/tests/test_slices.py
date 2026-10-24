"""Several items at once inside a slice of time (agent_service/slices.py, #43)."""

import asyncio

import pytest

from agent_service import slices
from agent_service.slices import each_until

pytestmark = pytest.mark.anyio


async def test_runs_every_item_and_never_more_than_the_limit_at_once() -> None:
    active, peak, done = 0, 0, []

    async def work(i: int) -> bool:
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0.01)
        active -= 1
        done.append(i)
        return True

    assert await each_until(range(10), work, limit=3, deadline=float("inf"))
    assert sorted(done) == list(range(10))
    assert peak == 3


async def test_nothing_starts_after_the_deadline_and_started_work_finishes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = [0.0]
    monkeypatch.setattr(slices.time, "monotonic", lambda: clock[0])
    done: list[int] = []

    async def work(i: int) -> bool:
        clock[0] = 10.0  # the first ones use up the slice
        await asyncio.sleep(0)
        done.append(i)
        return True

    assert not await each_until(range(5), work, limit=2, deadline=5.0)
    assert sorted(done) == [0, 1]


async def test_a_work_that_says_stop_ends_the_starting() -> None:
    started: list[int] = []

    async def work(i: int) -> bool:
        started.append(i)
        return i != 1

    assert not await each_until(range(5), work, limit=1, deadline=float("inf"))
    assert started == [0, 1]


async def test_an_error_is_raised_as_it_is_and_cancels_the_rest() -> None:
    cancelled: list[int] = []

    async def work(i: int) -> bool:
        if i == 0:
            raise ValueError("refused")
        try:
            await asyncio.sleep(10)
        except asyncio.CancelledError:
            cancelled.append(i)
            raise
        return True

    with pytest.raises(ValueError, match="refused"):
        await each_until(range(3), work, limit=3, deadline=float("inf"))
    assert sorted(cancelled) == [1, 2]
