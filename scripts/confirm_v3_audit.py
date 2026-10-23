"""Preflight for explicit aligned_v3 audit approval. No lease changes."""

import json
from pathlib import Path

from audit_release_v3 import main as audit_main
from exit_link.experiments.safety import ExecutionLock

ROOT = Path(__file__).resolve().parents[1]
MEASURED = ROOT / "data" / "measured"
OWNER = MEASURED / ".benchmark-owner.json"
OLD = (MEASURED / "v3-70c9f1ea").resolve()
NEW = MEASURED / "v3-a5d805da"


def main():
    with ExecutionLock(MEASURED):
        # Revalidate completed files, journals, interrupted cell,
        # running processes, and listener ports under one OS lock.
        audit_main()

        owner = json.loads(OWNER.read_text(encoding="utf-8"))

        if owner.get("state") != "needs_audit":
            raise RuntimeError("Owner is not awaiting audit")

        if Path(owner["run_directory"]).resolve() != OLD:
            raise RuntimeError("Unexpected previous run")

        old_plan = json.loads(
            (OLD / "plan.json").read_text(encoding="utf-8")
        )
        if set(old_plan["completed"]) != {str(i) for i in range(17)}:
            raise RuntimeError("Unexpected completed cells")

        if not (OLD / "t017" / "trial.json").exists():
            raise RuntimeError("Interrupted evidence missing")

        if not (NEW / "plan.json").exists():
            raise RuntimeError("Replacement plan missing")

        print("AUDIT_APPROVAL_PREFLIGHT_PASSED")
        print("Previous run: v3-70c9f1ea")
        print("Replacement plan: v3-a5d805da")
        print("Lease remains: needs_audit")
        print("No experiment executed; no release performed")


if __name__ == "__main__":
    main()
