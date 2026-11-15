"""fair_retry_v1 (Fixed + Retry vs EXIT-LINK). Prepare by default; execution needs an explicit path and bound.

Runs live under data/measured/fair-retry/ with their own lock and lease file, so the
v3 directories and data/measured/.benchmark-owner.json are never read or written.
"""
import argparse
import asyncio
import json
import signal
import sys
from pathlib import Path
from uuid import uuid4

from exit_link.experiments.fair_retry import execute, prepare, validate

ROOT = Path(__file__).resolve().parents[1] / "data" / "measured" / "fair-retry"


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


def inside_fair_root(path):
    try:
        Path(path).resolve().relative_to(ROOT.resolve())
        return True
    except ValueError:
        return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repetitions", type=int, default=2, help="2 for a pilot; 30 prepares 480 cells but never executes them")
    parser.add_argument("--seed", type=int, default=20261116)
    parser.add_argument("--label", default="main", help="folder prefix, e.g. pilot or main")
    parser.add_argument("--execute", type=Path)
    parser.add_argument("--max-cells", type=int)
    parser.add_argument("--check", type=Path)
    args = parser.parse_args()
    if args.check:
        if args.execute or args.max_cells is not None:
            parser.error("--check cannot execute")
        plan = validate(args.check)
        print(json.dumps(dict(status="validated_read_only", protocol=plan["protocol_version"], cells=len(plan["schedule"]),
                              completed=len(plan["completed"]))))
        return 0
    if args.execute:
        if args.max_cells is None:
            parser.error("--execute needs --max-cells")
        if not inside_fair_root(args.execute):
            parser.error(f"--execute only accepts runs under {ROOT}")
        validate(args.execute)  # refuse legacy or edited directories before any writable action
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
    if not args.label.replace("-", "").isalnum():
        parser.error("--label must be letters, digits or '-'")
    ROOT.mkdir(parents=True, exist_ok=True)
    directory = ROOT / f"{args.label}-{uuid4().hex[:8]}"
    plan = prepare(directory, args.repetitions, args.seed)
    print(f"PREPARED ONLY: {directory}; {len(plan['schedule'])} cells; no nodes started")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
