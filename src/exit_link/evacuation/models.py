from datetime import datetime, timezone
from typing import Literal, Self
from uuid import UUID, uuid4

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, JsonValue, model_validator


def now_utc():
    return datetime.now(timezone.utc)


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Passage(Model):
    source: str
    target: str

    @model_validator(mode="after")
    def different_ends(self) -> Self:
        if self.source == self.target:
            raise ValueError("Passage endpoints must differ")
        return self


class HazardUpdate(Model):
    """Full replacement of synthetic hazards, not a partial patch."""
    data_origin: Literal["simulation"] = "simulation"
    fire_locations: list[str] = Field(default_factory=list)
    dangerous_nodes: list[str] = Field(default_factory=list)
    blocked_nodes: list[str] = Field(default_factory=list)
    blocked_passages: list[Passage] = Field(default_factory=list)


class ScenarioDefinition(Model):
    schema_version: Literal["1.0"] = "1.0"
    name: str
    data_origin: Literal["simulation"] = "simulation"
    starts: list[str] = Field(min_length=1)
    steps: list[HazardUpdate]


class ScenarioState(Model):
    schema_version: Literal["1.0"] = "1.0"
    scenario_id: UUID = Field(default_factory=uuid4)
    building_id: str
    revision: int = Field(default=1, ge=1, strict=True)
    created_at: AwareDatetime = Field(default_factory=now_utc)
    updated_at: AwareDatetime = Field(default_factory=now_utc)
    hazards: HazardUpdate = Field(default_factory=HazardUpdate)
    data_origin: Literal["simulation"] = "simulation"
    real_world_safety_verified: Literal[False] = False


class ExitCandidate(Model):
    exit_id: str
    status: Literal["available", "blocked", "unreachable"]
    distance_m: float | None = Field(default=None, ge=0, allow_inf_nan=False)


class EvacuationPlan(Model):
    scenario_id: UUID
    building_id: str
    scenario_revision: int = Field(ge=1, strict=True)
    route_version: int = Field(ge=1, strict=True)
    start_location: str
    status: Literal["route_found", "no_route"]
    reason: Literal["minimum_distance", "start_blocked", "no_available_exit"]
    path: list[str] = Field(default_factory=list)
    exit_id: str | None = None
    distance_m: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    candidates: list[ExitCandidate]
    calculated_at: AwareDatetime = Field(default_factory=now_utc)
    algorithm: Literal["dijkstra"] = "dijkstra"
    cost_unit: Literal["m_assumed"] = "m_assumed"
    data_origin: Literal["simulation"] = "simulation"
    real_world_safety_verified: Literal[False] = False

    @model_validator(mode="after")
    def result_consistency(self) -> Self:
        if self.status == "route_found":
            if not self.path or self.path[0] != self.start_location or self.path[-1] != self.exit_id or self.distance_m is None:
                raise ValueError("Route result must include consistent path, exit and distance")
        elif self.path or self.exit_id is not None or self.distance_m is not None:
            raise ValueError("No-route result must not advertise a path, exit or cost")
        return self


class DisasterEvent(Model):
    event_id: UUID = Field(default_factory=uuid4)
    timestamp: AwareDatetime = Field(default_factory=now_utc)
    scenario_id: UUID
    scenario_revision: int = Field(ge=1, strict=True)
    event: Literal["scenario_created", "hazards_changed", "route_calculated", "guidance_prepared", "guidance_delivery_observed"]
    origin: Literal["simulation", "computation", "real_tcp_observation"]
    details: dict[str, JsonValue] = Field(default_factory=dict)


class ScenarioSnapshot(Model):
    schema_version: Literal["1.0"] = "1.0"
    state: ScenarioState
    plans: list[EvacuationPlan]
    events: list[DisasterEvent]


class Guidance(Model):
    kind: Literal["exit_link.evacuation_guidance"] = "exit_link.evacuation_guidance"
    schema_version: Literal["1.0"] = "1.0"
    guidance_id: UUID = Field(default_factory=uuid4)
    scenario_id: UUID
    building_id: str
    scenario_revision: int = Field(ge=1, strict=True)
    route_version: int = Field(ge=1, strict=True)
    audience_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    start_location: str
    source_node: str
    destination_node: str
    issued_at: AwareDatetime = Field(default_factory=now_utc)
    status: Literal["route_found", "no_route"]
    path: list[str]
    exit_id: str | None
    distance_m: float | None = Field(ge=0, allow_inf_nan=False)
    data_origin: Literal["simulation"] = "simulation"
    real_world_safety_verified: Literal[False] = False
    human_evacuation_verified: Literal[False] = False

    @model_validator(mode="after")
    def route_consistency(self) -> Self:
        if self.status == "route_found":
            if not self.path or self.path[0] != self.start_location or self.path[-1] != self.exit_id or self.distance_m is None:
                raise ValueError("Guidance path is inconsistent")
        elif self.path or self.exit_id is not None or self.distance_m is not None:
            raise ValueError("No-route guidance must explicitly omit a usable route")
        return self


class GuidanceReceipt(Model):
    message_id: UUID
    scenario_id: UUID
    audience_id: str
    disposition: Literal["applied", "stale", "duplicate", "version_conflict", "publisher_conflict"]
    received_at: AwareDatetime = Field(default_factory=now_utc)
    received_scenario_revision: int
    received_route_version: int
    latest_scenario_revision: int
    latest_route_version: int
    latest_guidance_id: UUID
    content_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    human_evacuation_verified: Literal[False] = False


class InboxState(Model):
    schema_version: Literal["1.0"] = "1.0"
    node_id: str
    latest: list[Guidance] = Field(default_factory=list, max_length=1024)
    receipts: list[GuidanceReceipt] = Field(default_factory=list, max_length=512)
