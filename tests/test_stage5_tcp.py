"""Actual HTTP, WebSocket and six independent TCP processes. No mock transport."""
import json
import os
import secrets
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx2
import pytest
from websockets.sync.client import connect


@pytest.fixture(scope="module")
def live_backend(tmp_path_factory):
    root = Path(__file__).resolve().parents[1]
    configured = os.environ.get("EXIT_LINK_STAGE5_ARTIFACT_DIR")
    output = Path(configured) if configured else tmp_path_factory.mktemp("stage5-live")
    output.mkdir(parents=True, exist_ok=True)
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    token = secrets.token_urlsafe(32)
    env = dict(os.environ, EXIT_LINK_CONTROL_TOKEN=token, EXIT_LINK_ENABLE_EXPERIMENTS="1",
               EXIT_LINK_STAGE5_ARTIFACT_DIR=str(output / "owned-clusters"), PYTHONUTF8="1")
    executable = sys.executable
    if sys.platform == "win32" and sys.prefix != sys.base_prefix:
        executable = sys._base_executable
        env["__PYVENV_LAUNCHER__"] = sys.executable
    log_path = output / "uvicorn.log"
    with log_path.open("w", encoding="utf-8") as log:
        process = subprocess.Popen([executable, "-m", "uvicorn", "exit_link.main:app", "--host", "127.0.0.1",
            "--port", str(port), "--workers", "1", "--no-proxy-headers", "--ws-max-size", "4096"],
            cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        base = f"http://127.0.0.1:{port}"
        with httpx2.Client(base_url=base, headers={"X-Exit-Link-Token": token}, trust_env=False, timeout=40) as client:
            try:
                deadline = time.monotonic() + 15
                while True:
                    assert process.poll() is None, log_path.read_text(encoding="utf-8")
                    try:
                        if client.get("/health").status_code == 200:
                            break
                    except httpx2.TransportError:
                        pass
                    if time.monotonic() > deadline:
                        pytest.fail("Uvicorn readiness timeout: " + log_path.read_text(encoding="utf-8"))
                    time.sleep(0.05)
                response = client.post("/api/v1/experiment")
                assert response.status_code == 200, response.text
                assert len(response.json()["nodes"]) == 6 and all(node["running"] for node in response.json()["nodes"])
                yield client, f"ws://127.0.0.1:{port}/ws/v1/events", output
            finally:
                try:
                    if process.poll() is None:
                        stopped = client.delete("/api/v1/experiment")
                        assert stopped.status_code == 200, stopped.text
                finally:
                    if process.poll() is None:
                        process.terminate()
                        process.wait(timeout=10)


def scenario(client):
    response = client.post("/api/v1/scenarios", json={"starts": ["F2_E"]})
    assert response.status_code == 201, response.text
    return response.json()["state"]["scenario_id"]


def send(client, sid, revision=1):
    response = client.post(f"/api/v1/scenarios/{sid}/guidance", json={"start_location": "F2_E",
        "source_node": "N1", "destination_node": "N4", "expected_revision": revision})
    assert response.status_code == 200, response.text
    return response.json()


def wait_neighbor(client, status):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        response = client.post("/api/v1/network/refresh")
        assert response.status_code == 200, response.text
        network = response.json()
        n1 = next(n for n in network["nodes"] if n["node_id"] == "N1")
        if any(n["node_id"] == "N2" and n["status"] == status for n in n1["neighbors"]):
            return network
        time.sleep(0.05)
    pytest.fail(f"Actual N1 heartbeat did not observe N2={status}")


def test_actual_http_guidance_tcp_ack_and_result_lookup(live_backend):
    client, _, output = live_backend
    sid = scenario(client)
    result = send(client, sid)
    assert result["ack_received"] and result["transport_result"]["success"]
    assert result["application_receipt"]["disposition"] == "applied"
    assert not result["human_evacuation_verified"]
    assert result["transport_result"]["ack"]["route"] == ["N1", "N2", "N4"]
    assert client.get(f"/api/v1/deliveries/{result['message_id']}").json() == result
    assert client.get("/api/v1/deliveries", params={"scenario_id": sid}).json() == [result]
    (output / "http-guidance.json").write_text(json.dumps(result, indent=2), encoding="utf-8")


def test_actual_ws_route_changes_and_delivery_events(live_backend):
    client, url, output = live_backend
    sid = scenario(client)
    received = []
    with connect(url, origin="http://localhost:5173", proxy=None) as ws:
        baseline = json.loads(ws.recv(timeout=5))
        assert baseline["type"] == "snapshot"
        network = baseline["payload"]["network"]
        assert network["observation_status"] == "observed" and all(n["reachable"] for n in network["nodes"])
        response = client.put(f"/api/v1/scenarios/{sid}/hazards", json={"expected_revision": 1,
            "hazards": {"blocked_nodes": ["EXIT_W", "EXIT_E"]}})
        assert response.status_code == 200
        result = send(client, sid, 2)
        assert result["ack_received"]
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            event = json.loads(ws.recv(timeout=5))
            received.append(event)
            if event["type"] == "guidance.result" and event["payload"]["message_id"] == result["message_id"]:
                break
        assert any(e["type"] == "route.changed" and e["payload"]["scenario_id"] == sid
                   and e["payload"]["status"] == "no_route" for e in received)
        assert received[-1]["type"] == "guidance.result" and received[-1]["payload"] == result
        assert [e["sequence"] for e in received] == list(range(baseline["payload"]["sequence"] + 1, received[-1]["sequence"] + 1))
    (output / "websocket-events.json").write_text(json.dumps(received, indent=2), encoding="utf-8")


def test_owned_fault_rerouting_recovery_and_ws_fault_evidence(live_backend):
    client, url, output = live_backend
    sid = scenario(client)
    received = []
    with connect(url, origin="http://localhost:5173", proxy=None) as ws:
        ws.recv(timeout=5)
        failed = client.post("/api/v1/experiment/nodes/N2/fail")
        assert failed.status_code == 200, failed.text
        assert not next(n for n in failed.json()["nodes"] if n["node_id"] == "N2")["running"]
        network = wait_neighbor(client, "down")
        assert not next(n for n in network["nodes"] if n["node_id"] == "N2")["reachable"]
        result = send(client, sid)
        assert result["ack_received"] and result["application_receipt"]["disposition"] == "applied"
        assert result["transport_result"]["ack"]["route"] == ["N1", "N3", "N4"]
        recovered = client.post("/api/v1/experiment/nodes/N2/recover")
        assert recovered.status_code == 200, recovered.text
        wait_neighbor(client, "up")
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            event = json.loads(ws.recv(timeout=5))
            received.append(event)
            raw = event["payload"]
            if event["type"] == "network.event" and raw["event"] == "neighbor_recovered" and raw["node_id"] == "N1":
                break
        assert any(e["type"] == "network.event" and e["payload"]["event"] == "neighbor_down"
                   and e["payload"]["node_id"] == "N1" for e in received)
        assert any(e["type"] == "network.event" and e["payload"]["event"] == "neighbor_recovered"
                   and e["payload"]["node_id"] == "N1" for e in received)
        assert all(e["payload"]["observation_origin"] == "real_process" for e in received if e["type"] == "network.event")
    (output / "fault-recovery.json").write_text(json.dumps({"delivery": result, "events": received}, indent=2), encoding="utf-8")


def test_actual_invalid_control_cannot_target_arbitrary_process(live_backend):
    client, _, _ = live_backend
    before = client.get("/api/v1/experiment").json()
    assert client.post("/api/v1/experiment/nodes/12345/fail").status_code == 404
    assert client.post("/api/v1/experiment/nodes/N2/recover").status_code == 409
    assert client.post("/api/v1/experiment").status_code == 409
    assert client.post("/api/v1/experiment/nodes/N2/fail", headers={"Origin": "https://evil.example"}).status_code == 403
    after = client.get("/api/v1/experiment").json()
    assert [(n["node_id"], n["pid"], n["running"]) for n in before["nodes"]] == [(n["node_id"], n["pid"], n["running"]) for n in after["nodes"]]


def test_actual_no_route_is_delivery_failure(live_backend):
    client, _, output = live_backend
    sid = scenario(client)
    try:
        assert client.post("/api/v1/experiment/nodes/N2/fail").status_code == 200
        assert client.post("/api/v1/experiment/nodes/N3/fail").status_code == 200
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            network = client.post("/api/v1/network/refresh").json()
            n1 = next(n for n in network["nodes"] if n["node_id"] == "N1")
            if all(n["status"] == "down" for n in n1["neighbors"]):
                break
            time.sleep(0.05)
        assert len(n1["neighbors"]) == 2 and all(n["status"] == "down" for n in n1["neighbors"])
        result = send(client, sid)
        assert not result["ack_received"] and not result["transport_result"]["success"]
        assert result["transport_result"]["error"]["code"] == "no_route"
        assert result["application_receipt"] is None
        (output / "no-route.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    finally:
        assert client.post("/api/v1/experiment/nodes/N2/recover").status_code == 200
        assert client.post("/api/v1/experiment/nodes/N3/recover").status_code == 200
        wait_neighbor(client, "up")
