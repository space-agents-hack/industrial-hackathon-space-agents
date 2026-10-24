"""Work done in slices of time, several items at once (#43).

Imports and indexing run as one request per slice (`import_slice_s`, `index_slice_s`), and inside
a slice their items wait mostly on the network: a PDF download, an embedding request, a model call.
One at a time, a slice spent most of its 150 s waiting; a few at once fill it.

What this does NOT do: run two slices of the same work at once. That is still one request after
another, so the database sees at most `limit` of these writes at a time per organisation.
"""

import asyncio
import time
from collections.abc import Callable, Coroutine, Iterable
from typing import Any


async def each_until[T](
    items: Iterable[T],
    work: Callable[[T], Coroutine[Any, Any, bool]],
    *,
    limit: int,
    deadline: float,
) -> bool:
    """`work(item)` for each item in order, at most `limit` at once. None is started at or after
    `deadline` (monotonic) or once a `work` has returned False; the ones already started finish.
    True if every item ran and every `work` returned True.

    An exception in one `work` cancels the others and is raised as it is (not in an exception
    group), so callers keep catching the errors they already catch."""
    pending = iter(items)
    running: set[asyncio.Task[bool]] = set()
    complete = True
    try:
        while True:
            while complete and len(running) < max(limit, 1):
                if time.monotonic() >= deadline:
                    complete = False
                    break
                try:
                    item = next(pending)
                except StopIteration:
                    break
                running.add(asyncio.create_task(work(item)))
            if not running:
                return complete
            done, running = await asyncio.wait(running, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                if not task.result():
                    complete = False
    finally:
        for task in running:
            task.cancel()
        if running:
            await asyncio.gather(*running, return_exceptions=True)
