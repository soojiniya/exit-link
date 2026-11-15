"""fair_retry_v1: Fixed + Retry vs EXIT-LINK under one retry/time budget.

Reuse, without editing any existing file:
* the whole cell timetable, fault/restart injection, journal, cleanup and ACK
  validation of ``aligned_v3.trial`` (bound to this study's cluster and label);
* the paired, counterbalanced schedule rule of ``study.prepare``;
* the lease/checkpoint loop of ``study_v3.execute``;
* ``experiments.node`` instrumentation for both methods.

Added: the ``fixed_retry`` method (``fixed_retry_node`` launcher) and this module.
Legacy v3 plans, data and modules are never read or written here.
"""
import asyncio
import contextlib
import hashlib
import json
import random
import threading
from collections import Counter, defaultdict
from pathlib import Path
from uuid import uuid4

from exit_link.experiments import aligned_v3, study
from exit_link.experiments.comparison import CONDITIONS, RELAY_DELAY, now
from exit_link.experiments.journal import DurableJournal, inspect_journal, settle
from exit_link.experiments.safety import ExecutionLock, atomic_json
from exit_link.simulation.processes import LocalCluster
from exit_link.topology.loader import load_communication

PROTOCOL = "fair_retry_v1"
PURPOSE = "fair_retry_comparison"
METHODS = ("fixed_retry", "exit_link")
NODE_MODULES = {"fixed_retry": "exit_link.experiments.fixed_retry_node", "exit_link": "exit_link.experiments.node"}
MAX_RETRIES = 3  # retries after the first attempt; both methods => at most 4 attempts

# Identical to study_v3.SETTINGS for everything shared. The retry entries state the
# unified budget explicitly instead of the v3 fixed_retries=0 asymmetry.
SETTINGS = dict(client_timeout_seconds=6, observation_window_seconds=9, secondary_fault_or_restart_seconds=1,
    send_offsets_seconds=[.05, .8, 2.5], inflight_followup_seconds=[.8, 2.5], scheduling_tolerance_ms=100,
    payload_bytes=256, ttl=16, relay_delay_seconds=RELAY_DELAY,
    retry_policy=dict(max_retries_after_first_attempt=MAX_RETRIES, max_attempts=MAX_RETRIES + 1,
                      retry_location="source_node_N1", backoff_seconds=0, same_for_methods=list(METHODS),
                      retriable_errors=["connection_failed", "invalid_response", "timeout"]),
    route_policy=dict(fixed_retry="initial_route_only_N1-N2-N4", exit_link="heartbeat_link_state_plus_failed_link_exclusion"),
    heartbeat=dict(fixed_retry="disabled", exit_link="enabled"),
    probe_interval_seconds=.1, probe_timeout_seconds=.15, failure_threshold=2, recovery_threshold=2,
    state_ttl_seconds=3, warmup_seconds=.6, node_hop_timeout_seconds=1.5, execution_policy=aligned_v3.POLICY)
SCRIPTS = ("prepare_fair_retry.py", "analyze_fair_retry.py")
_binding = threading.Lock()


class FairCluster(LocalCluster):
    """Same LocalCluster command line as v3; only the launcher module differs per method."""

    def __init__(self, directory, method):
        if method not in NODE_MODULES:
            raise ValueError(f"Unknown fair_retry method: {method}")
        self.node_module = NODE_MODULES[method]
        super().__init__(directory, relay_delay=RELAY_DELAY)


@contextlib.contextmanager
def bound_engine():
    """Run aligned_v3.trial with this study's cluster and label; always restore."""
    if not _binding.acquire(blocking=False):
        raise RuntimeError("Another fair_retry trial is already bound in this process")
    saved = aligned_v3.BenchmarkCluster, aligned_v3.PROTOCOL
    try:
        aligned_v3.BenchmarkCluster, aligned_v3.PROTOCOL = FairCluster, PROTOCOL
        yield
    finally:
        aligned_v3.BenchmarkCluster, aligned_v3.PROTOCOL = saved
        _binding.release()


async def trial(directory, specification):
    if specification["method"] not in METHODS:
        raise ValueError("fair_retry cells must be fixed_retry or exit_link")
    with bound_engine():
        record = await aligned_v3.trial(directory, specification)
    return record


def source_hashes():
    hashes = study.source_hashes()  # all of src/exit_link plus lock files
    root = Path(__file__).resolve().parents[3]
    for name in SCRIPTS:
        path = root / "scripts" / name
        hashes[str(path.relative_to(root))] = hashlib.sha256(path.read_bytes()).hexdigest()
    return hashes


def strata():
    return [(c, t) for c in CONDITIONS
            for t in (["none"] if c == "normal" else ["before_send"] if c == "no_route" else ["before_send", "inflight"])]


def design_hash(plan):
    keys = ("schema_version", "purpose", "protocol_version", "seed", "repetitions", "methods", "schedule",
            "settings", "source_sha256", "topology")
    return hashlib.sha256(json.dumps({k: plan[k] for k in keys}, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def prepare(directory, repetitions=30, seed=20261116):
    """Same rule as study.prepare (paired cells, alternating first method per stratum)."""
    if repetitions < 2 or repetitions % 2 or repetitions > 100:
        raise ValueError("Use an even number of paired blocks, 2..100")
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=False)
    rng = random.Random(seed)
    first = {s: rng.randrange(2) for s in strata()}
    schedule = []
    for repetition in range(repetitions):
        order = strata()
        rng.shuffle(order)
        for condition, timing in order:
            methods = list(METHODS)
            if (first[condition, timing] + repetition) % 2:
                methods.reverse()
            for method in methods:
                schedule.append(dict(condition=condition, fault_timing=timing, method=method, repetition=repetition,
                                     warmup_extra_seconds=(repetition % 3) * .033))
    plan = dict(schema_version="1.0", purpose=PURPOSE, run_id=str(uuid4()), prepared_at=now(),
                protocol_version=PROTOCOL, status="prepared_not_executed", seed=seed, repetitions=repetitions,
                methods=list(METHODS), schedule=schedule, source_sha256=source_hashes(), settings=json.loads(json.dumps(SETTINGS)),
                completed={}, environment=study.runtime_environment(),
                topology=load_communication().model_dump(mode="json"))
    plan["design_sha256"] = design_hash(plan)
    atomic_json(directory / "plan.json", plan)
    return plan


def validate(directory):
    """Read-only. Rejects legacy (v2/v3) plans and any edited design, source or setting."""
    directory = Path(directory)
    plan = json.loads((directory / "plan.json").read_text(encoding="utf-8"))
    if plan.get("protocol_version") != PROTOCOL or plan.get("purpose") != PURPOSE:
        raise ValueError("Only fair_retry_v1 plans accepted; legacy experiments are read-only")
    if plan["design_sha256"] != design_hash(plan):
        raise ValueError("Prepared design was modified")
    if plan["source_sha256"] != source_hashes() or plan["environment"] != study.runtime_environment():
        raise ValueError("Source/runtime changed; prepare a separate new plan")
    if plan["settings"] != json.loads(json.dumps(SETTINGS)) or plan["methods"] != list(METHODS):
        raise ValueError("Invalid fair_retry policy")
    repetitions, cells = plan["repetitions"], plan["schedule"]
    expected = Counter({(c, t, r, m): 1 for c, t in strata() for r in range(repetitions) for m in METHODS})
    actual = Counter((s["condition"], s["fault_timing"], s["repetition"], s["method"]) for s in cells)
    pairs = defaultdict(list)
    for s in cells:
        pairs[s["condition"], s["fault_timing"], s["repetition"]].append(s)
    starts = Counter((key[0], key[1], group[0]["method"]) for key, group in pairs.items())
    adjacent = all((cells[i]["condition"], cells[i]["fault_timing"], cells[i]["repetition"]) ==
                   (cells[i + 1]["condition"], cells[i + 1]["fault_timing"], cells[i + 1]["repetition"])
                   for i in range(0, len(cells) - 1, 2))
    if not (2 <= repetitions <= 100 and repetitions % 2 == 0 and actual == expected and adjacent
            and all(starts[c, t, m] == repetitions // 2 for c, t in strata() for m in METHODS)
            and all(len({s["warmup_extra_seconds"] for s in group}) == 1 for group in pairs.values())):
        raise ValueError("Invalid paired/counterbalanced schedule")
    if any(str(i) != str(int(i)) or not 0 <= int(i) < len(cells) for i in plan["completed"]):
        raise ValueError("Invalid checkpoint identity")
    for index in range(len(cells)):
        folder = directory / f"t{index:03}"
        checkpoint = plan["completed"].get(str(index))
        if checkpoint:
            path = folder / "trial.json"
            if not path.exists() or hashlib.sha256(path.read_bytes()).hexdigest() != checkpoint["sha256"]:
                raise RuntimeError("Completed cell missing or modified")
            if inspect_journal(folder / "journal.jsonl") != checkpoint["journal_manifest"]:
                raise RuntimeError("Completed journal missing or modified")
        elif folder.exists():
            raise RuntimeError("Uncheckpointed cell: manual audit required; no replay")
    return plan


async def execute(directory, max_cells, lock_directory=None):
    """Same lease/checkpoint loop as study_v3.execute, bound to this study's validate/trial."""
    if not 1 <= max_cells <= 1600:
        raise ValueError("Explicit max_cells must be 1..1600")
    directory = Path(directory).resolve()
    plan = validate(directory)
    lock_root = Path(lock_directory) if lock_directory else directory.parent
    with ExecutionLock(lock_root):
        plan = validate(directory)
        lease = lock_root / ".benchmark-owner.json"
        if lease.exists() and json.loads(lease.read_text(encoding="utf-8"))["state"] != "clean":
            raise RuntimeError("Unclean previous run: manual owned-process/port audit required")
        writer = DurableJournal(directory)
        clean = False
        try:
            await writer.snapshot(lease, dict(state="active", run_directory=str(directory), updated_at=now()))
            executed = 0
            clean = True
            plan["status"] = "running"
            await writer.snapshot(directory / "plan.json", plan)
            for index, spec in enumerate(plan["schedule"]):
                if str(index) in plan["completed"]:
                    continue
                clean = False
                cell = await trial(directory / f"t{index:03}", spec)
                if cell.get("status") != "completed" or not cell.get("journal_manifest") or cell.get("recording_errors"):
                    raise RuntimeError("Incomplete cell preserved: audit required; no completion checkpoint or replay")
                cleanup = cell["cleanup"]
                clean = bool(cleanup.get("normal_stop_confirmed") and cleanup.get("all_owned_processes_exited")
                             and cleanup.get("ports") and all(p["available"] for p in cleanup["ports"]))
                file = directory / f"t{index:03}" / "trial.json"
                plan["completed"][str(index)] = dict(experiment_id=cell["experiment_id"], comparable=cell["comparable"],
                    sha256=hashlib.sha256(file.read_bytes()).hexdigest(), journal_manifest=cell["journal_manifest"])
                plan["status"] = "paused_at_cell_boundary"
                await writer.snapshot(directory / "plan.json", plan)
                executed += 1
                if not cell["comparable"] or not clean or executed >= max_cells:
                    break
            if len(plan["completed"]) == len(plan["schedule"]):
                plan["status"] = "completed" if all(c["comparable"] for c in plan["completed"].values()) else "completed_with_exclusions"
            await writer.snapshot(directory / "plan.json", plan)
        except BaseException:
            clean = False
            raise
        finally:
            async def finish_lease():
                try:
                    await writer.snapshot(lease, dict(state="clean" if clean else "needs_audit", run_directory=str(directory), updated_at=now()))
                finally:
                    await writer.close()
            _, cancelled = await settle(finish_lease())
            if cancelled:
                await settle(asyncio.to_thread(atomic_json, lease, dict(state="needs_audit", run_directory=str(directory), updated_at=now())))
                raise asyncio.CancelledError
    return plan
