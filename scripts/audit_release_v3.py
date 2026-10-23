
"""Read-only audit for interrupted aligned_v3 rehearsal."""

import hashlib
import json
from pathlib import Path
import subprocess

from exit_link.experiments.journal import inspect_journal
from exit_link.experiments.safety import ExecutionLock

ROOT = Path(__file__).resolve().parents[1]
MEASURED = ROOT / "data" / "measured"
OLD = MEASURED / "v3-70c9f1ea"
OWNER = MEASURED / ".benchmark-owner.json"


def main():
    owner = json.loads(OWNER.read_text(encoding="utf-8"))

    assert owner["state"] == "needs_audit", "Unexpected owner state"
    assert Path(owner["run_directory"]).resolve() == OLD.resolve(), "Owner mismatch"

    plan = json.loads((OLD / "plan.json").read_text(encoding="utf-8"))
    assert set(plan["completed"]) == {str(i) for i in range(17)}, "Checkpoint mismatch"

    for i in range(17):
        checkpoint = plan["completed"][str(i)]
        folder = OLD / f"t{i:03d}"
        trial_file = folder / "trial.json"

        actual_hash = hashlib.sha256(trial_file.read_bytes()).hexdigest()
        assert actual_hash == checkpoint["sha256"], f"t{i:03d}: trial hash mismatch"

        actual_journal = inspect_journal(folder / "journal.jsonl")
        assert actual_journal == checkpoint["journal_manifest"], f"t{i:03d}: journal mismatch"

    incomplete = OLD / "t017" / "trial.json"
    assert incomplete.exists(), "Interrupted cell missing"

    record = json.loads(incomplete.read_text(encoding="utf-8"))
    assert record["status"] != "completed", "Interrupted cell incorrectly completed"
    assert "17" not in plan["completed"], "Interrupted cell checkpointed"


    ports = {52112, 52113, 52114, 52115, 52116, 52117}

    process_check = subprocess.run(
        [
            "powershell.exe",
            "-NoProfile",
            "-Command",
            (
                "$ErrorActionPreference='Stop'; "
                "$p = @(Get-CimInstance Win32_Process | "
                "Where-Object { $_.Name -match '^python(w)?\\.exe$' -and "
                "$_.CommandLine -match 'exit_link\\.experiments\\.node|prepare_study_v3' }); "
                "if ($p.Count -gt 0) { exit 1 }"
            ),
        ],
        capture_output=True,
        text=True,
    )
    assert process_check.returncode == 0, "Experiment processes detected or audit failed"

    port_check = subprocess.run(
        [
            "powershell.exe",
            "-NoProfile",
            "-Command",
            (
                "$ErrorActionPreference='Stop'; "
                "$ports = 52112..52117; "
                "$p = @(Get-NetTCPConnection -State Listen | "
                "Where-Object { $_.LocalPort -in $ports }); "
                "if ($p.Count -gt 0) { exit 1 }"
            ),
        ],
        capture_output=True,
        text=True,
    )
    assert port_check.returncode == 0, "Experiment ports occupied or audit failed"

    print("HOST_AUDIT_PASSED")

    print("READ_ONLY_AUDIT_PASSED")
    print("Completed cell hashes: 17/17")
    print("Completed journals: 17/17")
    print("Interrupted t017: preserved")
    print("Owner state: needs_audit (unchanged)")


if __name__ == "__main__":
    with ExecutionLock(MEASURED):
        main()