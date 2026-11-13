"""P1-4 guard: the public Render API (exit_link.public_app:app) stays read-only.

No TCP node is started; the app is exercised in-process only.
"""
import importlib

import pytest
from fastapi.routing import APIRoute, APIWebSocketRoute
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

ORIGIN = "https://exit-link-unit.example"
PREVIEW_ORIGIN = "https://exit-link-preview-unit.example"


def load(monkeypatch, origin=ORIGIN):
    # The module builds its ASGI app at import time from the environment, as Render does.
    monkeypatch.setenv("EXIT_LINK_PUBLIC_ORIGIN", origin)
    return importlib.import_module("exit_link.public_app")


@pytest.fixture
def app(monkeypatch):
    monkeypatch.delenv("EXIT_LINK_PUBLIC_PREVIEW_ORIGIN", raising=False)
    return load(monkeypatch).create_public_app()


def test_public_api_has_no_write_or_control_routes(app):
    methods = set()
    for route in app.routes:
        if isinstance(route, APIRoute):
            methods |= route.methods
    assert methods <= {"GET", "HEAD"}
    websockets = [route.path for route in app.routes if isinstance(route, APIWebSocketRoute)]
    assert websockets == ["/ws/v1/events"]
    paths = {getattr(route, "path", "") for route in app.routes}
    assert not any("experiment/nodes" in path or path.endswith("/guidance") or path.endswith("/hazards") for path in paths)


@pytest.mark.parametrize("method,path", [
    ("post", "/api/v1/experiment"), ("delete", "/api/v1/experiment"),
    ("post", "/api/v1/experiment/nodes/N2/fail"), ("post", "/api/v1/scenarios"),
    ("post", "/api/v1/network/refresh"),
])
def test_public_api_rejects_control_requests(app, method, path):
    with TestClient(app) as client:
        response = getattr(client, method)(path, headers={"Origin": ORIGIN, "X-Exit-Link-Token": "x" * 40})
    assert response.status_code in (404, 405)


def test_public_api_requires_exact_https_origin(monkeypatch):
    module = load(monkeypatch)
    monkeypatch.setenv("EXIT_LINK_PUBLIC_ORIGIN", "http://exit-link-unit.example")
    with pytest.raises(ValueError):
        module.create_public_app()


@pytest.fixture
def preview_app(monkeypatch):
    module = load(monkeypatch)
    monkeypatch.setenv("EXIT_LINK_PUBLIC_PREVIEW_ORIGIN", PREVIEW_ORIGIN)
    return module.create_public_app()


@pytest.mark.parametrize("origin", [ORIGIN, PREVIEW_ORIGIN])
def test_public_cors_allows_exact_origins_for_get_and_get_preflight(preview_app, origin):
    with TestClient(preview_app) as client:
        response = client.get("/api/v1/building", headers={"Origin": origin})
        preflight = client.options("/api/v1/building", headers={
            "Origin": origin, "Access-Control-Request-Method": "GET",
        })
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == origin
    assert preflight.status_code == 200
    assert preflight.headers["access-control-allow-origin"] == origin
    assert preflight.headers["access-control-allow-methods"] == "GET"


def test_public_cors_rejects_unregistered_origin_and_post_preflight(preview_app):
    unknown = "https://unregistered.example"
    with TestClient(preview_app) as client:
        get_response = client.get("/api/v1/building", headers={"Origin": unknown})
        unknown_preflight = client.options("/api/v1/building", headers={
            "Origin": unknown, "Access-Control-Request-Method": "GET",
        })
        post_preflight = client.options("/api/v1/experiment", headers={
            "Origin": PREVIEW_ORIGIN, "Access-Control-Request-Method": "POST",
        })
    assert get_response.status_code == 200
    assert "access-control-allow-origin" not in get_response.headers
    assert unknown_preflight.status_code == 400
    assert "access-control-allow-origin" not in unknown_preflight.headers
    assert post_preflight.status_code == 400
    assert post_preflight.headers["access-control-allow-methods"] == "GET"


@pytest.mark.parametrize("origin", [ORIGIN, PREVIEW_ORIGIN])
def test_public_websocket_allows_exact_origins(preview_app, origin):
    with TestClient(preview_app) as client:
        with client.websocket_connect("/ws/v1/events", headers={"Origin": origin}) as socket:
            frame = socket.receive_json()
    assert frame["type"] == "snapshot"


def test_public_websocket_rejects_unregistered_origin(preview_app):
    with TestClient(preview_app) as client:
        with pytest.raises(WebSocketDisconnect) as exc:
            with client.websocket_connect("/ws/v1/events", headers={
                "Origin": "https://unregistered.example",
            }):
                pass
    assert exc.value.code == 1008


@pytest.mark.parametrize("preview", ["http://exit-link-preview-unit.example",
                                      "https://exit-link-preview-unit.example/path",
                                      "https://*.vercel.app"])
def test_public_preview_origin_requires_exact_https(monkeypatch, preview):
    module = load(monkeypatch)
    monkeypatch.setenv("EXIT_LINK_PUBLIC_PREVIEW_ORIGIN", preview)
    with pytest.raises(ValueError, match="EXIT_LINK_PUBLIC_PREVIEW_ORIGIN"):
        module.create_public_app()


def test_public_api_without_preview_keeps_production_only(app):
    with TestClient(app) as client:
        response = client.options("/api/v1/building", headers={
            "Origin": PREVIEW_ORIGIN, "Access-Control-Request-Method": "GET",
        })
        with pytest.raises(WebSocketDisconnect) as exc:
            with client.websocket_connect("/ws/v1/events", headers={"Origin": PREVIEW_ORIGIN}):
                pass
    assert response.status_code == 400
    assert exc.value.code == 1008
