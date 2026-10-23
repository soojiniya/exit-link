"""Recorded full-stack checks, separate exit codes and explicit blocked results."""
import argparse
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit
from uuid import uuid4

from verify_stage2 import terminate_tree


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--api", help="Optional already-running localhost API for live layout comparison")
    parser.add_argument("--restart-cycles", type=int, default=20)
    parser.add_argument("--frontend-only", action="store_true", help="Recheck frontend after frontend-only changes")
    args = parser.parse_args()
    if not 1 <= args.restart_cycles <= 100:
        parser.error("restart-cycles must be 1..100")
    if args.api:
        url = urlsplit(args.api)
        if url.scheme != "http" or url.hostname not in {"127.0.0.1", "localhost", "::1"} or url.path or url.username or url.query or url.fragment:
            parser.error("api must be an HTTP loopback origin")
    root = Path(__file__).resolve().parents[1]
    output = root / "data/measured" / ("windows-validation-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid4().hex[:8])
    output.mkdir(parents=True)
    node = shutil.which("node")
    npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
    npm_cli = Path(npm).parent / "node_modules/npm/bin/npm-cli.js" if npm else None
    if os.name != "nt" and npm:
        npm_cli = Path(npm).resolve()
    phases = []
    if node and npm_cli and npm_cli.exists():
        for label in ("typecheck", "build", "verify"):
            phases.append((f"frontend-{label}", [node, str(npm_cli), "run", label], root / "frontend", 120))
        if args.api:
            phases.append(("live-layout", [node, str(npm_cli), "run", "verify:layout", "--", "--api", args.api], root / "frontend", 60))
    if not args.frontend_only:
        phases.extend([("pytest", [sys.executable, "scripts/verify_stage5.py"], root, 330),
                       ("restart-stress", [sys.executable, "scripts/diagnose_restart.py", "--cycles", str(args.restart_cycles)], root, 240)])
    summary = {"platform": sys.platform, "python": sys.version, "phases": [], "missing_frontend_tools": not bool(node and npm_cli and npm_cli.exists())}
    env = dict(os.environ, PYTHONUTF8="1")
    env.pop("EXIT_LINK_CONTROL_TOKEN", None)
    env.pop("EXIT_LINK_ENABLE_EXPERIMENTS", None)
    print(f"Evidence: {output}", flush=True)
    for label, command, cwd, timeout in phases:
        print(f"Running {label}...", flush=True)
        result = {"phase": label, "command": command, "started_at": datetime.now(timezone.utc).isoformat()}
        try:
            process = subprocess.Popen(command, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, encoding="utf-8", errors="replace", start_new_session=os.name != "nt")
            try:
                text, _ = process.communicate(timeout=timeout)
                result.update(exit_code=process.returncode,
                              status="passed" if process.returncode == 0 else "blocked" if label == "pytest" and process.returncode == 2 else "failed")
            except (subprocess.TimeoutExpired, KeyboardInterrupt):
                terminate_tree(process)
                text, _ = process.communicate()
                result.update(exit_code=None, status="timeout_or_interrupted")
            (output / f"{label}.txt").write_text(text, encoding="utf-8")
        except OSError as exc:
            result.update(exit_code=None, status="blocked", error=str(exc))
        result["ended_at"] = datetime.now(timezone.utc).isoformat()
        summary["phases"].append(result)
        (output / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"{label}: {result['status']} (exit {result['exit_code']})", flush=True)
    passed = not summary["missing_frontend_tools"] and all(p["status"] == "passed" for p in summary["phases"])
    summary["status"] = "passed" if passed else "incomplete_or_failed"
    (output / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
