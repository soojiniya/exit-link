from fastapi.testclient import TestClient

from exit_link.main import create_app


def test_health():
    with TestClient(create_app()) as client:
        response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {
        "status": "ok", "service": "EXIT-LINK", "stage": 1, "data_mode": "simulation"
    }


def test_openapi_exposes_health():
    with TestClient(create_app()) as client:
        schema = client.get("/openapi.json").json()
    assert "/health" in schema["paths"]
