"""Run all regressions and actual HTTP/WS/TCP tests; preserve evidence, never fake success."""
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from diagnose_tcp import probe_loopback
from verify_stage2 import terminate_tree


def pytest_command(output):
    # Leave room for pytest's 31-character fixture names and atomic .json.tmp
    # evidence files on Windows hosts that still enforce MAX_PATH.
    return [sys.executable, "-m", "pytest", "-v", "--tb=short", "--basetemp", str(output / "p")]


def main():
    root = Path(__file__).resolve().parents[1]
    output = root / "data/measured" / ("stage5-tests-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid4().hex[:8])
    output.mkdir(parents=True)
    report = {"preflight": probe_loopback(), "pytest_started": False, "pytest_exit_code": None,
              "status": "blocked_before_pytest", "transport": "real_tcp_loopback"}
    code = 2
    if report["preflight"]["success"]:
        temp = output / "temp"
        temp.mkdir()
        env = dict(os.environ, PYTHONUTF8="1", TEMP=str(temp), TMP=str(temp),
            EXIT_LINK_TEST_ARTIFACT_DIR=str(output / "stage2-processes"),
            EXIT_LINK_STAGE3_ARTIFACT_DIR=str(output / "stage3-processes"),
            EXIT_LINK_STAGE4_ARTIFACT_DIR=str(output / "stage4-processes"),
            EXIT_LINK_STAGE5_ARTIFACT_DIR=str(output / "stage5-backend"),
            EXIT_LINK_SQLITE_ARTIFACT_DIR=str(output / "sqlite-backend"))
        # Test secrets are created inside the integration fixture, never printed in reports.
        env.pop("EXIT_LINK_CONTROL_TOKEN", None)
        env.pop("EXIT_LINK_ENABLE_EXPERIMENTS", None)
        env.pop("EXIT_LINK_DATABASE_PATH", None)
        env.pop("EXIT_LINK_PERSISTENCE_ENABLED", None)
        command = pytest_command(output)
        report.update(pytest_started=True, command=command)
        print("Loopback passed; running stage 1-5 regressions and real HTTP/WS/TCP integration...", flush=True)
        process = subprocess.Popen(command, cwd=root, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", start_new_session=os.name != "nt")
        try:
            text, _ = process.communicate(timeout=300)
            code = process.returncode
            report.update(status="passed" if code == 0 else "failed", pytest_exit_code=code)
        except (subprocess.TimeoutExpired, KeyboardInterrupt) as exc:
            terminate_tree(process)
            text, _ = process.communicate()
            report.update(status=type(exc).__name__)
            code = 1
        (output / "pytest-results.txt").write_text(text, encoding="utf-8")
        print(text)
    (output / "summary.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"Results: {output}")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
