"""Stage 5 HTTP/WS contracts reuse stage 4 models without changing TCP schemas."""
from typing import Annotated, Literal
from uuid import UUID, uuid4

from pydantic import AwareDatetime, Field

from exit_link.evacuation.dashboard import FloorView, NetworkEvent, NetworkNodeView
from exit_link.evacuation.models import EvacuationPlan, HazardUpdate, Model, ScenarioSnapshot, now_utc
from exit_link.evacuation.transport import GuidanceDelivery
from exit_link.topology.models import Building, CommunicationTopology


class BuildingView(Model):
    building: Building
    floors: list[FloorView]


class ScenarioCreate(Model):
    starts: list[str] = Field(min_length=1, max_length=14)
    hazards: HazardUpdate = Field(default_factory=HazardUpdate)


class HazardReplace(Model):
    expected_revision: int = Field(ge=1, strict=True)
    hazards: HazardUpdate


class PlanRequest(Model):
    start_location: str = Field(min_length=1, max_length=64)


class GuidanceSend(PlanRequest):
    source_node: str = Field(min_length=1, max_length=64)
    destination_node: str = Field(min_length=1, max_length=64)
    expected_revision: int = Field(ge=1, strict=True)
    ttl: int = Field(default=16, ge=1, le=64, strict=True)
    max_retries: int = Field(default=3, ge=0, le=6, strict=True)
    timeout_seconds: float = Field(default=30, ge=1, le=60, allow_inf_nan=False)


class NetworkView(Model):
    topology: CommunicationTopology
    nodes: list[NetworkNodeView] = Field(default_factory=list)
    observation_status: Literal["not_observed", "observed", "error"] = "not_observed"
    observed_at: AwareDatetime | None = None
    monitor_error: str | None = None
    topology_origin: Literal["simulation"] = "simulation"
    transport: Literal["real_tcp_loopback"] = "real_tcp_loopback"
    configuration_source: Literal["project", "owned_experiment"] = "project"


class OwnedNode(Model):
    node_id: str
    pid: int
    running: bool


class ExperimentView(Model):
    enabled: bool
    experiment_id: UUID | None = None
    status: Literal["stopped", "starting", "running", "failed", "stopping"] = "stopped"
    nodes: list[OwnedNode] = Field(default_factory=list)
    last_error: str | None = None
    observation_origin: Literal["real_process_control"] = "real_process_control"


class BackendSnapshot(Model):
    schema_version: Literal["1.0"] = "1.0"
    stream_id: UUID
    sequence: int
    generated_at: AwareDatetime = Field(default_factory=now_utc)
    scenarios: list[ScenarioSnapshot]
    network: NetworkView
    experiment: ExperimentView
    deliveries: list[GuidanceDelivery]
    human_evacuation_verified: Literal[False] = False


class EventBase(Model):
    schema_version: Literal["1.0"] = "1.0"
    stream_id: UUID
    sequence: int = Field(ge=1)
    event_id: UUID = Field(default_factory=uuid4)
    timestamp: AwareDatetime = Field(default_factory=now_utc)


class ScenarioChanged(EventBase):
    type: Literal["scenario.changed"] = "scenario.changed"
    payload: ScenarioSnapshot


class RouteChanged(EventBase):
    type: Literal["route.changed"] = "route.changed"
    payload: EvacuationPlan


class NetworkChanged(EventBase):
    type: Literal["network.changed"] = "network.changed"
    payload: NetworkView


class FaultObserved(EventBase):
    type: Literal["network.event"] = "network.event"
    payload: NetworkEvent


class DeliveryObserved(EventBase):
    type: Literal["guidance.result"] = "guidance.result"
    payload: GuidanceDelivery


class ExperimentChanged(EventBase):
    type: Literal["experiment.changed"] = "experiment.changed"
    payload: ExperimentView


LiveEvent = Annotated[ScenarioChanged | RouteChanged | NetworkChanged | FaultObserved | DeliveryObserved | ExperimentChanged,
                      Field(discriminator="type")]


class SnapshotFrame(Model):
    type: Literal["snapshot"] = "snapshot"
    payload: BackendSnapshot


class EventPage(Model):
    stream_id: UUID
    sequence: int
    reset_required: bool
    events: list[LiveEvent]


class ErrorDetail(Model):
    code: str
    message: str


class ApiError(Model):
    detail: ErrorDetail
