"""Preflight then run all pytest tests; retain actual output and TCP process logs."""
import json
import os
import signal
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from diagnose_tcp import probe_loopback


def terminate_tree(process):
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                       capture_output=True, timeout=15)
    else:
        os.killpg(process.pid, signal.SIGKILL)
    process.wait(timeout=10)


def main():
    root = Path(__file__).resolve().parents[1]
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid4().hex[:8]
    output = root / "data/measured" / f"stage2-{run_id}"
    output.mkdir(parents=True)
    summary = {"run_id": run_id, "timestamp": datetime.now(timezone.utc).isoformat(),
               "topology_origin": "simulation", "observation_origin": "real_process",
               "preflight": probe_loopback(), "pytest_started": False, "pytest_exit_code": None}
    if not summary["preflight"]["success"]:
        summary["status"] = "blocked_before_pytest"
        (output / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        print(f"Results: {output}")
        print("Loopback preflight failed. Pytest was NOT run. See docs/tcp-diagnostics.md.")
        return 2
    temporary = output / "temp"
    temporary.mkdir()
    env = dict(os.environ, TEMP=str(temporary), TMP=str(temporary), PYTHONUTF8="1",
               EXIT_LINK_TEST_ARTIFACT_DIR=str(output / "tcp-processes"))
    command = [sys.executable, "-m", "pytest", "-v", "--basetemp", str(output / "pytest-temp")]
    summary["pytest_started"] = True
    summary["command"] = command
    print("Loopback preflight passed; running full pytest suite...", flush=True)
    process = subprocess.Popen(command, cwd=root, env=env, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, text=True, encoding="utf-8",
                               start_new_session=os.name != "nt")
    try:
        report, _ = process.communicate(timeout=180)
        (output / "pytest-results.txt").write_text(report, encoding="utf-8")
        print(report, end="")
        summary["pytest_exit_code"] = process.returncode
        summary["status"] = "passed" if process.returncode == 0 else "failed"
    except subprocess.TimeoutExpired as exc:
        terminate_tree(process)
        report, _ = process.communicate()
        (output / "pytest-results.txt").write_text(report, encoding="utf-8")
        summary["status"] = "timeout"
        summary["detail"] = str(exc)
        # A pytest hang is not a passing result.
    except KeyboardInterrupt:
        terminate_tree(process)
        summary["status"] = "interrupted"
    (output / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Results: {output}")
    return summary["pytest_exit_code"] if summary["pytest_exit_code"] is not None else 1


if __name__ == "__main__":
    raise SystemExit(main())
