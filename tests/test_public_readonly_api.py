"""P1-4 guard: the public Render API (exit_link.public_app:app) stays read-only.

No TCP node is started; the app is exercised in-process only.
"""
import importlib

import pytest
from fastapi.routing import APIRoute, APIWebSocketRoute
from fastapi.testclient import TestClient

ORIGIN = "https://exit-link-unit.example"


def load(monkeypatch, origin=ORIGIN):
    # The module builds its ASGI app at import time from the environment, as Render does.
    monkeypatch.setenv("EXIT_LINK_PUBLIC_ORIGIN", origin)
    return importlib.import_module("exit_link.public_app")


@pytest.fixture
def app(monkeypatch):
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
