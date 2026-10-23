"""Prepare v3 only by default. Execution always needs an explicit path and bound."""
import argparse
import asyncio
import json
import signal
import sys
from pathlib import Path
from uuid import uuid4

from exit_link.experiments.study_v3 import execute, prepare, validate


async def interruptible(operation):
    """Translate console SIGINT into one cancellation, not a teardown exception."""
    loop = asyncio.get_running_loop()
    task = asyncio.create_task(operation)
    previous = signal.getsignal(signal.SIGINT)
    requested = False
    def interrupt(signum, frame):
        nonlocal requested
        if not requested:
            requested = True
            loop.call_soon_threadsafe(task.cancel)
            print("Interrupt requested; waiting for owned-node cleanup. Further Ctrl+C is deferred.", file=sys.stderr, flush=True)
    signal.signal(signal.SIGINT, interrupt)
    try:
        return await task
    finally:
        signal.signal(signal.SIGINT, previous)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repetitions", type=int, default=2, help="2 for rehearsal; 30 prepares 480 cells but never executes them")
    parser.add_argument("--seed", type=int, default=20261022)
    parser.add_argument("--execute", type=Path)
    parser.add_argument("--max-cells", type=int)
    parser.add_argument("--check", type=Path)
    args = parser.parse_args()
    if args.check:
        if args.execute or args.max_cells is not None:
            parser.error("--check cannot execute")
        plan = validate(args.check)
        print(json.dumps(dict(status="validated_read_only", protocol=plan["protocol_version"], cells=len(plan["schedule"]), completed=len(plan["completed"]))))
        return 0
    if args.execute:
        if args.max_cells is None:
            parser.error("--execute needs --max-cells")
        validate(args.execute)  # Refuse legacy directories before any writable action.
        from diagnose_tcp import probe_loopback
        result = probe_loopback()
        if not result["success"]:
            print(json.dumps(dict(status="blocked_before_execution", preflight=result), ensure_ascii=True))
            return 2
        try:
            plan = asyncio.run(interruptible(execute(args.execute, args.max_cells)))
        except (asyncio.CancelledError, KeyboardInterrupt):
            print("Execution interrupted; incomplete cells retained. Inspect lease before any further execution.")
            return 130
        print(plan["status"], len(plan["completed"]))
        return 0 if all(c["comparable"] for c in plan["completed"].values()) else 1
    if args.max_cells is not None:
        parser.error("--max-cells needs --execute")
    directory = Path(__file__).resolve().parents[1] / "data/measured" / ("v3-" + uuid4().hex[:8])
    plan = prepare(directory, args.repetitions, args.seed)
    print(f"PREPARED ONLY: {directory}; {len(plan['schedule'])} cells; no nodes started")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
