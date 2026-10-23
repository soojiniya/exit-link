"""Neighbor-only periodic probes carry a bounded gossip snapshot (six origins)."""
import asyncio
import time
from dataclasses import asdict

from pydantic import ValidationError

from exit_link.communication.protocol import Heartbeat, HeartbeatReply, ProtocolError, exchange, utc_now
from exit_link.fault_detection.models import Advertisement
from exit_link.fault_detection.state import LinkStateDatabase, NeighborState


class HeartbeatService:
    def __init__(self, node_id, topology, config, log):
        self.node_id, self.config, self.log = node_id, config, log
        self.nodes = {node.id: node for node in topology.nodes}
        self.database = LinkStateDatabase(topology, node_id, config.state_ttl)
        self.states = {neighbor: NeighborState() for neighbor in sorted(self.database.neighbors[node_id])}
        self.epoch, self.sequence = time.time_ns(), 0
        self.task = None
        self.publish()

    def publish(self):
        self.sequence += 1
        self.database.accept(Advertisement(
            origin=self.node_id, epoch=self.epoch, sequence=self.sequence, generated_at=utc_now(),
            links={neighbor: state.status for neighbor, state in self.states.items()},
        ), local=True)

    def merge(self, advertisements):
        for advertisement in advertisements:
            if self.database.accept(advertisement):
                self.log("state_updated", origin=advertisement.origin, epoch=advertisement.epoch,
                         sequence=advertisement.sequence)

    def reply(self, request):
        if request.destination != self.node_id or request.source not in self.states:
            raise ProtocolError("Heartbeat must use a configured adjacent link")
        self.merge(request.advertisements)
        return HeartbeatReply(source=self.node_id, destination=request.source, probe_id=request.probe_id,
                              advertisements=self.database.snapshot())

    async def probe(self, neighbor):
        peer = self.nodes[neighbor]
        request = Heartbeat(source=self.node_id, destination=neighbor, advertisements=self.database.snapshot())
        reason = None
        try:
            response = await exchange(peer.host, peer.port, request, self.config.timeout)
            if not isinstance(response, HeartbeatReply) or (
                response.source != neighbor or response.destination != self.node_id or response.probe_id != request.probe_id
            ):
                raise ProtocolError("Heartbeat response correlation mismatch")
            self.merge(response.advertisements)
        except (OSError, ProtocolError, ValidationError) as exc:
            reason = getattr(exc, "reason", type(exc).__name__)
        state = self.states[neighbor]
        before, after, duration = state.observe(reason is None, time.monotonic(), self.config)
        if before != after:
            event = {"suspect": "neighbor_suspect", "down": "neighbor_down", "up": "neighbor_recovered" if before == "down" else "neighbor_up"}[after]
            self.log(event, neighbor=neighbor, previous=before, status=after, failures=state.failures,
                     successes=state.successes, reason=reason, detection_since_first_failure_ms=duration)
            self.publish()

    async def run(self):
        while True:
            await asyncio.gather(*(self.probe(neighbor) for neighbor in self.states))
            self.publish()  # Fresh sequence even without a transition; replay does not refresh age.
            await asyncio.sleep(self.config.interval)

    def start(self):
        self.task = asyncio.create_task(self.run(), name=f"heartbeat-{self.node_id}")

    async def close(self):
        if self.task is not None:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
            self.task = None

    def status(self):
        return {neighbor: asdict(state) for neighbor, state in self.states.items()}
