import importlib.util
import json
from pathlib import Path


def test_exported_schemas_match_current_contracts():
    root = Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location("stage4_schema_export", root / "scripts/export_stage4_schemas.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert len(module.MODELS) == 10
    for model in module.MODELS:
        schema = json.loads((root / "docs/schemas/stage4" / f"{model.__name__}.schema.json").read_text(encoding="utf-8"))
        assert schema == model.model_json_schema()
        assert schema["additionalProperties"] is False
