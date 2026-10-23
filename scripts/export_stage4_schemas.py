"""Regenerate self-contained JSON Schema contracts from the validated models."""
import json
from pathlib import Path

from exit_link.communication.protocol import GuidanceQuery, GuidanceReply
from exit_link.evacuation.dashboard import DashboardSnapshot
from exit_link.evacuation.models import EvacuationPlan, Guidance, GuidanceReceipt, HazardUpdate, ScenarioDefinition, ScenarioSnapshot
from exit_link.evacuation.transport import GuidanceDelivery

MODELS = [HazardUpdate, ScenarioDefinition, ScenarioSnapshot, EvacuationPlan, Guidance,
          GuidanceReceipt, GuidanceDelivery, GuidanceQuery, GuidanceReply, DashboardSnapshot]


def main():
    output = Path(__file__).resolve().parents[1] / "docs/schemas/stage4"
    output.mkdir(parents=True, exist_ok=True)
    for model in MODELS:
        (output / f"{model.__name__}.schema.json").write_text(json.dumps(model.model_json_schema(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Exported {len(MODELS)} schemas: {output}")


if __name__ == "__main__":
    main()
