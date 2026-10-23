"""Case-scoped, provenance-bound continuation for t399..t479; default is read only.

No original protocol/source file is modified. Release needs separate explicit
human authorization, bound owner evidence and a fresh successful host audit.
"""
import argparse
import asyncio
import hashlib
import json
import os
import random
import re
from pathlib import Path
import socket
import subprocess
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from uuid import uuid4

from exit_link.experiments.journal import inspect_journal, settle
from exit_link.experiments.safety import ExecutionLock, atomic_json
from exit_link.experiments.study import design_hash, runtime_environment
from exit_link.experiments.study_v3 import SETTINGS, source_hashes
from exit_link.experiments.comparison import CONDITIONS, METHODS

PURPOSE = "aligned_v3_residual_399_479_v1"
INDICES = list(range(399, 480))


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode()


def load(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def tool_hash():
    return digest(Path(__file__).read_bytes())


def tree_hashes(root):
    root = Path(root).resolve()
    files = list(root.rglob("*"))
    if any(p.is_symlink() or p.is_junction() for p in files):
        raise ValueError("Linked evidence paths require manual audit")
    return {str(p.relative_to(root)): digest(p.read_bytes()) for p in sorted(files) if p.is_file()}


def separate(source, target):
    source, target = Path(source).resolve(), Path(target).resolve()
    if source == target or source in target.parents or target in source.parents:
        raise ValueError("Output must be separate from the original evidence tree")
    return target


def output_path(target, path, source):
    target, path = Path(target).resolve(), Path(path).resolve()
    separate(source, path)
    if target not in path.parents:
        raise ValueError("Continuation output escaped its own directory")
    return path


def original_schedule(seed, repetitions):
    strata = [(c,t) for c in CONDITIONS for t in (["none"] if c=="normal" else ["before_send"] if c=="no_route" else ["before_send","inflight"])]
    rng = random.Random(seed)
    first = {s:rng.randrange(2) for s in strata}
    result = []
    for repetition in range(repetitions):
        order = strata.copy()
        rng.shuffle(order)
        for condition,timing in order:
            methods = list(METHODS)
            if (first[condition,timing]+repetition)%2:
                methods.reverse()
            for method in methods:
                result.append(dict(condition=condition,fault_timing=timing,method=method,repetition=repetition,
                                   warmup_extra_seconds=(repetition%3)*.033))
    return result


def identify_current_launcher(value):
    """Exclude only a proven venv launcher for this exact CLI, never a peer."""
    value["verified_launcher"] = None
    if sys.prefix == sys.base_prefix:
        return
    own_pid, parent_pid = os.getpid(), os.getppid()
    identities = {p["ProcessId"]: p for p in value.get("self_identity", [])}
    current, parent = identities.get(own_pid), identities.get(parent_pid)
    if not current or not parent or current.get("ParentProcessId") != parent_pid:
        return
    if not any(p["ProcessId"] == parent_pid for p in value["nodes"]):
        return
    def executable(entry, expected):
        return bool(entry.get("ExecutablePath")) and Path(entry["ExecutablePath"]).resolve() == Path(expected).resolve()
    def arguments(entry):
        match = re.fullmatch(r'\s*(?:"[^"\r\n]+"|[^\s"]+)\s+(.+)', entry.get("CommandLine") or "")
        return match.group(1) if match else None
    if not executable(current, sys._base_executable) or not executable(parent, sys.executable):
        return
    args = arguments(current)
    if not args or args != arguments(parent):
        return
    cli = re.match(r'^(?:"([^"\r\n]+)"|([^\s"]+))\s+execute(?:\s|$)', args)
    if not cli or Path(cli.group(1) or cli.group(2)).resolve() != Path(__file__).resolve():
        return
    try:
        parent_time = datetime.fromisoformat(parent["CreationUtc"])
        current_time = datetime.fromisoformat(current["CreationUtc"])
        if parent_time.tzinfo is None or current_time.tzinfo is None or parent_time > current_time:
            return
    except (KeyError, TypeError, ValueError):
        return
    children = [p for p in value.get("children", []) if p.get("ParentProcessId") == parent_pid]
    if len(children) != 1 or children[0]["ProcessId"] != own_pid:
        return
    value["verified_launcher"] = dict(parent=parent, current=current, reason="same_cli_venv_launcher")
    value["nodes"] = [p for p in value["nodes"] if p["ProcessId"] != parent_pid]
    value["children"] = [p for p in value["children"] if not (p["ProcessId"] == own_pid and p.get("ParentProcessId") == parent_pid)]


def host_observation(ports):
    """No process termination or connections; unavailable CIM is never 'empty'."""
    if os.name != "nt":
        return dict(status="unavailable", reason="Windows host audit required", ready=False)
    command = r"""$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8
try {
 $all=@(Get-CimInstance Win32_Process)
 $identity=@($all | Where-Object { $_.ProcessId -eq @SELF@ -or $_.ProcessId -eq @PARENT@ } |
 Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,@{Name='CreationUtc';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}})
 $unknown=@($all | Where-Object { $_.Name -match '^python(w)?\.exe$' -and [string]::IsNullOrWhiteSpace($_.CommandLine) } |
 Select-Object ProcessId,ParentProcessId,CreationDate,Name)
 $nodes=@($all | Where-Object {
  $_.Name -match '^python(w)?\.exe$' -and $_.ProcessId -ne @SELF@ -and
  ($_.CommandLine -match 'exit_link\.(experiments\.(fixed_node|node)|communication)(\s|$)' -or
   $_.CommandLine -match 'prepare_study_v3\.py.*--execute|recovery_v3\.py\s+execute')
 } | Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine)
 $listeners=@(Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in @PORTS@ } |
 Select-Object LocalAddress,LocalPort,OwningProcess)
 $children=@($all | Where-Object { $_.ParentProcessId -in @($nodes.ProcessId) } |
 Select-Object ProcessId,ParentProcessId,CreationDate,Name,CommandLine)
 @{status='observed';nodes=$nodes;children=$children;unknown_processes=$unknown;listeners=$listeners;self_identity=$identity} | ConvertTo-Json -Depth 7 -Compress
} catch { @{status='unavailable';reason=$_.Exception.Message} | ConvertTo-Json -Compress }
""".replace("@PORTS@", "@(" + ",".join(str(int(p)) for p in ports) + ")").replace("@SELF@", str(os.getpid())).replace("@PARENT@", str(os.getppid()))
    try:
        result = subprocess.run(["powershell.exe", "-NoProfile", "-Command", command], capture_output=True, timeout=25)
        if result.returncode:
            return dict(status="unavailable", reason="Host command failed", exit_code=result.returncode,
                        stderr=result.stderr.decode("utf-8", errors="replace")[:1500], ready=False)
        value = json.loads(result.stdout.decode("utf-8-sig"))
        if value.get("status") != "observed":
            return dict(**value, ready=False)
        # Do not count this audit/approved runner as a foreign active runner.
        value["nodes"] = [n for n in value["nodes"] if n["ProcessId"] != os.getpid()]
        identify_current_launcher(value)
        probes = []
        if not value["nodes"] and not value["listeners"] and not value.get("unknown_processes") and not value.get("children"):
            for port in ports:
                try:
                    with socket.socket() as probe:
                        probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
                        probe.bind(("127.0.0.1", port))
                    probes.append(dict(port=port, available=True))
                except OSError as exc:
                    probes.append(dict(port=port, available=False, error=str(exc)))
        value["bind_probes"] = probes
        value["ready"] = bool(not value["nodes"] and not value["listeners"] and not value.get("unknown_processes")
                              and not value.get("children") and len(probes) == len(ports)
                              and all(p["available"] for p in probes))
        return value
    except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
        return dict(status="unavailable", reason=str(exc), ready=False)


def pair_counts(plan, cells):
    groups = defaultdict(dict)
    strata = defaultdict(lambda: dict(completed_fixed=0, completed_exit_link=0,
        comparable_fixed=0, comparable_exit_link=0, valid_pairs=0, residual_cells=0))
    for index, cell in cells.items():
        spec = plan["schedule"][index]
        key = spec["condition"], spec["fault_timing"]
        eligible = bool(index != 398 and cell["status"] == "completed" and cell["comparable"])
        strata[key]["completed_"+spec["method"]] += int(index < 398)
        strata[key]["comparable_"+spec["method"]] += int(eligible)
        groups[key+(spec["repetition"],)][spec["method"]] = dict(index=index, eligible=eligible)
    for index in INDICES:
        spec = plan["schedule"][index]
        strata[spec["condition"], spec["fault_timing"]]["residual_cells"] += 1
    unmatched = []
    for key, methods in groups.items():
        if len(methods) == 2 and all(v["eligible"] for v in methods.values()):
            strata[key[:2]]["valid_pairs"] += 1
        else:
            unmatched.append(dict(condition=key[0], fault_timing=key[1], repetition=key[2], members=methods))
    return dict(strata=[dict(condition=k[0], fault_timing=k[1], **v) for k, v in sorted(strata.items())],
                valid_pairs=sum(s["valid_pairs"] for s in strata.values()), unmatched=unmatched)


def audit(source, observer=host_observation):
    """Strict case audit. Does not call legacy validate/execute or acquire a lock."""
    source = Path(source).resolve()
    plan = load(source/"plan.json")
    errors, cells = [], {}
    if plan.get("protocol_version") != "aligned_v3" or plan.get("purpose") != "contest_main_study":
        raise ValueError("Not the requested aligned_v3 parent study")
    if len(plan["schedule"]) != 480 or plan["repetitions"] != 30 or plan["settings"] != SETTINGS:
        raise ValueError("Unexpected original study profile")
    if plan["design_sha256"] != design_hash(plan):
        errors.append("parent_design_hash_mismatch")
    if plan["schedule"] != original_schedule(plan["seed"], plan["repetitions"]):
        errors.append("parent_schedule_differs_from_seeded_design")
    if set(plan["completed"]) != {str(i) for i in range(398)}:
        errors.append("expected_exactly_checkpoints_0_through_397")
    expected_dirs = {f"t{i:03}" for i in range(399)}
    actual_dirs = {p.name for p in source.glob("t[0-9][0-9][0-9]") if p.is_dir()}
    if actual_dirs != expected_dirs:
        errors.append("unexpected_or_missing_cell_directories")
    message_ids = set()
    for index in range(399):
        folder = source/f"t{index:03}"
        try:
            cell = load(folder/"trial.json")
            cells[index] = cell
            if any(cell[k] != v for k, v in plan["schedule"][index].items()):
                errors.append(f"t{index:03}:identity_mismatch")
            if cell.get("protocol_version") != "aligned_v3":
                errors.append(f"t{index:03}:protocol_mismatch")
            if len(cell.get("messages", [])) != 3:
                errors.append(f"t{index:03}:message_count")
            for message in cell.get("messages", []):
                if message["message_id"] in message_ids:
                    errors.append(f"t{index:03}:duplicate_message_id")
                message_ids.add(message["message_id"])
            manifest = inspect_journal(folder/"journal.jsonl")
            if manifest != cell.get("journal_manifest"):
                errors.append(f"t{index:03}:trial_journal_mismatch")
            if index < 398:
                checkpoint = plan["completed"].get(str(index), {})
                if checkpoint.get("sha256") != digest((folder/"trial.json").read_bytes()) or checkpoint.get("journal_manifest") != manifest:
                    errors.append(f"t{index:03}:checkpoint_mismatch")
                if cell.get("status") != "completed" or checkpoint.get("comparable") != cell["comparable"]:
                    errors.append(f"t{index:03}:completion_mismatch")
                if index == 122:
                    if cell["comparable"] or cell.get("error", {}).get("type") != "schedule_deviation":
                        errors.append("t122:exclusion_changed")
                elif not cell["comparable"]:
                    errors.append(f"t{index:03}:undeclared_exclusion")
            elif cell.get("status") != "failed" or cell["comparable"] or cell.get("cleanup", {}).get("normal_stop_confirmed"):
                errors.append("t398:failure_identity_changed")
        except (OSError, ValueError, KeyError, TypeError) as exc:
            errors.append(f"t{index:03}:{type(exc).__name__}:{exc}")
    hashes = tree_hashes(source)
    current = source_hashes()
    source_diff = [k for k in sorted(set(current)|set(plan["source_sha256"])) if current.get(k) != plan["source_sha256"].get(k)]
    failed = cells.get(398, {})
    ports = [n["port"] for n in failed.get("topology", {}).get("nodes", [])]
    owner_path = source.parent/".benchmark-owner.json"
    owner = load(owner_path) if owner_path.exists() else dict(state="missing")
    return dict(schema="parent_recovery_audit_v1", parent_directory=str(source),
        original_run_id=plan["run_id"], errors=errors, data_integrity=not errors,
        parent_plan_sha256=digest((source/"plan.json").read_bytes()),
        tree_sha256=digest(canonical(hashes)), file_hashes=hashes,
        source_matches=not source_diff, source_differences=source_diff,
        environment_matches=plan["environment"] == runtime_environment(),
        completed_cells=len(plan["completed"]), comparable_cells=sum(c.get("comparable", False) for i,c in cells.items() if i<398),
        failure_398=dict(status=failed.get("status"), cleanup=failed.get("cleanup"), journal_manifest=failed.get("journal_manifest")),
        exclusions=[dict(original_index=122, reason="schedule_deviation"),dict(original_index=398, reason="cleanup_failure_uncheckpointed")],
        pair_summary=pair_counts(plan, cells), ports=ports,
        owner_state=owner, owner_file_sha256=digest(owner_path.read_bytes()) if owner_path.exists() else None,
        host=observer(ports), original_resume_blocker="uncheckpointed_t398; no exclusion/adoption policy in legacy runner",
        automatic_merge=False)


def prepare(source, target, observer=host_observation):
    target = separate(source, target)
    report = audit(source, observer)
    if not report["data_integrity"] or not report["source_matches"] or not report["environment_matches"]:
        raise ValueError("Original integrity/source/runtime mismatch; no continuation prepared")
    parent = Path(source).resolve()
    plan = load(parent/"plan.json")
    manifest = dict(schema=PURPOSE, followup_id=str(uuid4()), executable_only_after_human_approval=True,
        original_directory=str(parent), original_run_id=plan["run_id"],
        parent_plan_sha256=report["parent_plan_sha256"], parent_tree_sha256=report["tree_sha256"],
        protocol_version=plan["protocol_version"], source_sha256=plan["source_sha256"],
        environment=plan["environment"], seed=plan["seed"], repetitions=plan["repetitions"],
        settings=plan["settings"], topology=plan["topology"], recovery_tool_sha256=tool_hash(),
        cells=[dict(original_index=i, specification=plan["schedule"][i]) for i in INDICES],
        exclusions=report["exclusions"], automatic_merge=False,
        analysis_policy="valid_matched_pairs_only; t123/t399 are unmatched when counterparts are excluded")
    target.mkdir(parents=True, exist_ok=False)
    # Destination is new and outside the source; the snapshot is provenance,
    # never a modified executable copy of the original plan.
    (target/"parent-plan.snapshot.json").write_bytes((parent/"plan.json").read_bytes())
    atomic_json(target/"audit.json", report)
    manifest["audit_report_sha256"] = digest((target/"audit.json").read_bytes())
    atomic_json(target/"manifest.json", manifest)
    atomic_json(target/"progress.json", dict(schema=PURPOSE, manifest_sha256=digest((target/"manifest.json").read_bytes()), completed={}))
    return manifest


def verify(target, observer=host_observation):
    target = Path(target).resolve()
    manifest = load(target/"manifest.json")
    if manifest.get("schema") != PURPOSE:
        raise ValueError("Not a residual plan; never execute a parent plan through this tool")
    source = Path(manifest["original_directory"])
    separate(source, target)
    if any(p.is_symlink() or p.is_junction() for p in target.rglob("*")):
        raise ValueError("Linked continuation output is forbidden")
    if manifest["recovery_tool_sha256"] != tool_hash():
        raise ValueError("Recovery tool changed; do not resign an existing manifest")
    if digest((target/"audit.json").read_bytes()) != manifest.get("audit_report_sha256"):
        raise ValueError("Provenance audit report changed")
    report = audit(source, observer)
    if not report["data_integrity"] or not report["source_matches"] or not report["environment_matches"]:
        raise ValueError("Original source/data/runtime mismatch")
    if report["tree_sha256"] != manifest["parent_tree_sha256"] or report["parent_plan_sha256"] != manifest["parent_plan_sha256"]:
        raise ValueError("Original evidence changed")
    if digest((target/"parent-plan.snapshot.json").read_bytes()) != manifest["parent_plan_sha256"]:
        raise ValueError("Provenance snapshot changed")
    original = load(source/"plan.json")
    for key in ("seed", "repetitions", "settings", "topology", "source_sha256", "environment", "protocol_version"):
        if manifest[key] != original[key]:
            raise ValueError("Continuation conditions differ from original")
    if manifest["cells"] != [dict(original_index=i, specification=original["schedule"][i]) for i in INDICES]:
        raise ValueError("Residual schedule must be exactly original t399..t479 in order")
    if manifest["exclusions"] != report["exclusions"] or manifest.get("automatic_merge") is not False:
        raise ValueError("Exclusion/merge policy changed")
    progress = load(target/"progress.json")
    if progress.get("schema") != PURPOSE or progress["manifest_sha256"] != digest((target/"manifest.json").read_bytes()):
        raise ValueError("Progress/manifest mismatch")
    completed = progress["completed"]
    if set(completed) != {str(i) for i in INDICES[:len(completed)]}:
        raise ValueError("Noncontiguous or forbidden completion identity")
    folders = target/"cells"
    if folders.exists() and {p.name for p in folders.iterdir()} - {f"t{i:03}" for i in INDICES}:
        raise ValueError("Forbidden cell in continuation output")
    for spec in manifest["cells"]:
        i = spec["original_index"]
        folder = output_path(target, folders/f"t{i:03}", source)
        checkpoint = completed.get(str(i))
        if checkpoint:
            cell = load(folder/"trial.json")
            if cell.get("status") != "completed" or not cell.get("journal_manifest") or cell.get("recording_errors"):
                raise ValueError("Incomplete cell cannot be adopted")
            if any(cell[k] != v for k,v in spec["specification"].items()):
                raise ValueError("Recorded cell identity mismatch")
            if checkpoint["sha256"] != digest((folder/"trial.json").read_bytes()) or checkpoint["journal_manifest"] != inspect_journal(folder/"journal.jsonl"):
                raise ValueError("Completed continuation data damaged")
            if checkpoint["comparable"] != cell["comparable"]:
                raise ValueError("Comparison status changed")
        elif folder.exists():
            raise RuntimeError("Uncheckpointed continuation cell preserved; no automatic replay")
    return manifest, progress, report


def check_approval(target, approval_path, max_cells):
    if not 1 <= max_cells <= 81:
        raise ValueError("Explicit execution bound must be 1..81")
    approval = load(approval_path)
    if approval.get("schema") != "residual_execution_approval_v1" or approval.get("approved") is not True or not approval.get("approved_by") or not approval.get("approved_at"):
        raise PermissionError("Explicit human approval required")
    if approval.get("manifest_sha256") != digest((Path(target)/"manifest.json").read_bytes()) or approval.get("recovery_tool_sha256") != tool_hash():
        raise PermissionError("Approval is not bound to this manifest/tool")
    if approval.get("max_cells", 0) < max_cells:
        raise PermissionError("Execution exceeds approved bound")
    return approval


class HostAuditError(RuntimeError):
    def __init__(self, report):
        self.report = report
        super().__init__("Fresh host process/listener/bind audit not confirmed: " + json.dumps(report, ensure_ascii=True, sort_keys=True))


def execution_preflight(target, approval_path, max_cells, observer=host_observation):
    approval = check_approval(target, approval_path, max_cells)
    manifest, progress, report = verify(target, observer)
    if report["owner_state"].get("state") != "clean":
        raise RuntimeError("Global owner is not clean; separate audited release required")
    if not report["host"].get("ready"):
        raise HostAuditError(report["host"])
    if progress["completed"] and not all(c["comparable"] for c in progress["completed"].values()):
        raise RuntimeError("Excluded continuation cell requires review before further execution")
    return approval, manifest, progress, report


def release_after_audit(target, approval_path, observer=host_observation):
    """Never called by audit/prepare/dry-run/execute; explicit approved action only."""
    target = Path(target).resolve()
    approval = check_approval(target, approval_path, 1)
    if approval.get("release_approved") is not True:
        raise PermissionError("Separate explicit audit-release approval required")
    manifest, _, _ = verify(target, observer)
    owner_path = Path(manifest["original_directory"]).parent/".benchmark-owner.json"
    with ExecutionLock(owner_path.parent):
        # Revalidate under the same OS lock; a stored audit is not a current audit.
        manifest, _, report = verify(target, observer)
        owner_bytes = owner_path.read_bytes()
        owner = json.loads(owner_bytes)
        if owner.get("state") != "needs_audit" or Path(owner["run_directory"]).resolve() != Path(manifest["original_directory"]).resolve():
            raise RuntimeError("Lease is not the audited original interruption")
        if approval.get("owner_file_sha256") != digest(owner_bytes):
            raise PermissionError("Release approval does not bind the current owner evidence")
        if not report["host"].get("ready"):
            raise RuntimeError("Host audit unavailable/busy; owner remains needs_audit")
        record_path = output_path(target, target/"release-audits"/(uuid4().hex+".json"), manifest["original_directory"])
        record = dict(kind="explicit_audited_release", approval=approval, previous_owner=owner,
            parent_tree_sha256=report["tree_sha256"], source_sha256=manifest["source_sha256"],
            recovery_tool_sha256=tool_hash(), host=report["host"],
            parent_failure_retained=True, adopted_or_reexecuted_cells=[], timestamp=datetime.now(timezone.utc).isoformat())
        record_path.parent.mkdir(parents=True, exist_ok=True)
        if record_path.exists():
            raise FileExistsError("Release evidence cannot overwrite a prior record")
        atomic_json(record_path, record)  # Evidence commits before the lease transition.
        atomic_json(owner_path, dict(state="clean", run_directory=manifest["original_directory"],
                                    audited_release_record=str(record_path), updated_at=record["timestamp"]))
    return record_path


async def execute(target, approval_path, max_cells, *, observer=host_observation, runner=None):
    """Separate approved driver, with all lifecycle checks, never legacy adoption."""
    target = Path(target).resolve()
    approval, manifest, progress, report = execution_preflight(target, approval_path, max_cells, observer)
    lock_root = Path(manifest["original_directory"]).parent
    with ExecutionLock(lock_root):
        approval, manifest, progress, report = execution_preflight(target, approval_path, max_cells, observer)
        owner_path = lock_root/".benchmark-owner.json"
        # Execute never releases needs_audit; the separate audit-release verb does.
        if not owner_path.exists() or load(owner_path).get("state") != "clean":
            raise RuntimeError("Global owner is not clean; separate audited release required")
        if not report["host"].get("ready"):
            raise RuntimeError("Fresh host process/listener/bind audit not confirmed")
        if progress["completed"] and not all(c["comparable"] for c in progress["completed"].values()):
            raise RuntimeError("Excluded continuation cell requires review before further execution")
        if runner is None:
            from exit_link.experiments.aligned_v3 import trial
            runner = trial
        attempt = output_path(target, target/"runs"/uuid4().hex, manifest["original_directory"])
        attempt.mkdir(parents=True, exist_ok=False)
        await asyncio.to_thread(atomic_json, attempt/"approval.json", approval)
        await asyncio.to_thread(atomic_json, attempt/"host.json", report["host"])
        clean = False
        try:
            _, cancelled = await settle(asyncio.to_thread(atomic_json, owner_path, dict(state="active", run_directory=str(target), updated_at=datetime.now(timezone.utc).isoformat())))
            if cancelled:
                raise asyncio.CancelledError
            executed = 0
            clean = True
            for entry in manifest["cells"]:
                index = entry["original_index"]
                if str(index) in progress["completed"]:
                    continue
                clean = False
                folder = output_path(target, target/"cells"/f"t{index:03}", manifest["original_directory"])
                if folder.exists():
                    raise RuntimeError("Cell already attempted; no replay")
                cell = await runner(folder, entry["specification"])
                cleanup = cell.get("cleanup", {})
                if cell.get("status") != "completed" or not cell.get("journal_manifest") or cell.get("recording_errors"):
                    raise RuntimeError("Failed/incomplete continuation cell retained without checkpoint")
                if any(cell[k] != v for k,v in entry["specification"].items()) or cell.get("protocol_version") != "aligned_v3":
                    raise RuntimeError("Result identity/protocol mismatch")
                if load(folder/"trial.json") != cell:
                    raise RuntimeError("In-memory and durable result disagree")
                actual_manifest = await asyncio.to_thread(inspect_journal, folder/"journal.jsonl")
                if actual_manifest != cell["journal_manifest"] or not actual_manifest["entries"]:
                    raise RuntimeError("Invalid result journal")
                clean = bool(cleanup.get("normal_stop_confirmed") and cleanup.get("all_owned_processes_exited")
                    and cleanup.get("ports") and all(p["available"] for p in cleanup["ports"]))
                if not clean:
                    raise RuntimeError("Cleanup failed: original failed result retained without completion checkpoint")
                progress["completed"][str(index)] = dict(sha256=digest((folder/"trial.json").read_bytes()),
                    journal_manifest=actual_manifest, comparable=cell["comparable"])
                _, cancelled = await settle(asyncio.to_thread(atomic_json, target/"progress.json", progress))
                if cancelled:
                    raise asyncio.CancelledError
                executed += 1
                if not clean or not cell["comparable"] or executed >= max_cells:
                    break
        except BaseException:
            clean = False
            raise
        finally:
            _, cancelled = await settle(asyncio.to_thread(atomic_json, owner_path, dict(state="clean" if clean else "needs_audit",
                run_directory=str(target), updated_at=datetime.now(timezone.utc).isoformat())))
            if cancelled:
                await settle(asyncio.to_thread(atomic_json, owner_path, dict(state="needs_audit", run_directory=str(target))))
                raise asyncio.CancelledError
    return progress


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    a = sub.add_parser("audit")
    a.add_argument("source", type=Path)
    a.add_argument("--output", type=Path)
    p = sub.add_parser("prepare")
    p.add_argument("source", type=Path)
    p.add_argument("target", type=Path)
    v = sub.add_parser("dry-run")
    v.add_argument("target", type=Path)
    e = sub.add_parser("execute")
    e.add_argument("target", type=Path)
    e.add_argument("--approval", required=True, type=Path)
    e.add_argument("--max-cells", required=True, type=int)
    e.add_argument("--preflight-only", action="store_true", help="Audit the real execute CLI context, then exit without a lock, write, event loop or node")
    r = sub.add_parser("release-after-audit")
    r.add_argument("target", type=Path)
    r.add_argument("--approval", required=True, type=Path)
    args = parser.parse_args()
    if args.command == "audit":
        if args.output:
            separate(args.source, args.output)
            if args.output.exists():
                raise FileExistsError("Audit output will not overwrite existing files")
        report = audit(args.source)
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            with args.output.open("x", encoding="utf-8") as stream:
                json.dump(report, stream, ensure_ascii=False, indent=2)
        print(json.dumps({k:v for k,v in report.items() if k != "file_hashes"}, ensure_ascii=True, indent=2))
        return 0 if report["data_integrity"] else 1
    if args.command == "prepare":
        manifest = prepare(args.source, args.target)
        print("Prepared separate residual plan:", args.target, "cells:", len(manifest["cells"]), "executed: 0")
        return 0
    if args.command == "dry-run":
        manifest, progress, report = verify(args.target)
        print(json.dumps(dict(status="plan_verified_no_execution", first=399, last=479, planned=len(manifest["cells"]),
            completed=len(progress["completed"]), owner_state=report["owner_state"].get("state"), host=report["host"],
            execution_ready=report["host"].get("ready", False) and report["owner_state"].get("state") == "clean",
            human_approval_required=True, automatic_merge=False), ensure_ascii=True, indent=2))
        return 0
    if args.command == "release-after-audit":
        print("Audited release record:", release_after_audit(args.target, args.approval))
        return 0
    _, _, _, preflight = execution_preflight(args.target, args.approval, args.max_cells)
    if args.preflight_only:
        print(json.dumps(dict(status="execute_preflight_only_no_execution", host=preflight["host"]), ensure_ascii=True, indent=2))
        return 0
    if __package__:
        from .prepare_study_v3 import interruptible
    else:
        from prepare_study_v3 import interruptible
    try:
        return_value = asyncio.run(interruptible(execute(args.target, args.approval, args.max_cells)))
    except (asyncio.CancelledError, KeyboardInterrupt):
        print("Interrupted; attempted cells retained. No replay or lease release performed.")
        return 130
    print("Completed continuation cells:", len(return_value["completed"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
