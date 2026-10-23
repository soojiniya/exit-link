"""Version-isolated preparation/resume; never accepts an aligned-v2 directory."""
import asyncio
import hashlib
import json
from collections import Counter, defaultdict
from pathlib import Path

from exit_link.experiments import study
from exit_link.experiments.aligned_v3 import POLICY, PROTOCOL, trial
from exit_link.experiments.journal import DurableJournal, inspect_journal, settle
from exit_link.experiments.safety import ExecutionLock, atomic_json
from exit_link.experiments.comparison import now

SETTINGS = dict(client_timeout_seconds=6, observation_window_seconds=9, secondary_fault_or_restart_seconds=1,
    send_offsets_seconds=[.05, .8, 2.5], inflight_followup_seconds=[.8, 2.5], scheduling_tolerance_ms=100,
    payload_bytes=256, ttl=16, relay_delay_seconds=.2, fixed_retries=0, exit_link_max_retries=3,
    probe_interval_seconds=.1, probe_timeout_seconds=.15, failure_threshold=2, recovery_threshold=2,
    state_ttl_seconds=3, warmup_seconds=.6, node_hop_timeout_seconds=1.5, execution_policy=POLICY)


def source_hashes():
    hashes = study.source_hashes()
    root = Path(__file__).resolve().parents[3]
    for name in ("prepare_study_v3.py", "analyze_study_v3.py"):
        path = root / "scripts" / name
        hashes[str(path.relative_to(root))] = hashlib.sha256(path.read_bytes()).hexdigest()
    return hashes


def prepare(directory, repetitions=30, seed=20261022):
    plan = study.prepare(directory, repetitions, seed)
    plan.update(protocol_version=PROTOCOL, source_sha256=source_hashes())
    plan["settings"]["execution_policy"] = dict(POLICY)
    plan["design_sha256"] = study.design_hash(plan)
    atomic_json(Path(directory) / "plan.json", plan)
    return plan


def validate(directory):
    """No writes, lock creation or node starts, including when given legacy data."""
    directory = Path(directory)
    plan = json.loads((directory / "plan.json").read_text(encoding="utf-8"))
    if plan["protocol_version"] != PROTOCOL or plan["purpose"] != "contest_main_study":
        raise ValueError("Only aligned_v3 plans accepted; legacy experiments are read-only")
    if plan["design_sha256"] != study.design_hash(plan):
        raise ValueError("Prepared design was modified")
    if plan["source_sha256"] != source_hashes() or plan["environment"] != study.runtime_environment():
        raise ValueError("Source/runtime changed; prepare a separate new plan")
    if plan["settings"] != SETTINGS:
        raise ValueError("Invalid v3 policy")
    repetitions = plan["repetitions"]
    strata = {("normal", "none"), ("no_route", "before_send"),
              *((c, t) for c in ("single_failure", "sequential_failures", "restart") for t in ("before_send", "inflight"))}
    cells = plan["schedule"]
    expected = Counter({(c, t, r, m): 1 for c, t in strata for r in range(repetitions) for m in ("fixed", "exit_link")})
    actual = Counter((s["condition"], s["fault_timing"], s["repetition"], s["method"]) for s in cells)
    pairs = defaultdict(list)
    for s in cells:
        pairs[s["condition"], s["fault_timing"], s["repetition"]].append(s)
    starts = Counter((key[0], key[1], group[0]["method"]) for key, group in pairs.items())
    adjacent = all((cells[i]["condition"], cells[i]["fault_timing"], cells[i]["repetition"]) ==
                   (cells[i+1]["condition"], cells[i+1]["fault_timing"], cells[i+1]["repetition"]) for i in range(0, len(cells)-1, 2))
    if not (2 <= repetitions <= 100 and repetitions % 2 == 0 and actual == expected and adjacent
            and all(starts[c, t, m] == repetitions // 2 for c, t in strata for m in ("fixed", "exit_link"))
            and all(len({s["warmup_extra_seconds"] for s in group}) == 1 for group in pairs.values())):
        raise ValueError("Invalid paired/counterbalanced schedule")
    if any(str(i) != str(int(i)) or not 0 <= int(i) < len(cells) for i in plan["completed"]):
        raise ValueError("Invalid checkpoint identity")
    for index in range(len(plan["schedule"])):
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
    if not 1 <= max_cells <= 1600:
        raise ValueError("Explicit max_cells must be 1..1600")
    directory = Path(directory).resolve()
    plan = validate(directory)
    lock_root = Path(lock_directory) if lock_directory else directory.parent
    with ExecutionLock(lock_root):
        # Re-read under the lock: a contender might have completed a cell while
        # this caller was validating. A stale plan must never overwrite it.
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
