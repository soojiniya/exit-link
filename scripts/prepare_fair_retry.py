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

from exit_link.experiments.fair_retry import (MAIN_REPETITIONS, MAIN_SEED, PILOT_SEED, STAGES, acknowledge_lease,
                                              audit_interrupted, excluded_indices, execute, prepare, read_audit, validate)

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
    parser.add_argument("--stage", choices=STAGES, default="pilot",
                        help="main = pre-registered 480 cells (30 repetitions, fixed seed); pilot = small procedure check")
    parser.add_argument("--repetitions", type=int, help=f"pilot only (default 2); main is fixed at {MAIN_REPETITIONS}")
    parser.add_argument("--seed", type=int, help=f"pilot only (default {PILOT_SEED}); main is fixed at {MAIN_SEED}")
    parser.add_argument("--execute", type=Path)
    parser.add_argument("--max-cells", type=int)
    parser.add_argument("--check", type=Path)
    parser.add_argument("--audit-interrupted", type=Path, metavar="RUN", help="record an explicit exclusion; changes no data")
    parser.add_argument("--acknowledge-lease", type=Path, metavar="RUN", help="acknowledge an unclean lease with no interrupted cell")
    parser.add_argument("--cell", type=int, help="cell index for --audit-interrupted (t017 -> 17)")
    parser.add_argument("--reason")
    parser.add_argument("--auditor")
    args = parser.parse_args()
    if args.audit_interrupted or args.acknowledge_lease:
        if args.execute or args.check or args.max_cells is not None:
            parser.error("Audit commands never execute or prepare")
        if not args.reason or not args.auditor:
            parser.error("Audit commands need --reason and --auditor")
        if args.audit_interrupted:
            if args.cell is None:
                parser.error("--audit-interrupted needs --cell")
            if not inside_fair_root(args.audit_interrupted):
                parser.error(f"Audits only accept runs under {ROOT}")
            records = audit_interrupted(args.audit_interrupted, args.cell, args.reason, args.auditor)
            print(json.dumps([dict(kind=r["kind"], cell=r["cell"], partner=r.get("partner")) for r in records], ensure_ascii=False))
        else:
            if not inside_fair_root(args.acknowledge_lease):
                parser.error(f"Audits only accept runs under {ROOT}")
            entry = acknowledge_lease(args.acknowledge_lease, args.reason, args.auditor)
            print(json.dumps(dict(kind=entry["kind"], lease_state=entry["lease"]["content"]["state"])))
        return 0
    if args.check:
        if args.execute or args.max_cells is not None:
            parser.error("--check cannot execute")
        plan = validate(args.check)
        print(json.dumps(dict(status="validated_read_only", protocol=plan["protocol_version"], stage=plan["stage"],
                              seed=plan["seed"], cells=len(plan["schedule"]), completed=len(plan["completed"]),
                              audited_exclusions=len(excluded_indices(read_audit(args.check))))))
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
            print("Execution interrupted; incomplete cells retained. Audit with --audit-interrupted before any further execution.")
            return 130
        print(plan["status"], len(plan["completed"]))
        return 0 if all(c["comparable"] for c in plan["completed"].values()) else 1
    if args.max_cells is not None:
        parser.error("--max-cells needs --execute")
    if args.stage == "main":
        if args.repetitions not in (None, MAIN_REPETITIONS) or args.seed not in (None, MAIN_SEED):
            parser.error(f"Main study is pre-registered: --repetitions {MAIN_REPETITIONS}, seed {MAIN_SEED}")
        repetitions, seed = MAIN_REPETITIONS, MAIN_SEED
    else:
        repetitions = 2 if args.repetitions is None else args.repetitions
        seed = PILOT_SEED if args.seed is None else args.seed
    ROOT.mkdir(parents=True, exist_ok=True)
    directory = ROOT / f"{args.stage}-{uuid4().hex[:8]}"  # pilot-* and main-* never share a folder
    plan = prepare(directory, repetitions, seed, args.stage)
    print(f"PREPARED ONLY: {directory}; stage={plan['stage']}; seed={plan['seed']}; {len(plan['schedule'])} cells; no nodes started")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
