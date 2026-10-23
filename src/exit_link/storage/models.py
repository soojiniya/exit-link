"""Archive DTOs; distinct from the current live WebSocket snapshot."""
from typing import Literal
from uuid import UUID

from pydantic import AwareDatetime, Field, JsonValue

from exit_link.api.contracts import ExperimentView
from exit_link.evacuation.models import Model
from exit_link.evacuation.transport import GuidanceDelivery
from exit_link.topology.models import CommunicationTopology


class StorageStatus(Model):
    enabled: bool
    state: Literal["not_started", "ready", "degraded", "disabled", "closed"]
    run_id: UUID
    sqlite_version: str | None = None
    journal_mode: str | None = None
    schema_version: int | None = None
    pending: int
    failed: int
    dropped: int
    last_error: str | None = None
    last_error_at: AwareDatetime | None = None
    last_commit_at: AwareDatetime | None = None
    recording_mode: Literal["asynchronous"] = "asynchronous"


class ExperimentHistory(Model):
    archive_id: int
    experiment_id: UUID
    run_id: UUID
    created_at: AwareDatetime
    started_at: AwareDatetime | None
    ended_at: AwareDatetime | None
    interruption_detected_at: AwareDatetime | None
    status: Literal["starting", "running", "stopping", "stopped", "failed", "interrupted"]
    recording_complete: bool
    environment: dict[str, JsonValue]
    conditions: dict[str, JsonValue]
    topology: CommunicationTopology | None
    last_control_state: ExperimentView
    topology_origin: Literal["simulation"] = "simulation"
    transport: Literal["real_tcp_loopback"] = "real_tcp_loopback"


class ExperimentPage(Model):
    items: list[ExperimentHistory]
    next_cursor: int | None


class ArchivedEvent(Model):
    archive_id: int
    event_id: UUID
    run_id: UUID
    experiment_id: UUID | None
    stream_id: UUID | None
    sequence: int | None
    type: str
    occurred_at: AwareDatetime
    recorded_at: AwareDatetime
    payload: dict[str, JsonValue]


class ArchiveEventPage(Model):
    items: list[ArchivedEvent]
    next_after: int | None


class ArchivedDelivery(Model):
    archive_id: int
    experiment_id: UUID | None
    delivery: GuidanceDelivery


class DeliveryHistoryPage(Model):
    items: list[ArchivedDelivery]
    next_cursor: int | None


class ArchivedControl(Model):
    archive_id: int
    action_id: UUID
    experiment_id: UUID
    action: Literal["start", "stop", "kill", "recover"]
    node_id: str | None
    requested_at: AwareDatetime
    completed_at: AwareDatetime | None
    state: Literal["requested", "succeeded", "failed", "interrupted"]
    details: dict[str, JsonValue]


class ControlHistoryPage(Model):
    items: list[ArchivedControl]
    next_cursor: int | None


class MetricStats(Model):
    n: int = Field(ge=1)
    minimum: float
    maximum: float
    mean: float
    median: float
    unit: Literal["ms"] = "ms"


class ExperimentComparison(Model):
    experiment_id: UUID
    recording_complete: bool
    recorded_deliveries: int
    ack_received: int
    ack_rate: float | None
    disposition_counts: dict[str, int]
    retries_total: int | None
    delivery_latency: MetricStats | None
    route_calculation: MetricStats | None
    delivery_recovery: MetricStats | None
    heartbeat_detection: MetricStats | None
    route_changes: int
    scope: Literal["recorded_observations"] = "recorded_observations"
    heartbeat_scope: Literal["after_experiment_ready"] = "after_experiment_ready"


class ComparisonPage(Model):
    items: list[ExperimentComparison]
