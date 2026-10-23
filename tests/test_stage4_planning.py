"""Virtual graph/scenario checks, not evidence of real-world fire safety."""
import json

import pytest
from pydantic import ValidationError

from exit_link.evacuation.dashboard import DashboardSnapshot, dashboard_snapshot
from exit_link.evacuation.models import HazardUpdate, Passage, ScenarioSnapshot
from exit_link.evacuation.service import ScenarioSession
from exit_link.topology.graphs import build_communication_graph, build_movement_graph
from exit_link.topology.loader import load_building, load_communication
from exit_link.topology.models import Building


def session():
    return ScenarioSession(load_building())


def test_normal_route_and_multiple_exit_costs():
    plan = session().plan("F3_W")
    assert plan.path == ["F3_W", "F3_SW", "F2_SW", "F1_SW", "F1_W", "EXIT_W"]
    assert plan.exit_id == "EXIT_W" and plan.distance_m == 30
    assert {candidate.exit_id: candidate.distance_m for candidate in plan.candidates} == {"EXIT_E": 50, "EXIT_W": 30}
    assert plan.data_origin == "simulation" and not plan.real_world_safety_verified


def test_weighted_distance_is_used_instead_of_number_of_edges():
    data = load_building().model_dump()
    for edge in data["edges"]:
        if edge["source"] == "F2_SW" and edge["target"] == "F3_SW":
            edge["distance_m"] = 100
    plan = ScenarioSession(Building.model_validate(data)).plan("F3_W")
    assert plan.exit_id == "EXIT_E" and plan.distance_m == 50


def test_equal_exit_costs_have_deterministic_tie_break():
    data = load_building().model_dump()
    data["nodes"].append(dict(id="F1_C", floor=1, kind="corridor", label="Synthetic test center"))
    data["edges"].extend([dict(source="F1_C", target=side, kind="corridor", distance_m=10) for side in ("F1_W", "F1_E")])
    plan = ScenarioSession(Building.model_validate(data)).plan("F1_C")
    assert plan.exit_id == "EXIT_E" and plan.distance_m == 14


@pytest.mark.parametrize("field", ["fire_locations", "dangerous_nodes", "blocked_nodes"])
def test_hazard_change_recalculates_tracked_route(field):
    scenario = session()
    old = scenario.plan("F3_W")
    snapshot = scenario.update(HazardUpdate(**{field: ["F2_SW"]}))
    updated = scenario.plan("F3_W")
    assert updated.exit_id == "EXIT_E" and "F2_SW" not in updated.path
    assert updated.scenario_revision == old.scenario_revision + 1
    assert updated.route_version == old.route_version + 1
    assert snapshot.plans[0] == updated
    assert any(event.event == "hazards_changed" for event in snapshot.events)


def test_blocked_stair_passage_is_excluded_both_directions():
    scenario = session()
    scenario.plan("F3_W")
    scenario.update(HazardUpdate(blocked_passages=[Passage(source="F3_SW", target="F2_SW")]))
    assert scenario.plan("F3_W").exit_id == "EXIT_E"


def test_blocked_exit_selects_other_exit():
    scenario = session()
    scenario.update(HazardUpdate(blocked_nodes=["EXIT_W"]))
    plan = scenario.plan("F3_W")
    assert plan.exit_id == "EXIT_E"
    assert next(item for item in plan.candidates if item.exit_id == "EXIT_W").status == "blocked"


@pytest.mark.parametrize("hazards", [
    HazardUpdate(blocked_nodes=["EXIT_W", "EXIT_E"]),
    HazardUpdate(fire_locations=["F2_SW", "F2_SE"]),
    HazardUpdate(blocked_passages=[Passage(source="F3_SW", target="F2_SW"), Passage(source="F3_SE", target="F2_SE")]),
])
def test_all_exits_or_stair_routes_unavailable(hazards):
    scenario = session()
    scenario.update(hazards)
    plan = scenario.plan("F3_W")
    assert plan.status == "no_route" and not plan.path
    assert plan.exit_id is None and plan.distance_m is None


def test_start_in_danger_is_no_route_not_a_safe_path():
    scenario = session()
    scenario.update(HazardUpdate(fire_locations=["F3_W"]))
    plan = scenario.plan("F3_W")
    assert plan.status == "no_route" and plan.reason == "start_blocked"


def test_start_at_available_exit_is_zero_distance():
    plan = session().plan("EXIT_W")
    assert plan.path == ["EXIT_W"] and plan.distance_m == 0


@pytest.mark.parametrize("hazards", [
    HazardUpdate(fire_locations=["MISSING"]), HazardUpdate(blocked_nodes=["N1"]),
    HazardUpdate(fire_locations=["F1_W", "F1_W"]),
    HazardUpdate(blocked_passages=[Passage(source="F1_W", target="F3_W")]),
    HazardUpdate(blocked_passages=[Passage(source="F1_W", target="F1_E"), Passage(source="F1_E", target="F1_W")]),
])
def test_invalid_update_is_rejected_without_changing_state(hazards):
    scenario = session()
    before = scenario.snapshot()
    with pytest.raises(ValueError):
        scenario.update(hazards)
    assert scenario.snapshot() == before


def test_unknown_start_is_rejected():
    with pytest.raises(ValueError):
        session().plan("UNKNOWN")


def test_snapshot_round_trip_and_noop_update():
    scenario = session()
    scenario.plan("F3_W")
    scenario.update(HazardUpdate(fire_locations=["F2_SW"]))
    snapshot = ScenarioSnapshot.model_validate_json(scenario.snapshot().model_dump_json())
    restored = ScenarioSession(load_building(), snapshot)
    assert restored.snapshot() == snapshot
    assert restored.update(snapshot.state.hazards) == snapshot


def test_corrupted_cached_path_cannot_be_restored():
    scenario = session()
    scenario.plan("F3_W")
    raw = scenario.snapshot().model_dump(mode="json")
    raw["plans"][0]["distance_m"] = 1
    with pytest.raises(ValueError, match="does not match"):
        ScenarioSession(load_building(), ScenarioSnapshot.model_validate(raw))


def test_movement_and_communication_are_not_mutated():
    building, topology = load_building(), load_communication()
    movement, network = build_movement_graph(building), build_communication_graph(topology)
    scenario = ScenarioSession(building)
    scenario.update(HazardUpdate(blocked_nodes=["EXIT_W"]))
    scenario.plan("F3_W")
    assert "EXIT_W" in movement and movement.number_of_edges() == 15
    assert network.number_of_edges() == 7 and len(network) == 6
    assert building == load_building() and topology == load_communication()


def test_dashboard_json_groups_floors_and_marks_unobserved_network():
    scenario = session()
    scenario.plan("F3_W")
    view = dashboard_snapshot(load_building(), load_communication(), scenario.snapshot())
    assert [floor.floor for floor in view.floors] == [1, 2, 3]
    assert view.floors[0].exit_ids == ["EXIT_W", "EXIT_E"]
    assert view.network_nodes == [] and view.guidance_deliveries == []
    assert DashboardSnapshot.model_validate_json(view.model_dump_json()) == view
    assert not view.human_evacuation_verified


def test_impossible_no_route_payload_is_rejected():
    guidance = session().guidance("F3_W", "N1", "N4").model_dump()
    guidance["status"] = "no_route"
    from exit_link.evacuation.models import Guidance
    with pytest.raises(ValidationError):
        Guidance.model_validate(guidance)
