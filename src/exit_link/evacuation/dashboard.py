"""Typed JSON projection for future FastAPI/React adapters. No frontend or new HTTP routes."""
from typing import Literal

from pydantic import AwareDatetime, Field, JsonValue

from exit_link.communication.client import get_status
from exit_link.communication.protocol import ProtocolError
from exit_link.evacuation.models import Model, ScenarioSnapshot, now_utc
from exit_link.evacuation.transport import GuidanceDelivery
from exit_link.fault_detection.models import Advertisement, LinkStatus
from exit_link.topology.models import Building, CommunicationTopology
from exit_link.topology.loader import validate_locations


class FloorView(Model):
    floor: int
    node_ids: list[str]
    corridor_ids: list[str]
    stair_ids: list[str]
    exit_ids: list[str]


class NeighborView(Model):
    node_id: str
    status: LinkStatus
    failures: int
    successes: int


class NetworkNodeView(Model):
    node_id: str
    observed_at: AwareDatetime = Field(default_factory=now_utc)
    reachable: bool
    heartbeat_enabled: bool | None = None
    neighbors: list[NeighborView] = Field(default_factory=list)
    advertisements: list[Advertisement] = Field(default_factory=list)
    error: str | None = None
    observation_origin: Literal["real_tcp_observation"] = "real_tcp_observation"


class NetworkEvent(Model):
    timestamp: AwareDatetime
    event: str
    node_id: str
    transport: Literal["tcp_loopback"] = "tcp_loopback"
    observation_origin: Literal["real_process"] = "real_process"
    details: dict[str, JsonValue] = Field(default_factory=dict)


class DashboardSnapshot(Model):
    schema_version: Literal["1.0"] = "1.0"
    generated_at: AwareDatetime = Field(default_factory=now_utc)
    building: Building
    floors: list[FloorView]
    communication_topology: CommunicationTopology
    scenario: ScenarioSnapshot
    network_nodes: list[NetworkNodeView]
    guidance_deliveries: list[GuidanceDelivery]
    network_events: list[NetworkEvent]
    human_evacuation_verified: Literal[False] = False


def dashboard_snapshot(building, topology, scenario, network_nodes=(), deliveries=(), network_events=()):
    validate_locations(building, topology)
    if scenario.state.building_id != building.building_id:
        raise ValueError("Dashboard scenario/building mismatch")
    if any(delivery.scenario_id != scenario.state.scenario_id for delivery in deliveries):
        raise ValueError("Dashboard contains another scenario's delivery")
    floors = [FloorView(floor=floor, node_ids=[node.id for node in building.nodes if node.floor == floor],
        corridor_ids=[node.id for node in building.nodes if node.floor == floor and node.kind == "corridor"],
        stair_ids=[node.id for node in building.nodes if node.floor == floor and node.kind == "stair"],
        exit_ids=[node.id for node in building.nodes if node.floor == floor and node.kind == "exit"])
        for floor in building.floors]
    return DashboardSnapshot(building=building, floors=floors, communication_topology=topology, scenario=scenario,
                             network_nodes=list(network_nodes), guidance_deliveries=list(deliveries), network_events=list(network_events))


async def observe_network(topology, timeout=1):
    views = []
    for node in topology.nodes:
        try:
            status = await get_status(topology, node.id, timeout)
            neighbors = [NeighborView(node_id=key, status=value.get("status"), failures=value.get("failures"), successes=value.get("successes"))
                         for key, value in status.neighbors.items()]
            views.append(NetworkNodeView(node_id=node.id, reachable=True, heartbeat_enabled=status.enabled,
                                         neighbors=neighbors, advertisements=status.advertisements))
        except (OSError, ValueError, ProtocolError) as exc:
            views.append(NetworkNodeView(node_id=node.id, reachable=False, error=type(exc).__name__ + ": " + str(exc)))
    return views


def network_event(raw):
    if raw.get("transport") != "tcp_loopback" or raw.get("observation_origin") != "real_process":
        raise ValueError("Not a real TCP process log")
    return NetworkEvent(timestamp=raw["timestamp"], event=raw["event"], node_id=raw["node"],
                        details={key: value for key, value in raw.items() if key not in {"timestamp", "event", "node"}})
