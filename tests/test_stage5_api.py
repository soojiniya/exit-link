"""ASGI contract/security tests; no substituted successful TCP observations."""
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from exit_link.api.contracts import RouteChanged
from exit_link.api.events import EventBus
from exit_link.api.security import ApiSettings
from exit_link.main import create_app

TOKEN = "stage5-test-token-" + "x" * 32
HEADERS = {"X-Exit-Link-Token": TOKEN}


@pytest.fixture
def client(tmp_path):
    app = create_app(ApiSettings(control_token=TOKEN, monitor_enabled=False, artifact_directory=tmp_path))
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as session:
        yield session


def create(client):
    response = client.post("/api/v1/scenarios", json={"starts": ["F2_E"]}, headers=HEADERS)
    assert response.status_code == 201, response.text
    return response.json()


def test_building_floor_and_unobserved_network(client):
    building = client.get("/api/v1/building").json()
    assert len(building["floors"]) == 3 and len(building["building"]["nodes"]) == 14
    assert client.get("/api/v1/building/floors/2").json()["floor"] == 2
    assert client.get("/api/v1/building/floors/4").status_code == 404
    network = client.get("/api/v1/network").json()
    assert len(network["topology"]["nodes"]) == 6
    assert network["nodes"] == [] and network["observation_status"] == "not_observed"
    assert network["observed_at"] is None


def test_create_change_hazards_recalculates_and_no_route(client):
    snapshot = create(client)
    sid = snapshot["state"]["scenario_id"]
    plan = snapshot["plans"][0]
    assert plan["status"] == "route_found"
    assert client.get(f"/api/v1/scenarios/{sid}/hazards").json()["data_origin"] == "simulation"
    blocked = client.put(f"/api/v1/scenarios/{sid}/hazards", headers=HEADERS, json={
        "expected_revision": 1, "hazards": {"blocked_nodes": ["EXIT_W", "EXIT_E"]}})
    assert blocked.status_code == 200
    result = blocked.json()
    assert result["state"]["revision"] == 2
    assert result["plans"][0]["route_version"] == plan["route_version"] + 1
    assert result["plans"][0]["status"] == "no_route" and result["plans"][0]["path"] == []
    assert client.get(f"/api/v1/scenarios/{sid}/plans").json() == result["plans"]
    assert client.get(f"/api/v1/scenarios/{sid}").json() == result


def test_revision_conflict_and_invalid_update_leave_state_unchanged(client):
    original = create(client)
    path = f"/api/v1/scenarios/{original['state']['scenario_id']}"
    assert client.put(path + "/hazards", headers=HEADERS, json={"expected_revision": 9, "hazards": {}}).status_code == 409
    assert client.put(path + "/hazards", headers=HEADERS, json={
        "expected_revision": 1, "hazards": {"fire_locations": ["unknown"]}}).status_code == 422
    assert client.get(path).json() == original


def test_plan_registration_and_noop_do_not_increment_version(client):
    original = create(client)
    path = f"/api/v1/scenarios/{original['state']['scenario_id']}"
    response = client.post(path + "/plans", json={"start_location": "F3_W"}, headers=HEADERS)
    assert response.status_code == 200 and response.json()["route_version"] == 1
    sequence = client.get("/api/v1/snapshot").json()["sequence"]
    assert client.post(path + "/plans", json={"start_location": "F3_W"}, headers=HEADERS).json() == response.json()
    assert client.put(path + "/hazards", json={"expected_revision": 1, "hazards": {}}, headers=HEADERS).status_code == 200
    assert client.get("/api/v1/snapshot").json()["sequence"] == sequence


@pytest.mark.parametrize("body", [{"starts": []}, {"starts": ["unknown"]},
    {"starts": ["F2_E"], "unexpected": True}, {"starts": ["F2_E"], "hazards": {"data_origin": "sensor"}}])
def test_invalid_creation_does_not_commit_partial_scenario(client, body):
    assert client.post("/api/v1/scenarios", json=body, headers=HEADERS).status_code == 422
    assert client.get("/api/v1/scenarios").json() == []


def test_missing_records_and_invalid_uuid(client):
    assert client.get(f"/api/v1/scenarios/{uuid4()}").status_code == 404
    assert client.get("/api/v1/scenarios/invalid").status_code == 422
    assert client.get(f"/api/v1/deliveries/{uuid4()}").status_code == 404
    assert client.get("/api/v1/deliveries").json() == []


def test_guidance_validates_nodes_revision_and_retry_bounds_before_io(client):
    scenario = create(client)
    path = f"/api/v1/scenarios/{scenario['state']['scenario_id']}/guidance"
    body = {"start_location": "F2_E", "source_node": "N1", "destination_node": "N4", "expected_revision": 1}
    for changes, code in [({"source_node": "external"}, 422), ({"destination_node": "N1"}, 422),
                          ({"expected_revision": 2}, 409), ({"max_retries": 7}, 422), ({"ttl": 65}, 422)]:
        assert client.post(path, json=body | changes, headers=HEADERS).status_code == code
    assert client.get("/api/v1/deliveries").json() == []


@pytest.mark.parametrize("headers", [{}, {"X-Exit-Link-Token": "incorrect"}])
def test_write_token_required(client, headers):
    assert client.post("/api/v1/scenarios", json={"starts": ["F2_E"]}, headers=headers).status_code == 403
    assert client.post("/api/v1/experiment", headers=headers).status_code == 403


@pytest.mark.parametrize("host", ["attacker.example", "127.0.0.1.attacker.example", "evil@localhost", "localhost:notaport"])
def test_host_rebinding_is_rejected(client, host):
    assert client.get("/api/v1/snapshot", headers={"Host": host}).status_code == 403


@pytest.mark.parametrize("origin", ["https://evil.example", "null", "http://localhost:9999"])
def test_disallowed_origin_is_rejected_even_with_token(client, origin):
    response = client.post("/api/v1/scenarios", json={"starts": ["F2_E"]}, headers=HEADERS | {"Origin": origin})
    assert response.status_code == 403


def test_remote_peer_cannot_spoof_forwarded_loopback(tmp_path):
    app = create_app(ApiSettings(control_token=TOKEN, experiments_enabled=True, monitor_enabled=False, artifact_directory=tmp_path))
    with TestClient(app, base_url="http://127.0.0.1", client=("203.0.113.2", 50000)) as remote:
        response = remote.post("/api/v1/experiment", headers=HEADERS | {"X-Forwarded-For": "127.0.0.1"})
        assert response.status_code == 403 and app.state.backend.cluster is None


def test_allowed_origin_cors_and_preflight(client):
    origin = "http://localhost:5173"
    response = client.options("/api/v1/scenarios", headers={"Origin": origin,
        "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,x-exit-link-token"})
    assert response.status_code == 200 and response.headers["access-control-allow-origin"] == origin
    assert "access-control-allow-credentials" not in response.headers
    assert client.get("/api/v1/building", headers={"Origin": origin}).status_code == 200


def test_experiment_requires_explicit_enable_and_has_no_pid_target(client):
    assert client.get("/api/v1/experiment").json()["enabled"] is False
    assert client.post("/api/v1/experiment", headers=HEADERS).status_code == 403
    assert client.post("/api/v1/experiment/nodes/N2/fail", headers=HEADERS).status_code == 403
    assert client.post("/api/v1/experiment/processes/123/fail", headers=HEADERS).status_code == 404


def test_no_owned_experiment_cannot_control_existing_external_node(tmp_path):
    app = create_app(ApiSettings(control_token=TOKEN, experiments_enabled=True, monitor_enabled=False, artifact_directory=tmp_path))
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as local:
        assert local.post("/api/v1/experiment/nodes/N2/fail", headers=HEADERS).status_code == 409
        assert local.delete("/api/v1/experiment", headers=HEADERS).json()["status"] == "stopped"


def test_no_token_default_is_read_only():
    with TestClient(create_app(ApiSettings(monitor_enabled=False)), base_url="http://127.0.0.1", client=("127.0.0.1", 1)) as local:
        assert local.get("/api/v1/scenarios").status_code == 200
        assert local.post("/api/v1/scenarios", json={"starts": ["F2_E"]}, headers=HEADERS).status_code == 403


@pytest.mark.parametrize("settings", [{"control_token": "short"}, {"experiments_enabled": True},
    {"origins": ("https://evil.example",)}, {"poll_seconds": 0}, {"origins": ("*",)}])
def test_unsafe_settings_are_rejected(settings):
    with pytest.raises(ValueError):
        ApiSettings(**settings)


def test_ws_snapshot_change_order_replay_and_cleanup(client):
    with client.websocket_connect("ws://127.0.0.1/ws/v1/events", headers={"Origin": "http://localhost:5173"}) as socket:
        frame = socket.receive_json()
        assert frame["type"] == "snapshot" and frame["payload"]["sequence"] == 0
        scenario = create(client)
        changed, route = socket.receive_json(), socket.receive_json()
        assert changed["type"] == "scenario.changed" and route["type"] == "route.changed"
        assert [changed["sequence"], route["sequence"]] == [1, 2]
        assert route["payload"]["scenario_id"] == scenario["state"]["scenario_id"]
        replay = client.get("/api/v1/events", params={"stream_id": frame["payload"]["stream_id"], "after": 0}).json()
        assert replay["reset_required"] is False and replay["events"] == [changed, route]
    # Handler completion is synchronized by the TestClient WebSocket context manager.
    assert not client.app.state.backend.bus.clients


@pytest.mark.parametrize("headers", [{"Origin": "https://evil.example"}, {"Host": "evil.example"}])
def test_ws_rejects_untrusted_origin_or_host(client, headers):
    with pytest.raises(WebSocketDisconnect) as error:
        with client.websocket_connect("ws://127.0.0.1/ws/v1/events", headers=headers):
            pass
    assert error.value.code == 1008


def test_ws_is_read_only_and_reconnects_with_current_state(client):
    with client.websocket_connect("ws://127.0.0.1/ws/v1/events") as socket:
        socket.receive_json()
        socket.send_json({"command": "kill", "node": "N1"})
        with pytest.raises(WebSocketDisconnect) as error:
            socket.receive_json()
        assert error.value.code == 1008
    create(client)
    with client.websocket_connect("ws://127.0.0.1/ws/v1/events") as socket:
        state = socket.receive_json()["payload"]
        assert len(state["scenarios"]) == 1 and state["sequence"] == 2


def test_event_gap_and_server_restart_require_reset(client):
    bus = client.app.state.backend.bus
    bus.history = __import__("collections").deque(maxlen=1)
    create(client)
    result = client.get("/api/v1/events", params={"stream_id": str(bus.stream_id), "after": 0}).json()
    assert result["reset_required"] and result["events"] == []
    assert client.get("/api/v1/events", params={"stream_id": str(uuid4()), "after": 2}).json()["reset_required"]
    assert client.get("/api/v1/events", params={"stream_id": str(bus.stream_id), "after": 999}).json()["reset_required"]


def test_slow_subscriber_is_removed_and_signaled_for_resync(client):
    scenario = create(client)
    bus = EventBus(queue_size=1)
    queue = bus.subscribe()
    plan = client.app.state.backend.session(__import__("uuid").UUID(scenario["state"]["scenario_id"])).plan("F2_E")
    bus.publish(RouteChanged, plan)
    bus.publish(RouteChanged, plan)
    assert queue.get_nowait() is None and queue not in bus.clients


def test_ws_client_limit_is_bounded():
    bus = EventBus(max_clients=1)
    bus.subscribe()
    with pytest.raises(RuntimeError):
        bus.subscribe()
