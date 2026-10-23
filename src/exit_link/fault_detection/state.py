"""Pure state machine and freshness rules; no simulated performance readings."""
import math
import time
from dataclasses import dataclass
from datetime import datetime, timezone

from exit_link.fault_detection.models import Advertisement


@dataclass(frozen=True)
class HeartbeatConfig:
    interval: float = 0.5
    timeout: float = 0.4
    failure_threshold: int = 3
    recovery_threshold: int = 2
    state_ttl: float = 6.0

    def __post_init__(self):
        if any(not math.isfinite(value) or value <= 0 for value in (self.interval, self.timeout, self.state_ttl)):
            raise ValueError("Heartbeat times must be finite and positive")
        if any(type(value) is not int for value in (self.failure_threshold, self.recovery_threshold)):
            raise ValueError("Failure/recovery thresholds must be integers")
        if self.failure_threshold < 2 or self.recovery_threshold < 1:
            raise ValueError("At least two failures and one recovery success are required")
        if self.state_ttl <= (self.interval + self.timeout) * self.failure_threshold:
            raise ValueError("State TTL must exceed the configured failure-detection window")


@dataclass
class NeighborState:
    status: str = "unknown"
    failures: int = 0
    successes: int = 0
    first_failure_at: float | None = None

    def observe(self, success: bool, now: float, config: HeartbeatConfig):
        before = self.status
        detection_ms = None
        if success:
            self.failures = 0
            self.successes += 1
            if self.status != "down" or self.successes >= config.recovery_threshold:
                self.status = "up"
                self.first_failure_at = None
        else:
            self.successes = 0
            self.failures += 1
            if self.first_failure_at is None:
                self.first_failure_at = now
            self.status = "down" if before == "down" or self.failures >= config.failure_threshold else "suspect"
            if before != "down" and self.status == "down":
                detection_ms = (now - self.first_failure_at) * 1000
        return before, self.status, detection_ms


class LinkStateDatabase:
    def __init__(self, topology, local_id, state_ttl, clock=time.monotonic,
                 wall_clock=lambda: datetime.now(timezone.utc)):
        self.local_id, self.state_ttl = local_id, state_ttl
        self.clock, self.wall_clock = clock, wall_clock
        self.neighbors = {node.id: set() for node in topology.nodes}
        for edge in topology.edges:
            self.neighbors[edge.source].add(edge.target)
            self.neighbors[edge.target].add(edge.source)
        self.entries = {}
        # Keep the watermark after expiration: replay cannot renew stale state.
        self.versions = {}

    def accept(self, advertisement: Advertisement, *, local=False):
        origin = advertisement.origin
        if origin not in self.neighbors or (origin == self.local_id and not local):
            return False
        if set(advertisement.links) != self.neighbors[origin]:
            return False
        age = (self.wall_clock() - advertisement.generated_at).total_seconds()
        if age < -1 or age >= self.state_ttl:
            return False
        version = (advertisement.epoch, advertisement.sequence)
        if version <= self.versions.get(origin, (0, 0)):
            return False
        self.versions[origin] = version
        self.entries[origin] = (advertisement.model_copy(deep=True), self.clock() + self.state_ttl - max(age, 0))
        return True

    def fresh(self):
        now = self.clock()
        return {origin: value for origin, (value, deadline) in self.entries.items() if deadline > now}

    def snapshot(self):
        return list(self.fresh().values())
