"""One lock for every use of pdfium in this process.

pdfium is not safe to call from two threads at once, not even on two different documents: its
documentation says so, and production showed it. A sub-goal run read old.pdf and new.pdf in two
threads and the agent process died within seconds, with no error event, no heartbeat and the run
left "running" (run 06a2cdb6, 2026-10-24). Reproduced with the same two PDFs: 11 of 15 processes
crashed (segfault or heap corruption) and the other 4 returned pdfium errors or wrong paragraph
counts; one at a time, none.

Every function that opens a document with pypdfium2 holds this lock from opening it to closing
it. Callers keep their threads (`asyncio.to_thread`): the event loop, downloads and model calls go
on while one PDF is read, and parsing ran on one core anyway, so taking turns costs little.

pypdf (pure Python) is not covered and does not need to be.
"""

import threading

PDFIUM = threading.Lock()
