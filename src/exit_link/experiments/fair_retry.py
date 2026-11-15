"""fair_retry_v1: Fixed + Retry vs EXIT-LINK under one retry/time budget.

Reuse, without editing any existing file:
* the whole cell timetable, fault/restart injection, journal, cleanup and ACK
  validation of ``aligned_v3.trial`` (bound to this study's cluster and label);
* the paired, counterbalanced schedule rule of ``study.prepare``;
* the lease/checkpoint loop of ``study_v3.execute``;
* ``experiments.node`` instrumentation for both methods.

Added: the ``fixed_retry`` method (``fixed_retry_node`` launcher), pilot/main stages
with a pre-registered main seed, and an append-only audit log that lets an
interrupted cell be excluded explicitly (never deleted, edited or replayed).
Legacy v3 plans, data and modules are never read or written here.
Design: docs/fair-retry-main-study-design.md (its hash is pinned in every plan).
"""
import asyncio
import contextlib
import hashlib
import json
import os
import random
import threading
from collections import Counter, defaultdict
from pathlib import Path
from uuid import uuid4

from exit_link.experiments import aligned_v3, study
from exit_link.experiments.comparison import CONDITIONS, RELAY_DELAY, check_ports, now
from exit_link.experiments.journal import DurableJournal, canonical, inspect_journal, settle
from exit_link.experiments.safety import ExecutionLock, atomic_json
from exit_link.simulation.processes import LocalCluster
from exit_link.topology.loader import load_communication

PROTOCOL = "fair_retry_v1"
PURPOSE = "fair_retry_comparison"
METHODS = ("fixed_retry", "exit_link")
NODE_MODULES = {"fixed_retry": "exit_link.experiments.fixed_retry_node", "exit_link": "exit_link.experiments.node"}
MAX_RETRIES = 3  # retries after the first attempt; both methods => at most 4 attempts
STAGES = ("pilot", "main")
PILOT_SEED = 20261116            # used by pilot-e02bb314
MAIN_SEED = 20261117             # pre-registered in docs/fair-retry-main-study-design.md
MAIN_REPETITIONS = 30            # 8 strata x 30 blocks x 2 methods = 480 cells
AUDIT_FILE = Path("audit") / "exclusions.jsonl"
AUDIT_KINDS = ("excluded_interrupted", "excluded_partner", "lease_acknowledged")

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
SCRIPTS = ("scripts/prepare_fair_retry.py", "scripts/analyze_fair_retry.py", "docs/fair-retry-main-study-design.md")
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


def posix_keys(hashes, sep=os.sep):
    """Same keys on Windows and Linux: study.source_hashes() (shared with v3, left unchanged) uses str(Path)."""
    normalized = {key.replace(sep, "/"): value for key, value in hashes.items()}
    if len(normalized) != len(hashes):
        raise ValueError("Source paths collide after POSIX normalization")
    return normalized


def source_hashes():
    hashes = posix_keys(study.source_hashes())  # all of src/exit_link plus lock files
    root = Path(__file__).resolve().parents[3]
    for name in SCRIPTS:
        path = root / name
        hashes[path.relative_to(root).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    return hashes


def strata():
    return [(c, t) for c in CONDITIONS
            for t in (["none"] if c == "normal" else ["before_send"] if c == "no_route" else ["before_send", "inflight"])]


def design_hash(plan):
    keys = ("schema_version", "purpose", "protocol_version", "stage", "seed", "repetitions", "methods", "schedule",
            "settings", "source_sha256", "topology")
    missing = [k for k in keys if k not in plan]
    if missing:
        raise ValueError(f"Plan predates this design (missing {missing}); it stays read-only")
    return hashlib.sha256(json.dumps({k: plan[k] for k in keys}, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def check_stage(stage, repetitions, seed):
    if stage not in STAGES:
        raise ValueError("stage must be pilot or main")
    if stage == "main" and (repetitions != MAIN_REPETITIONS or seed != MAIN_SEED):
        raise ValueError(f"Main study is pre-registered: repetitions={MAIN_REPETITIONS}, seed={MAIN_SEED}")
    if stage == "pilot" and seed == MAIN_SEED:
        raise ValueError("Pilot runs must not use the pre-registered main seed")


def prepare(directory, repetitions=2, seed=PILOT_SEED, stage="pilot"):
    """Same rule as study.prepare (paired cells, alternating first method per stratum)."""
    if repetitions < 2 or repetitions % 2 or repetitions > 100:
        raise ValueError("Use an even number of paired blocks, 2..100")
    check_stage(stage, repetitions, seed)
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
    plan = dict(schema_version="1.1", purpose=PURPOSE, run_id=str(uuid4()), prepared_at=now(),
                protocol_version=PROTOCOL, stage=stage, status="prepared_not_executed", seed=seed, repetitions=repetitions,
                methods=list(METHODS), schedule=schedule, source_sha256=source_hashes(), settings=json.loads(json.dumps(SETTINGS)),
                completed={}, environment=study.runtime_environment(),
                topology=load_communication().model_dump(mode="json"))
    plan["design_sha256"] = design_hash(plan)
    atomic_json(directory / "plan.json", plan)
    return plan


# ---------------------------------------------------------------- audit log
def _file_sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def folder_snapshot(folder):
    """Read-only inventory (relative path, size, SHA-256) of every file in a cell folder."""
    folder = Path(folder)
    return [dict(path=p.relative_to(folder).as_posix(), bytes=p.stat().st_size, sha256=_file_sha256(p))
            for p in sorted(folder.rglob("*")) if p.is_file()]


def read_audit(directory):
    """Verify the hash chain of the append-only audit log; return its records in order."""
    path = Path(directory) / AUDIT_FILE
    if not path.exists():
        return []
    previous, records = "0" * 64, []
    for sequence, line in enumerate(path.read_bytes().splitlines(keepends=True)):
        if not line.endswith(b"\n"):
            raise RuntimeError("Torn audit log tail: manual review required")
        entry = json.loads(line)
        body = {k: entry[k] for k in ("sequence", "previous_sha256", "record")}
        digest = hashlib.sha256(canonical(body)).hexdigest()
        if entry["sequence"] != sequence or entry["previous_sha256"] != previous or entry["sha256"] != digest:
            raise RuntimeError("Audit log integrity mismatch")
        if entry["record"].get("kind") not in AUDIT_KINDS:
            raise RuntimeError("Unknown audit record kind")
        previous = digest
        records.append(entry["record"])
    return records


def _append_audit(directory, records):
    """Append-only; never rewrites earlier lines. Creates only the audit/ folder."""
    path = Path(directory) / AUDIT_FILE
    existing = read_audit(directory)
    previous = "0" * 64
    if existing:
        previous = json.loads(path.read_bytes().splitlines()[-1])["sha256"]
    path.parent.mkdir(exist_ok=True)
    with path.open("ab") as stream:
        for offset, record in enumerate(records):
            body = dict(sequence=len(existing) + offset, previous_sha256=previous, record=record)
            previous = hashlib.sha256(canonical(body)).hexdigest()
            stream.write(json.dumps(dict(body, sha256=previous), ensure_ascii=False, sort_keys=True).encode() + b"\n")
        stream.flush()
        os.fsync(stream.fileno())


def excluded_indices(records):
    return {r["index"]: r for r in records if r["kind"] in ("excluded_interrupted", "excluded_partner")}


def pair_index(plan, index):
    spec = plan["schedule"][index]
    for other, candidate in enumerate(plan["schedule"]):
        if other != index and all(candidate[k] == spec[k] for k in ("condition", "fault_timing", "repetition")):
            return other
    raise RuntimeError("Paired cell not found")


def _lease(directory):
    path = Path(directory).parent / ".benchmark-owner.json"
    if not path.exists():
        return None
    return dict(path=path.name, sha256=_file_sha256(path), content=json.loads(path.read_text(encoding="utf-8")))


def _ports_free(port_checker):
    ports = port_checker(load_communication())
    if not all(p["available"] for p in ports):
        raise RuntimeError("Node ports still in use: stop leftover node processes before auditing")
    return ports


def audit_interrupted(directory, index, reason, auditor, port_checker=check_ports):
    """Record an explicit exclusion for one uncheckpointed (interrupted) cell.

    Reads, hashes and records; it never deletes, edits or moves the cell's files,
    plan.json, the lease or the lock, and it makes no success/failure judgment.
    If the paired cell has not run, it is excluded too (the pair cannot be compared).
    """
    if not reason or not reason.strip() or not auditor or not auditor.strip():
        raise ValueError("An audit needs an explicit reason and auditor")
    directory = Path(directory).resolve()
    if str(index) in json.loads((directory / "plan.json").read_text(encoding="utf-8")).get("completed", {}):
        raise ValueError("Checkpointed cells are never excluded or replayed here")
    plan = validate(directory, pending_audit=index)
    folder = directory / f"t{index:03}"
    if not folder.exists():
        raise ValueError("No interrupted folder for this cell")
    records = read_audit(directory)
    if index in excluded_indices(records):
        raise ValueError("Cell already audited")
    ports = _ports_free(port_checker)
    try:
        journal = dict(status="intact", manifest=inspect_journal(folder / "journal.jsonl"))
    except (OSError, ValueError, KeyError) as exc:
        journal = dict(status="unreadable", error=f"{type(exc).__name__}: {exc}")
    trial_status = None
    if (folder / "trial.json").exists():
        try:
            trial_status = json.loads((folder / "trial.json").read_text(encoding="utf-8")).get("status")
        except (OSError, ValueError) as exc:
            trial_status = f"unreadable: {type(exc).__name__}"
    partner = pair_index(plan, index)
    if str(partner) in plan["completed"]:
        partner_state = "completed_retained_pair_excluded"
    elif (directory / f"t{partner:03}").exists():
        partner_state = "uncheckpointed_requires_own_audit"
    else:
        partner_state = "not_run_excluded"
    stamp = now()
    entry = dict(kind="excluded_interrupted", index=index, cell=f"t{index:03}", spec=plan["schedule"][index],
                 reason=reason.strip(), auditor=auditor.strip(), audited_at=stamp, plan_design_sha256=plan["design_sha256"],
                 plan_file_sha256=_file_sha256(directory / "plan.json"), folder_snapshot=folder_snapshot(folder),
                 journal=journal, trial_status=trial_status, lease=_lease(directory), ports=ports,
                 partner=dict(index=partner, cell=f"t{partner:03}", state=partner_state),
                 outcome_judgment="none: excluded from paired analysis, never scored as success or failure")
    batch = [entry]
    if partner_state == "not_run_excluded":
        batch.append(dict(kind="excluded_partner", index=partner, cell=f"t{partner:03}", spec=plan["schedule"][partner],
                          reason=f"pair of audited interrupted cell t{index:03}", auditor=auditor.strip(), audited_at=stamp,
                          outcome_judgment="none: never executed"))
    _append_audit(directory, batch)
    return batch


def acknowledge_lease(directory, reason, auditor, port_checker=check_ports):
    """Acknowledge an unclean lease when no cell folder was left uncheckpointed."""
    if not reason or not reason.strip() or not auditor or not auditor.strip():
        raise ValueError("An acknowledgement needs an explicit reason and auditor")
    directory = Path(directory).resolve()
    validate(directory)  # refuses any unaudited uncheckpointed folder
    lease = _lease(directory)
    if lease is None or lease["content"].get("state") == "clean":
        raise ValueError("Lease is clean; nothing to acknowledge")
    if Path(lease["content"].get("run_directory", "")).resolve() != directory:
        raise ValueError("Lease belongs to another run directory")
    entry = dict(kind="lease_acknowledged", index=None, reason=reason.strip(), auditor=auditor.strip(), audited_at=now(),
                 lease=lease, ports=_ports_free(port_checker), plan_file_sha256=_file_sha256(directory / "plan.json"))
    _append_audit(directory, [entry])
    return entry


def lease_acknowledged(directory, lease_path):
    sha = _file_sha256(lease_path)
    return any((r.get("lease") or {}).get("sha256") == sha for r in read_audit(directory)
               if r["kind"] in ("excluded_interrupted", "lease_acknowledged"))


# ---------------------------------------------------------------- plan
def validate(directory, pending_audit=None):
    """Read-only. Rejects legacy (v2/v3, pre-stage) plans and any edited design, source or setting."""
    directory = Path(directory)
    plan = json.loads((directory / "plan.json").read_text(encoding="utf-8"))
    if plan.get("protocol_version") != PROTOCOL or plan.get("purpose") != PURPOSE:
        raise ValueError("Only fair_retry_v1 plans accepted; legacy experiments are read-only")
    if plan["design_sha256"] != design_hash(plan):
        raise ValueError("Prepared design was modified")
    check_stage(plan["stage"], plan["repetitions"], plan["seed"])
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
    excluded = excluded_indices(read_audit(directory))
    for index in range(len(cells)):
        folder = directory / f"t{index:03}"
        checkpoint = plan["completed"].get(str(index))
        audit = excluded.get(index)
        if checkpoint:
            if audit:
                raise RuntimeError("Audit excludes a checkpointed cell: inconsistent records")
            path = folder / "trial.json"
            if not path.exists() or hashlib.sha256(path.read_bytes()).hexdigest() != checkpoint["sha256"]:
                raise RuntimeError("Completed cell missing or modified")
            if inspect_journal(folder / "journal.jsonl") != checkpoint["journal_manifest"]:
                raise RuntimeError("Completed journal missing or modified")
        elif audit and audit["kind"] == "excluded_interrupted":
            if not folder.exists() or folder_snapshot(folder) != audit["folder_snapshot"]:
                raise RuntimeError(f"Audited interrupted cell t{index:03} changed after audit")
        elif audit and audit["kind"] == "excluded_partner":
            if folder.exists():
                raise RuntimeError(f"Excluded partner t{index:03} must never run")
        elif folder.exists() and index != pending_audit:
            raise RuntimeError("Uncheckpointed cell: audit it with --audit-interrupted; no replay")
    return plan


async def execute(directory, max_cells, lock_directory=None):
    """study_v3.execute's lease/checkpoint loop, plus audited exclusions (skipped, never replayed)."""
    if not 1 <= max_cells <= 1600:
        raise ValueError("Explicit max_cells must be 1..1600")
    directory = Path(directory).resolve()
    plan = validate(directory)
    lock_root = Path(lock_directory) if lock_directory else directory.parent
    with ExecutionLock(lock_root):
        plan = validate(directory)
        lease = lock_root / ".benchmark-owner.json"
        if lease.exists() and json.loads(lease.read_text(encoding="utf-8"))["state"] != "clean":
            if not lease_acknowledged(directory, lease):
                raise RuntimeError("Unclean previous run: audit it (--audit-interrupted or --acknowledge-lease) first")
        excluded = excluded_indices(read_audit(directory))
        writer = DurableJournal(directory)
        clean = False
        try:
            await writer.snapshot(lease, dict(state="active", run_directory=str(directory), updated_at=now()))
            executed = 0
            clean = True
            plan["status"] = "running"
            await writer.snapshot(directory / "plan.json", plan)
            for index, spec in enumerate(plan["schedule"]):
                if str(index) in plan["completed"] or index in excluded:
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
            if len(plan["completed"]) + len(excluded) == len(plan["schedule"]):
                exact = not excluded and all(c["comparable"] for c in plan["completed"].values())
                plan["status"] = "completed" if exact else "completed_with_exclusions"
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
