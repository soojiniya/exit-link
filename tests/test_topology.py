import json

import networkx as nx
import pytest
from pydantic import ValidationError

from exit_link.topology.graphs import build_communication_graph, build_movement_graph
from exit_link.topology.loader import load_building, load_communication, validate_locations
from exit_link.topology.models import Building, CommunicationTopology


def test_building_has_three_floors_and_two_exit_routes():
    building = load_building()
    graph = build_movement_graph(building)
    exits = [node.id for node in building.nodes if node.kind == "exit"]
    assert building.floors == [1, 2, 3]
    assert len(exits) == 2
    assert nx.is_connected(graph)
    for node in building.nodes:
        for exit_id in exits:
            assert nx.has_path(graph, node.id, exit_id)
    for floor in building.floors:
        assert sum(node.kind == "stair" and node.floor == floor for node in building.nodes) == 2


def test_six_nodes_map_to_building_with_unique_local_endpoints():
    building, topology = load_building(), load_communication()
    validate_locations(building, topology)
    assert len(topology.nodes) == 6
    assert len({(node.host, node.port) for node in topology.nodes}) == 6
    assert {node.host for node in topology.nodes} == {"127.0.0.1"}
    assert {node.location_id for node in topology.nodes} == {
        f"F{floor}_{side}" for floor in (1, 2, 3) for side in ("W", "E")
    }


def test_communication_is_biconnected():
    graph = build_communication_graph(load_communication())
    assert graph.number_of_edges() == 7
    assert nx.is_biconnected(graph)


@pytest.mark.parametrize("failed_node", [f"N{i}" for i in range(1, 7)])
def test_every_single_node_failure_keeps_survivors_connected(failed_node):
    graph = build_communication_graph(load_communication())
    graph.remove_node(failed_node)
    assert len(graph) == 5
    assert nx.is_connected(graph)
    # Every surviving pair must remain reachable, independent of path length.
    for source in graph:
        for target in graph:
            assert nx.has_path(graph, source, target)


def test_graphs_are_separate_and_mutations_are_isolated():
    building, topology = load_building(), load_communication()
    movement = build_movement_graph(building)
    communication = build_communication_graph(topology)
    assert set(movement).isdisjoint(communication)
    assert movement.graph["graph_type"] == "movement"
    assert communication.graph["graph_type"] == "communication"
    communication.remove_node("N1")
    assert "F1_W" in movement
    assert "N1" in build_communication_graph(topology)
    assert all("distance_m" in attrs for _, _, attrs in movement.edges(data=True))
    assert all("distance_m" not in attrs for _, _, attrs in communication.edges(data=True))


@pytest.mark.parametrize("case", ["duplicate_node", "unknown_node", "self_loop", "duplicate_edge", "duplicate_endpoint", "measured_origin"])
def test_invalid_communication_data_is_rejected(case):
    data = load_communication().model_dump()
    if case == "duplicate_node":
        data["nodes"][1]["id"] = data["nodes"][0]["id"]
    elif case == "unknown_node":
        data["edges"][0]["target"] = "MISSING"
    elif case == "self_loop":
        data["edges"][0]["target"] = data["edges"][0]["source"]
    elif case == "duplicate_edge":
        edge = data["edges"][0]
        data["edges"].append({"source": edge["target"], "target": edge["source"]})
    elif case == "duplicate_endpoint":
        data["nodes"][1]["port"] = data["nodes"][0]["port"]
    else:
        data["metadata"]["data_origin"] = "measured"
    with pytest.raises(ValidationError):
        CommunicationTopology.model_validate(data)


@pytest.mark.parametrize("case", ["negative_distance", "cross_floor_corridor", "invalid_stairs", "missing_exit", "missing_floor"])
def test_invalid_building_data_is_rejected(case):
    data = load_building().model_dump()
    if case == "negative_distance":
        data["edges"][0]["distance_m"] = -1
    elif case == "cross_floor_corridor":
        data["edges"][0]["target"] = "F2_E"
    elif case == "invalid_stairs":
        data["edges"][0]["kind"] = "stairs"
    elif case == "missing_exit":
        for node in data["nodes"]:
            if node["kind"] == "exit":
                node["kind"] = "corridor"
    else:
        data["floors"] = [1, 2]
    with pytest.raises(ValidationError):
        Building.model_validate(data)


def test_unknown_physical_location_is_rejected():
    topology = load_communication()
    topology.nodes[0].location_id = "MISSING"
    with pytest.raises(ValueError, match="Unknown building location"):
        validate_locations(load_building(), topology)


def test_custom_json_path_and_working_directory_independence(tmp_path, monkeypatch):
    building = load_building()
    custom = tmp_path / "building.json"
    custom.write_text(json.dumps(building.model_dump()), encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    assert load_building(custom) == building
    assert load_building() == building
    assert len(load_communication().nodes) == 6
