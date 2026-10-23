import importlib.util
import json
from pathlib import Path


def test_stage5_exports_match_executable_api_and_ws_contract():
    root = Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location("export_stage5", root / "scripts/export_stage5_contracts.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    for filename, expected in module.artifacts().items():
        actual = (root / "docs/contracts/stage5" / filename).read_text(encoding="utf-8")
        assert actual == expected, f"Regenerate contract: {filename}"
    frames = json.loads(module.artifacts()["WebSocket.schema.json"])
    assert set(frames["discriminator"]["mapping"]) == {"snapshot", "scenario.changed", "route.changed",
        "network.changed", "network.event", "guidance.result", "experiment.changed"}


def test_openapi_exposes_control_token_and_only_node_id_process_targets():
    root = Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location("export_stage5", root / "scripts/export_stage5_contracts.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    api = json.loads(module.artifacts()["openapi.json"])
    assert api["components"]["securitySchemes"]["APIKeyHeader"]["name"] == "X-Exit-Link-Token"
    for path, operations in api["paths"].items():
        for method, operation in operations.items():
            if method in {"post", "put", "delete"}:
                assert operation["security"] == [{"APIKeyHeader": []}], (method, path)
            if "/experiment/nodes/" in path:
                assert [p["name"] for p in operation.get("parameters", [])] == ["node_id"]
                assert "requestBody" not in operation
