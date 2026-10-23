"""Run the full suite (including the original 64) after loopback preflight."""
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from diagnose_tcp import probe_loopback
from verify_stage2 import terminate_tree


def main():
    root = Path(__file__).resolve().parents[1]
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid4().hex[:8]
    output = root / "data/measured" / f"stage3-tests-{run_id}"
    output.mkdir(parents=True)
    report = {"run_id": run_id, "preflight": probe_loopback(), "pytest_started": False,
              "pytest_exit_code": None, "status": "blocked_before_pytest"}
    code = 2
    if report["preflight"]["success"]:
        temp = output / "temp"
        temp.mkdir()
        env = dict(os.environ, PYTHONUTF8="1", TEMP=str(temp), TMP=str(temp),
                   EXIT_LINK_TEST_ARTIFACT_DIR=str(output / "stage2-processes"),
                   EXIT_LINK_STAGE3_ARTIFACT_DIR=str(output / "stage3-processes"))
        command = [sys.executable, "-m", "pytest", "-v", "--basetemp", str(output / "pytest-temp")]
        report.update(pytest_started=True, command=command)
        print("Loopback passed; running original and stage 3 tests...", flush=True)
        process = subprocess.Popen(command, cwd=root, env=env, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, text=True, encoding="utf-8",
                                   start_new_session=os.name != "nt")
        try:
            text, _ = process.communicate(timeout=240)
            code = process.returncode
            report.update(status="passed" if code == 0 else "failed", pytest_exit_code=code)
        except subprocess.TimeoutExpired:
            terminate_tree(process)
            text, _ = process.communicate()
            report.update(status="timeout")
            code = 1
        except KeyboardInterrupt:
            terminate_tree(process)
            text, _ = process.communicate()
            report.update(status="interrupted")
            code = 1
        (output / "pytest-results.txt").write_text(text, encoding="utf-8")
        print(text)
    (output / "summary.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"Results: {output}")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
