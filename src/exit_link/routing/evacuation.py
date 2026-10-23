"""Weighted shortest paths over a copy of the synthetic MOVEMENT graph."""
import networkx as nx

from exit_link.evacuation.models import EvacuationPlan, ExitCandidate
from exit_link.topology.graphs import build_movement_graph


def validate_hazards(building, hazards):
    graph = build_movement_graph(building)
    for group in (hazards.fire_locations, hazards.dangerous_nodes, hazards.blocked_nodes):
        if len(group) != len(set(group)) or not set(group) <= set(graph):
            raise ValueError("Hazard locations must be unique known building spaces")
    seen = set()
    for passage in hazards.blocked_passages:
        edge = frozenset((passage.source, passage.target))
        if edge in seen or not graph.has_edge(passage.source, passage.target):
            raise ValueError("Blocked passage must be a unique existing undirected movement edge")
        seen.add(edge)


def calculate_evacuation(building, state, start, route_version):
    graph = build_movement_graph(building)
    if state.building_id != building.building_id or start not in graph:
        raise ValueError("Scenario/building mismatch or unknown start location")
    validate_hazards(building, state.hazards)
    excluded = set(state.hazards.fire_locations + state.hazards.dangerous_nodes + state.hazards.blocked_nodes)
    graph.remove_nodes_from(excluded)
    graph.remove_edges_from((edge.source, edge.target) for edge in state.hazards.blocked_passages)
    distances, paths = nx.single_source_dijkstra(graph, start, weight="distance_m") if start in graph else ({}, {})
    candidates = []
    for node in sorted(building.nodes, key=lambda item: item.id):
        if node.kind == "exit":
            candidates.append(ExitCandidate(exit_id=node.id,
                status="blocked" if node.id in excluded else "available" if node.id in distances else "unreachable",
                distance_m=distances.get(node.id)))
    available = [item for item in candidates if item.status == "available"]
    best = min(available, key=lambda item: (item.distance_m, item.exit_id)) if available else None
    return EvacuationPlan(
        scenario_id=state.scenario_id, building_id=building.building_id, scenario_revision=state.revision,
        route_version=route_version, start_location=start,
        status="route_found" if best else "no_route",
        reason="minimum_distance" if best else "start_blocked" if start in excluded else "no_available_exit",
        path=paths[best.exit_id] if best else [], exit_id=best.exit_id if best else None,
        distance_m=best.distance_m if best else None, candidates=candidates,
    )
