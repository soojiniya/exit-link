"""Virtual hazard/evacuation calculation only. No sockets and no real fire sensor input."""
import argparse
from datetime import datetime, timezone
from importlib.resources import files
from pathlib import Path
from uuid import uuid4

from exit_link.evacuation.dashboard import dashboard_snapshot
from exit_link.evacuation.models import ScenarioDefinition
from exit_link.evacuation.service import ScenarioSession
from exit_link.metrics.recording import write_observation
from exit_link.topology.loader import load_building, load_communication


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenario", type=Path, help="ScenarioDefinition JSON; omitted uses bundled virtual scenario")
    args = parser.parse_args()
    raw = args.scenario.read_text(encoding="utf-8") if args.scenario else files("exit_link").joinpath("data", "simulation", "disaster_scenario.json").read_text(encoding="utf-8")
    definition = ScenarioDefinition.model_validate_json(raw)
    root = Path(__file__).resolve().parents[1]
    output = root / "data/simulation-runs" / ("stage4-simulation-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid4().hex[:8])
    output.mkdir(parents=True)
    session = ScenarioSession(load_building())
    for start in definition.starts:
        session.plan(start)
    write_observation(output / "revision-1.json", session.snapshot().model_dump(mode="json"))
    for step in definition.steps:
        snapshot = session.update(step)
        write_observation(output / f"revision-{snapshot.state.revision}.json", snapshot.model_dump(mode="json"))
    view = dashboard_snapshot(load_building(), load_communication(), session.snapshot())
    write_observation(output / "dashboard.json", view.model_dump(mode="json"))
    print("Synthetic disaster computation only; no TCP or sensor experiment was performed.")
    for plan in session.snapshot().plans:
        print(plan.model_dump_json())
    print(f"Results: {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
