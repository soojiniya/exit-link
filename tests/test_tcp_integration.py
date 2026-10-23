"""Real IPv4 TCP + six independent Python subprocesses. No transport mocks."""
import asyncio
import json
import os
import socket
import struct
import subprocess
import sys
import time
from pathlib import Path

import pytest

from exit_link.communication.client import send_message, stop_node
from exit_link.communication.protocol import (
    MAX_FRAME_BYTES, Ack, ErrorResponse, Message, close_writer, encode_frame, read_frame,
)
from exit_link.topology.loader import load_communication
from exit_link.topology.models import CommunicationTopology


def events(path):
    records = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            pass  # A subprocess may still be writing the last line.
    return records


class Cluster:
    def __init__(self, directory):
        self.directory = directory
        self.processes, self.logs, self.handles = {}, {}, []
        self.history = []
        config = load_communication().model_dump()
        reservations = []
        try:
            for node in config["nodes"]:
                sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                sock.bind(("127.0.0.1", 0))
                reservations.append(sock)
                node["port"] = sock.getsockname()[1]
            self.topology = CommunicationTopology.model_validate(config)
            self.path = directory / "communication-test.json"
            self.path.write_text(self.topology.model_dump_json(indent=2), encoding="utf-8")
        finally:
            for sock in reservations:
                sock.close()

    def start(self, node_id):
        log = self.directory / f"{node_id}-{len(self.history)}.jsonl"
        handle = log.open("w", encoding="utf-8")
        self.handles.append(handle)
        env = dict(os.environ, PYTHONUTF8="1")
        executable = sys.executable
        if sys.platform == "win32" and sys.prefix != sys.base_prefix:
            # CPython 3.12 venv python.exe is a redirector process. Launch its
            # real interpreter with the same venv handshake so Popen owns the
            # node itself (PID, exit status and kill), not a launcher parent.
            executable = sys._base_executable
            env["__PYVENV_LAUNCHER__"] = sys.executable
        process = subprocess.Popen(
            [executable, "-m", "exit_link.communication", "node", "--id", node_id,
             "--topology", str(self.path), "--timeout", "1.5"],
            stdout=handle, stderr=subprocess.STDOUT, env=env,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
        self.processes[node_id] = process
        self.logs[node_id] = log
        self.history.append({"node": node_id, "pid": process.pid, "log": log.name})
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            started = next((record for record in events(log) if record.get("event") == "node_started"), None)
            if started:
                self.history[-1].update(runtime_pid=started["pid"], parent_pid=started["parent_pid"],
                                        python_prefix=started["python_prefix"])
                return
            if process.poll() is not None:
                pytest.fail(f"Node startup failed: {log.read_text(encoding='utf-8')}")
            time.sleep(0.03)
        pytest.fail(f"Node startup timeout: {node_id}")

    def stop(self, node_id):
        process = self.processes[node_id]
        if process.poll() is None:
            response = asyncio.run(stop_node(self.topology, node_id))
            assert response.node == node_id
            assert process.wait(timeout=8) == 0
        assert any(record.get("event") == "node_stopped" for record in events(self.logs[node_id]))

    def records(self, node_id, event, message):
        return [record for record in events(self.logs[node_id])
                if record.get("event") == event and record.get("message_id") == str(message.message_id)]

    def send(self, message):
        return asyncio.run(send_message(self.topology, message))

    def endpoint(self, node_id):
        node = next(node for node in self.topology.nodes if node.id == node_id)
        return node.host, node.port


@pytest.fixture(scope="module")
def cluster(tmp_path_factory):
    configured = os.environ.get("EXIT_LINK_TEST_ARTIFACT_DIR")
    directory = Path(configured) if configured else tmp_path_factory.mktemp("tcp-processes")
    directory.mkdir(parents=True, exist_ok=True)
    instance = Cluster(directory)
    try:
        for node in instance.topology.nodes:
            instance.start(node.id)
        yield instance
    finally:
        failures = []
        for node_id, process in instance.processes.items():
            if process.poll() is None:
                try:
                    instance.stop(node_id)
                except Exception as exc:
                    failures.append(f"{node_id}: {exc}")
                    process.kill()
                    process.wait(timeout=5)
        for handle in instance.handles:
            handle.close()
        evidence = {"transport": "real_tcp_loopback", "topology_origin": "simulation",
                    "processes": instance.history, "cleanup_failures": failures,
                    "events": {entry["log"]: events(directory / entry["log"]) for entry in instance.history}}
        (directory / "evidence.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
        assert not failures, failures


def message(route, **changes):
    fields = dict(source=route[0], destination=route[-1], route=route, payload="긴급 대피 안내: 서쪽 출구")
    fields.update(changes)
    return Message(**fields)


def test_six_independent_nodes_listen_on_loopback(cluster):
    assert len({process.pid for process in cluster.processes.values()}) == 6
    assert all(process.poll() is None for process in cluster.processes.values())
    for node_id in cluster.processes:
        started = next(record for record in events(cluster.logs[node_id]) if record.get("event") == "node_started")
        assert started["host"] == "127.0.0.1"
        assert started["pid"] == cluster.processes[node_id].pid
        assert started["parent_pid"] == os.getpid()
        assert Path(started["python_prefix"]) == Path(sys.prefix)


def test_one_hop_and_ack(cluster):
    request = message(["N1", "N2"], ttl=1)
    ack = cluster.send(request)
    assert isinstance(ack, Ack)
    assert ack.message_id == request.message_id
    assert (ack.source, ack.destination, ack.route) == ("N2", "N1", request.route)
    assert not ack.duplicate
    assert cluster.records("N2", "received", request)[0]["payload"] == request.payload
    assert cluster.records("N1", "ack_received", request)


def test_multiple_hops_and_ack_chain(cluster):
    request = message(["N1", "N2", "N4"], ttl=2)
    assert isinstance(cluster.send(request), Ack)
    assert cluster.records("N1", "sent", request)[0]["next_node"] == "N2"
    assert cluster.records("N2", "relayed", request)[0]["next_node"] == "N4"
    assert len(cluster.records("N4", "received", request)) == 1
    assert cluster.records("N4", "received", request)[0]["ttl"] == 0
    for node in ("N1", "N2"):
        assert cluster.records(node, "ack_received", request)
    for node in request.route:
        assert cluster.records(node, "ack_sent", request)


def test_all_six_nodes_in_one_delivery(cluster):
    request = message(["N1", "N2", "N4", "N6", "N5", "N3"], ttl=5)
    assert isinstance(cluster.send(request), Ack)
    assert cluster.records("N3", "received", request)
    for node in request.route[1:-1]:
        assert cluster.records(node, "relayed", request)


def test_sequential_duplicate_delivers_once(cluster):
    request = message(["N1", "N2", "N4"])
    assert not cluster.send(request).duplicate
    assert cluster.send(request).duplicate
    assert len(cluster.records("N4", "received", request)) == 1


def test_concurrent_duplicate_delivers_once(cluster):
    request = message(["N1", "N2", "N4", "N6"])
    async def check():
        results = await asyncio.gather(*(send_message(cluster.topology, request) for _ in range(12)))
        assert all(isinstance(result, Ack) for result in results)
        assert sum(not result.duplicate for result in results) == 1
    asyncio.run(check())
    assert len(cluster.records("N6", "received", request)) == 1


def test_message_id_conflict_rejected(cluster):
    request = message(["N1", "N2"])
    assert isinstance(cluster.send(request), Ack)
    result = cluster.send(request.model_copy(update={"payload": "different"}))
    assert result.code == "message_id_conflict"
    assert len(cluster.records("N2", "received", request)) == 1


def test_ttl_expires_without_destination_delivery(cluster):
    request = message(["N1", "N2", "N4"], ttl=1)
    response = cluster.send(request)
    assert isinstance(response, ErrorResponse)
    assert response.code == "ttl_expired"
    assert response.node == "N2"
    assert not cluster.records("N4", "received", request)


@pytest.mark.parametrize("route", [["N1", "N4"], ["N1", "N9"]])
def test_links_and_unknown_nodes_are_rejected(cluster, route):
    response = cluster.send(message(route))
    assert response.code == "invalid_route"


def test_many_distinct_connections(cluster):
    requests = [message(["N1", "N2", "N4", "N6"], payload=f"concurrent-{i}") for i in range(20)]
    async def check():
        return await asyncio.gather(*(send_message(cluster.topology, request) for request in requests))
    results = asyncio.run(check())
    assert all(isinstance(result, Ack) for result in results)
    assert len({result.message_id for result in results}) == 20
    assert all(len(cluster.records("N6", "received", request)) == 1 for request in requests)


async def raw_exchange(cluster, data, node_id="N1", split=False, eof=False):
    reader, writer = await asyncio.open_connection(*cluster.endpoint(node_id))
    try:
        if split:
            for chunk in (data[:2], data[2:5], data[5:11], data[11:]):
                writer.write(chunk)
                await writer.drain()
                await asyncio.sleep(0.01)
        else:
            writer.write(data)
            await writer.drain()
        if eof:
            writer.write_eof()
        return await read_frame(reader, 5)
    finally:
        await close_writer(writer)


def test_fragmented_real_tcp_frame(cluster):
    request = message(["N1", "N2"])
    result = asyncio.run(raw_exchange(cluster, encode_frame(request), split=True))
    assert result["type"] == "ack"
    assert result["message_id"] == str(request.message_id)


@pytest.mark.parametrize("body", [b"not-json", b"\xff", b"[]", b'{"type":"data"}', b'{"type":"unknown"}'])
def test_malformed_frames_do_not_crash_node(cluster, body):
    response = asyncio.run(raw_exchange(cluster, struct.pack("!I", len(body)) + body))
    assert response["code"] == "invalid_message"
    assert isinstance(cluster.send(message(["N1", "N2"])), Ack)


@pytest.mark.parametrize("length", [0, MAX_FRAME_BYTES + 1])
def test_invalid_size_real_tcp(cluster, length):
    assert asyncio.run(raw_exchange(cluster, struct.pack("!I", length)))["code"] == "invalid_message"


def test_truncated_real_tcp_frame(cluster):
    assert asyncio.run(raw_exchange(cluster, struct.pack("!I", 100) + b"{", eof=True))["code"] == "invalid_message"


def test_slow_incomplete_connection_times_out(cluster):
    assert asyncio.run(raw_exchange(cluster, b"\x00"))["code"] == "timeout"
    assert isinstance(cluster.send(message(["N1", "N2"])), Ack)


def test_wrong_current_hop(cluster):
    response = asyncio.run(raw_exchange(cluster, encode_frame(message(["N1", "N2"])), node_id="N2"))
    assert response["code"] == "wrong_hop"


def test_port_conflict_and_unknown_node_fail_cleanly(cluster):
    for node_id in ("N1", "UNKNOWN"):
        result = subprocess.run(
            [sys.executable, "-m", "exit_link.communication", "node", "--id", node_id,
             "--topology", str(cluster.path)], capture_output=True, text=True, timeout=15,
        )
        assert result.returncode == 1
        assert json.loads(result.stdout)["event"] == "command_failed"
        assert "Traceback" not in result.stderr


def test_connection_failure_does_not_automatically_reroute(cluster):
    cluster.stop("N2")
    try:
        request = message(["N1", "N2", "N4"])
        result = cluster.send(request)
        assert result.code == "connection_failed"
        failures = cluster.records("N1", "error", request)
        assert failures[-1]["phase"] == "connect"
        assert not cluster.records("N1", "sent", request)
        assert not cluster.records("N4", "received", request)
        assert not cluster.records("N3", "relayed", request)

        # A real TCP listener that accepts the request but withholds the ACK
        # must still produce timeout. Do not reclassify every timeout as a
        # failed connection to make the stopped-node assertion pass.
        async def check_established_timeout():
            release = asyncio.Event()
            accepted = asyncio.Event()
            tasks = set()

            async def no_ack(reader, writer):
                task = asyncio.current_task()
                tasks.add(task)
                try:
                    await read_frame(reader, 5)
                    accepted.set()
                    await release.wait()
                finally:
                    await close_writer(writer)
                    tasks.discard(task)

            server = await asyncio.start_server(no_ack, *cluster.endpoint("N2"), reuse_address=False)
            delayed = message(["N1", "N2", "N4"])
            try:
                response = await send_message(cluster.topology, delayed)
                assert accepted.is_set()
                assert response.code == "timeout"
                assert cluster.records("N1", "sent", delayed)
                assert cluster.records("N1", "error", delayed)[-1]["phase"] == "io"
                assert not cluster.records("N4", "received", delayed)
                assert not cluster.records("N3", "relayed", delayed)
            finally:
                server.close()
                release.set()
                if tasks:
                    await asyncio.gather(*list(tasks))
                await server.wait_closed()

        asyncio.run(check_established_timeout())
    finally:
        cluster.start("N2")


def test_shutdown_with_incomplete_connection_and_port_release(cluster):
    async def open_and_stop():
        reader, writer = await asyncio.open_connection(*cluster.endpoint("N5"))
        writer.write(b"\x00")
        await writer.drain()
        await stop_node(cluster.topology, "N5")
        assert await asyncio.wait_for(reader.read(), 5) == b""
        await close_writer(writer)
    asyncio.run(open_and_stop())
    assert cluster.processes["N5"].wait(timeout=8) == 0
    assert any(record.get("event") == "node_stopped" for record in events(cluster.logs["N5"]))
    try:
        with pytest.raises(OSError):
            with socket.create_connection(cluster.endpoint("N5"), timeout=1):
                pass
    finally:
        cluster.start("N5")


def test_send_cli_uses_real_source_node(cluster):
    result = subprocess.run(
        [sys.executable, "-m", "exit_link.communication", "send", "--source", "N1",
         "--destination", "N4", "--route", "N1,N2,N4", "--payload", "cli-real-tcp",
         "--topology", str(cluster.path)], capture_output=True, text=True, timeout=15,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    ack = json.loads(result.stdout)
    assert ack["type"] == "ack"
    assert any(record.get("message_id") == ack["message_id"] and record.get("event") == "received"
               for record in events(cluster.logs["N4"]))
