
"""Preflight before releasing an audited aligned_v3 execution lease.

This script performs no owner-state changes.
"""

import json
from pathlib import Path

from audit_release_v3 import main as audit_main
from exit_link.experiments.safety import ExecutionLock
from exit_link.experiments.study_v3 import validate

ROOT = Path(__file__).resolve().parents[1]
MEASURED = ROOT / "data" / "measured"

OLD = (MEASURED / "v3-70c9f1ea").resolve()
NEW = (MEASURED / "v3-a5d805da").resolve()
OWNER = MEASURED / ".benchmark-owner.json"
APPROVAL_RECORD = ROOT / "docs" / "v3-audit-approval-record.json"


def main():
    with ExecutionLock(MEASURED):
        # This function checks existing cell hashes, journals,
        # the interrupted trial, processes, and TCP ports.
        # It must not acquire ExecutionLock a second time.
        audit_main()

        owner = json.loads(OWNER.read_text(encoding="utf-8"))
        if owner.get("state") != "needs_audit":
            raise RuntimeError("Unexpected owner state")

        if Path(owner["run_directory"]).resolve() != OLD:
            raise RuntimeError("Unexpected old run")

        approval = json.loads(
            APPROVAL_RECORD.read_text(encoding="utf-8-sig")
        )

        if approval.get("old_run") != OLD.name:
            raise RuntimeError("Audit record: old run mismatch")

        if approval.get("replacement_plan") != NEW.name:
            raise RuntimeError("Audit record: replacement mismatch")

        if approval.get("audit_status") != "preflight_passed":
            raise RuntimeError("Audit record not validated")

        if approval.get("release_approved") is not False:
            raise RuntimeError("Unexpected approval record state")

        # Validate the new plan without starting TCP nodes.
        plan = validate(NEW)

        if plan["completed"]:
            raise RuntimeError("Replacement plan is not empty")

        if len(plan["schedule"]) != 32:
            raise RuntimeError("Unexpected replacement cell count")

        print("RELEASE_PREFLIGHT_PASSED")
        print("Old run remains preserved:", OLD.name)
        print("New plan validated:", NEW.name)
        print("Owner state remains: needs_audit")
        print("No release performed")


if __name__ == "__main__":
    main()
