"""Temporary localhost production frontend + backend, with owned-process cleanup.

Run from PowerShell; Ctrl+C or the printed stop-file stops only this helper's children.
The one-run token stays in ignored local evidence, never a public build or command line.
"""
import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import httpx2



def main():
    root = Path(__file__).resolve().parents[1]
    output = root / "data/measured" / ("windows-ui-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid4().hex[:8])
    output.mkdir(parents=True)
    for port in (8000, 5173):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", port))
    token = secrets.token_urlsafe(32)
    (output / "control-token.local").write_text(token, encoding="utf-8")
    env = dict(os.environ, EXIT_LINK_CONTROL_TOKEN=token, EXIT_LINK_ENABLE_EXPERIMENTS="1",
               EXIT_LINK_STAGE5_ARTIFACT_DIR=str(output / "experiments"), PYTHONUTF8="1")
    executable = sys.executable
    if os.name == "nt" and sys.prefix != sys.base_prefix:
        executable = sys._base_executable
        env["__PYVENV_LAUNCHER__"] = sys.executable
    processes, handles = [], []
    report = {"status": "starting", "host": "127.0.0.1", "processes": []}
    try:
        commands = [([executable, "-m", "uvicorn", "exit_link.main:app", "--host", "127.0.0.1", "--port", "8000",
                     "--workers", "1", "--no-proxy-headers", "--ws-max-size", "4096"], root, env, "backend"),
                    ([shutil.which("node"), "node_modules/vite/bin/vite.js", "preview"], root / "frontend", os.environ.copy(), "frontend")]
        for command, cwd, child_env, label in commands:
            handle = (output / f"{label}.log").open("w", encoding="utf-8")
            handles.append(handle)
            process = subprocess.Popen(command, cwd=cwd, env=child_env, stdout=handle, stderr=subprocess.STDOUT,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            processes.append(process)
            report["processes"].append({"label": label, "pid": process.pid})
        with httpx2.Client(trust_env=False, timeout=2) as client:
            deadline = time.monotonic() + 30
            while True:
                if any(p.poll() is not None for p in processes):
                    raise RuntimeError("Validation server exited; inspect logs")
                try:
                    if client.get("http://127.0.0.1:8000/health").is_success and client.get("http://127.0.0.1:5173").is_success:
                        break
                except httpx2.TransportError:
                    pass
                if time.monotonic() >= deadline:
                    raise TimeoutError("Server readiness timeout")
                time.sleep(0.1)
        report["status"] = "running"
        (output / "servers.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(f"Evidence: {output}", flush=True)
        print("Frontend: http://127.0.0.1:5173 | Backend: http://127.0.0.1:8000", flush=True)
        print(f"Token: {output / 'control-token.local'}", flush=True)
        print(f"Stop: create {output / 'stop.local'} or press Ctrl+C (15 minute maximum)", flush=True)
        deadline = time.monotonic() + 900
        while not (output / "stop.local").exists() and time.monotonic() < deadline:
            if any(p.poll() is not None for p in processes):
                raise RuntimeError("Validation server exited")
            time.sleep(0.2)
    except KeyboardInterrupt:
        pass
    finally:
        try:
            with httpx2.Client(trust_env=False, timeout=40) as client:
                response = client.delete("http://127.0.0.1:8000/api/v1/experiment", headers={"X-Exit-Link-Token": token})
                report["experiment_cleanup_http_status"] = response.status_code
        except Exception as exc:
            report["cleanup_error"] = str(exc)
        for process in reversed(processes):
            if process.poll() is None:
                # Nodes are already stopped through the API. Keep the original
                # Popen handles: Windows sandbox taskkill enumeration may fail.
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
        for handle in handles:
            handle.close()
        report["status"] = "stopped"
        (output / "servers.json").write_text(json.dumps(report, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
