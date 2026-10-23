
"""Approve a previously audited v3 interruption and release the global lease."""

import argparse
import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

from audit_release_v3 import main as audit_main
from exit_link.experiments.safety import ExecutionLock, atomic_json
from exit_link.experiments.study_v3 import validate

ROOT = Path(__file__).resolve().parents[1]
MEASURED = ROOT / "data" / "measured"
OLD = (MEASURED / "v3-70c9f1ea").resolve()
NEW = (MEASURED / "v3-a5d805da").resolve()
OWNER = MEASURED / ".benchmark-owner.json"
APPROVAL = ROOT / "docs" / "v3-audit-approval-record.json"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--approve", action="store_true")
    args = parser.parse_args()

    with ExecutionLock(MEASURED):
        # Recheck evidence and live host state while holding the OS lock.
        audit_main()

        owner = json.loads(OWNER.read_text(encoding="utf-8"))
        if owner.get("state") != "needs_audit":
            raise RuntimeError("Unexpected owner state")
        if Path(owner.get("run_directory", "")).resolve() != OLD:
            raise RuntimeError("Unexpected owner directory")

        approval = json.loads(APPROVAL.read_text(encoding="utf-8-sig"))
        if (
            approval.get("old_run") != OLD.name
            or approval.get("replacement_plan") != NEW.name
            or approval.get("audit_status") != "preflight_passed"
            or approval.get("release_approved") is not False
        ):
            raise RuntimeError("Approval evidence mismatch")

        plan = validate(NEW)
        if plan["completed"] or len(plan["schedule"]) != 32:
            raise RuntimeError("Invalid replacement plan")

        if not args.approve:
            print("RELEASE_DRY_RUN_PASSED")
            print("Owner remains: needs_audit")
            return

        # Write a distinct, durable release event before changing the lease.
        event = {
            "event": "manual_audit_release",
            "approved_at": datetime.now(timezone.utc).isoformat(),
            "old_run": OLD.name,
            "replacement_plan": NEW.name,
            "previous_owner": owner,
            "completed_cells_verified": 17,
            "interrupted_cell": "t017",
            "authorization": "explicit_approve_flag",
            "old_run_replay_allowed": False,
        }

        event_path = ROOT / "docs" / (
            "v3-release-" + uuid.uuid4().hex + ".json"
        )

        with event_path.open("x", encoding="utf-8") as stream:
            json.dump(event, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())

        atomic_json(
            OWNER,
            {
                "state": "clean",
                "run_directory": str(OLD),
                "updated_at": datetime.now(timezone.utc).isoformat(),
                "released_after_audit": True,
                "release_evidence": str(event_path.relative_to(ROOT)),
            },
        )

        print("AUDIT_RELEASE_APPROVED")
        print("Previous experiment preserved:", OLD.name)
        print("Replacement experiment:", NEW.name)
        print("Release evidence:", event_path)
        print("Owner state: clean")


if __name__ == "__main__":
    main()
