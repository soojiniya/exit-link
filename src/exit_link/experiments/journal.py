"""Single-writer durable experiment journal; no filesystem work on the event loop."""
import asyncio
import copy
import hashlib
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from exit_link.experiments.safety import atomic_json


async def settle(awaitable):
    """Finish owned work despite caller cancellation; report deferred cancellation.

    Used for process-control barriers and teardown, never to accept a late TCP
    response. SIGKILL/TerminateProcess or an unusable event loop cannot be healed.
    """
    future = asyncio.ensure_future(awaitable)
    cancelled = False
    while not future.done():
        try:
            await asyncio.shield(future)
        except asyncio.CancelledError:
            cancelled = True
    return future.result(), cancelled


def canonical(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True,
                      separators=(",", ":")).encode("utf-8")


def inspect_journal(path):
    """Read only. A torn tail is an error requiring audit, never auto-truncated."""
    previous = "0" * 64
    data = Path(path).read_bytes()
    lines = data.splitlines(keepends=True)
    for sequence, line in enumerate(lines):
        if not line.endswith(b"\n"):
            raise ValueError("Torn journal tail: manual audit required")
        entry = json.loads(line)
        body = {k: entry[k] for k in ("sequence", "previous_sha256", "record")}
        digest = hashlib.sha256(canonical(body)).hexdigest()
        if entry["sequence"] != sequence or entry["previous_sha256"] != previous or entry["sha256"] != digest:
            raise ValueError("Journal integrity mismatch")
        previous = digest
    return dict(entries=len(lines), sha256=hashlib.sha256(data).hexdigest())


class DurableJournal:
    """Bounded immutable submissions, serial fsync, explicit final drain.

    Precommitted message intents precede the measurement window. A crash after
    an intent is an uncertain attempt, never permission to replay that cell.
    """
    def __init__(self, directory, capacity=64):
        self.path = Path(directory) / "journal.jsonl"
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="exit-link-journal")
        self.capacity = capacity
        self.pending = set()
        self.failure = None
        self.sequence = 0
        self.previous = "0" * 64
        self.closed = False

    def _append(self, record):
        body = dict(sequence=self.sequence, previous_sha256=self.previous, record=record)
        digest = hashlib.sha256(canonical(body)).hexdigest()
        encoded = canonical(dict(**body, sha256=digest)) + b"\n"
        with self.path.open("ab") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        self.sequence += 1
        self.previous = digest
        return dict(recording_completed_perf_ns=time.perf_counter_ns(), sequence=self.sequence - 1)

    def check(self):
        if self.failure is not None:
            raise RuntimeError("Durable recording failed") from self.failure
        if self.closed:
            raise RuntimeError("Journal is closed")

    def _done(self, future):
        self.pending.discard(future)
        if not future.cancelled() and future.exception() is not None:
            self.failure = future.exception()

    def submit(self, record):
        self.check()
        if len(self.pending) >= self.capacity:
            raise RuntimeError("Journal capacity exceeded; refusing unrecorded operation")
        future = asyncio.get_running_loop().run_in_executor(self.executor, self._append, copy.deepcopy(record))
        self.pending.add(future)
        future.add_done_callback(self._done)
        return future

    async def commit(self, record):
        return await asyncio.shield(self.submit(record))

    async def snapshot(self, path, record):
        self.check()
        value = copy.deepcopy(record)
        await asyncio.shield(asyncio.get_running_loop().run_in_executor(self.executor, atomic_json, path, value))

    async def drain(self):
        if self.pending:
            await asyncio.shield(asyncio.gather(*list(self.pending)))
        self.check()

    async def close(self):
        try:
            await self.drain()
        finally:
            # Await outstanding disk work even when the cell was cancelled.
            await asyncio.to_thread(self.executor.shutdown, wait=True, cancel_futures=False)
            self.closed = True
