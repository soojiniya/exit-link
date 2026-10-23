"""Owned localhost subprocesses for real fault experiments (not graph simulation)."""
import asyncio
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

from exit_link.communication.client import get_status, stop_node
from exit_link.communication.protocol import utc_now
from exit_link.topology.loader import load_communication
from exit_link.topology.models import CommunicationTopology
from exit_link.simulation.diagnostics import port_evidence


class NodeStartError(RuntimeError):
    def __init__(self, node_id, record):
        self.record = record
        super().__init__(f"Node {node_id} startup failed: " + json.dumps(record["failure"], ensure_ascii=False))


def read_events(path):
    records = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return records


class LocalCluster:
    node_module = "exit_link.communication"

    def __init__(self, directory, relay_delay=0.35):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.processes, self.logs, self.handles, self.history, self.faults = {}, {}, [], [], []
        self.relay_delay = relay_delay
        data = load_communication().model_dump()
        reservations = []
        try:
            for node in data["nodes"]:
                sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                sock.bind(("127.0.0.1", 0))
                reservations.append(sock)
                node["port"] = sock.getsockname()[1]
            self.topology = CommunicationTopology.model_validate(data)
        finally:
            for sock in reservations:
                sock.close()
        self.path = self.directory / "communication.json"
        self.path.write_text(self.topology.model_dump_json(indent=2), encoding="utf-8")

    def start(self, node_id):
        config = next((node for node in self.topology.nodes if node.id == node_id), None)
        if config is None:
            raise ValueError(f"Unknown node: {node_id}")
        if node_id in self.processes and self.processes[node_id].poll() is None:
            raise RuntimeError(f"Node already running: {node_id}")
        log = self.directory / f"{node_id}-{len(self.history)}.jsonl"
        handle = log.open("w", encoding="utf-8")
        self.handles.append(handle)
        env = dict(os.environ, PYTHONUTF8="1")
        executable = sys.executable
        if sys.platform == "win32" and sys.prefix != sys.base_prefix:
            executable = sys._base_executable
            env["__PYVENV_LAUNCHER__"] = sys.executable
        command = [executable, "-m", self.node_module, "node", "--id", node_id,
                   "--topology", str(self.path), "--timeout", "1.5", "--resilient",
                   "--heartbeat-interval", "0.1", "--heartbeat-timeout", "0.15",
                   "--failure-threshold", "2", "--recovery-threshold", "2", "--state-ttl", "3",
                   "--relay-delay", str(self.relay_delay),
                   "--guidance-state", str(self.directory / f"guidance-{node_id}.json")]
        process = subprocess.Popen(command, env=env, stdout=handle, stderr=subprocess.STDOUT,
                                   creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        record = {"node": node_id, "pid": process.pid, "log": log.name, "command": command}
        self.history.append(record)
        deadline = time.monotonic() + 15
        try:
            while time.monotonic() < deadline:
                start = next((item for item in read_events(log) if item.get("event") == "node_started"), None)
                if start is not None:
                    record.update(runtime_pid=start["pid"], parent_pid=start["parent_pid"])
                    if start["pid"] != process.pid or process.poll() is not None:
                        raise RuntimeError("Owned runtime PID or process readiness check failed")
                    # Commit ownership only after successful startup. A failed child must
                    # not replace the last owned process/log or leak on timeout.
                    self.processes[node_id], self.logs[node_id] = process, log
                    record["startup_status"] = "started"
                    return
                if process.poll() is not None:
                    raise RuntimeError(log.read_text(encoding="utf-8"))
                time.sleep(0.02)
            raise TimeoutError(f"Startup timeout: {node_id}")
        except Exception as exc:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            failed = next((item for item in reversed(read_events(log)) if item.get("event") == "command_failed"), {})
            record["startup_status"] = "failed"
            record["failure"] = {"node": node_id, "host": config.host, "port": config.port,
                "pid": process.pid, "exit_code": process.returncode, "reason": failed.get("reason", type(exc).__name__),
                "errno": failed.get("errno"), "winerror": failed.get("winerror"),
                "detail": failed.get("detail", str(exc)), "port_evidence": port_evidence(config.host, config.port)}
            (self.directory / f"startup-failure-{process.pid}.json").write_text(
                json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
            raise NodeStartError(node_id, record) from exc

    def start_all(self):
        for node in self.topology.nodes:
            self.start(node.id)

    def kill(self, node_id):
        process = self.processes[node_id]
        if process.poll() is not None:
            raise RuntimeError(f"Node is already stopped: {node_id}")
        record = {"node": node_id, "pid": process.pid, "fault": "owned_process_kill",
                  "issued_at": utc_now().isoformat(), "issued_monotonic_ns": time.monotonic_ns()}
        process.kill()
        process.wait(timeout=5)
        record["confirmed_monotonic_ns"] = time.monotonic_ns()
        self.faults.append(record)
        return record

    def records(self, node_id, event=None, message_id=None):
        return [item for item in read_events(self.logs[node_id])
                if (event is None or item.get("event") == event)
                and (message_id is None or item.get("message_id") == str(message_id))]

    async def wait_status(self, node_id, neighbor, state, timeout=12):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            status = await get_status(self.topology, node_id, timeout=1)
            if status.neighbors.get(neighbor, {}).get("status") == state:
                return {"observed_monotonic_ns": time.monotonic_ns(), "status": status.model_dump(mode="json")}
            await asyncio.sleep(0.02)
        raise TimeoutError(f"{node_id} did not observe {neighbor}={state}")

    async def wait_ready(self, timeout=15):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            complete = True
            for node in self.topology.nodes:
                if self.processes[node.id].poll() is not None:
                    raise RuntimeError(f"Node exited during readiness: {node.id}")
                status = await get_status(self.topology, node.id, timeout=1)
                if len(status.advertisements) != 6 or any(
                    state != "up" for advertisement in status.advertisements for state in advertisement.links.values()
                ):
                    complete = False
            if complete:
                return
            await asyncio.sleep(0.04)
        raise TimeoutError("Six-node link state did not converge")

    async def wait_event(self, node_id, event, message_id, timeout=10):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            records = self.records(node_id, event, message_id)
            if records:
                return records[-1]
            await asyncio.sleep(0.01)
        raise TimeoutError(f"Missing real event: {node_id} {event} {message_id}")

    async def close(self):
        failures = []
        try:
            for node_id, process in self.processes.items():
                if process.poll() is not None:
                    injected = any(fault["pid"] == process.pid for fault in self.faults)
                    normal = process.returncode == 0 and bool(self.records(node_id, "node_stopped"))
                    if not injected and not normal:
                        failures.append({"node": node_id, "error": "Unexpected process exit without injected fault or normal shutdown"})
                    continue
                if process.poll() is None:
                    try:
                        await stop_node(self.topology, node_id, timeout=3)
                        process.wait(timeout=5)
                        if process.returncode != 0 or not self.records(node_id, "node_stopped"):
                            raise RuntimeError("Normal node shutdown was not confirmed")
                    except Exception as exc:
                        failures.append({"node": node_id, "error": str(exc)})
                        if process.poll() is None:
                            process.kill()
                            process.wait(timeout=5)
        finally:
            for handle in self.handles:
                handle.close()
            evidence = {"transport": "real_tcp_loopback", "topology_origin": "simulation",
                        "observation_origin": "real_process", "processes": self.history, "faults": self.faults,
                        "cleanup_failures": failures,
                        "events": {entry["log"]: read_events(self.directory / entry["log"]) for entry in self.history}}
            (self.directory / "evidence.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
        if failures:
            raise RuntimeError(f"Cluster cleanup failed: {failures}")
