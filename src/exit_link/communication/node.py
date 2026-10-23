"""Local node with compatible explicit routes and opt-in resilient delivery."""
import asyncio
import hashlib
import json
import math
import os
import sys
import time
from collections import OrderedDict

from pydantic import ValidationError

from exit_link.communication.protocol import (
    REQUEST, Ack, ConnectionFailed, ErrorResponse, GuidanceQuery, GuidanceReply, Heartbeat, Message, ProtocolError,
    ReliableSend, Shutdown, StatusRequest, StatusResponse, Stopped,
    close_writer, exchange, read_frame, utc_now, write_frame,
)
from exit_link.topology.models import CommunicationTopology
from exit_link.fault_detection.heartbeat import HeartbeatService
from exit_link.fault_detection.state import HeartbeatConfig
from exit_link.communication.reliable import deliver_reliably
from exit_link.evacuation.inbox import GuidanceInbox, parse_guidance


class TCPNode:
    def __init__(self, node_id: str, topology: CommunicationTopology, timeout: float = 5,
                 cache_size: int = 10000, dedup_seconds: float = 300,
                 heartbeat_config: HeartbeatConfig | None = None, relay_delay: float = 0, guidance_state=None):
        self.nodes = {node.id: node for node in topology.nodes}
        self.topology = topology
        if not math.isfinite(relay_delay) or relay_delay < 0:
            raise ValueError("Relay delay must be finite and nonnegative")
        self.relay_delay = relay_delay
        if node_id not in self.nodes:
            raise ValueError(f"Unknown node: {node_id}")
        if not math.isfinite(timeout) or not math.isfinite(dedup_seconds) or timeout <= 0 or cache_size <= 0 or dedup_seconds <= 0:
            raise ValueError("Timeout and dedup limits must be positive")
        self.node_id = node_id
        self.config = self.nodes[node_id]
        self.links = {frozenset((edge.source, edge.target)) for edge in topology.edges}
        self.timeout = timeout
        self.cache_size = cache_size
        self.dedup_seconds = dedup_seconds
        self.cache = OrderedDict()
        self.pending = {}
        self.handlers = set()
        self.server = None
        self.stop_event = asyncio.Event()
        self.guidance_inbox = GuidanceInbox(node_id, guidance_state)
        self.heartbeat = HeartbeatService(node_id, topology, heartbeat_config, self.log) if heartbeat_config else None

    def log(self, event: str, message: Message | None = None, **fields):
        record = {
            "timestamp": utc_now().isoformat(), "event": event, "node": self.node_id,
            "pid": os.getpid(), "transport": "tcp_loopback",
            "monotonic_ns": time.monotonic_ns(),
            "topology_origin": "simulation", "observation_origin": "real_process",
        }
        if message:
            record.update(message_id=str(message.message_id), source=message.source,
                          destination=message.destination, ttl=message.ttl, route=message.route)
        record.update(fields)
        print(json.dumps(record, ensure_ascii=False), flush=True)

    async def start(self):
        self.server = await asyncio.start_server(
            self.handle, self.config.host, self.config.port, reuse_address=False,
        )
        self.log("node_started", host=self.config.host, port=self.config.port,
                 parent_pid=os.getppid(), python_executable=sys.executable, python_prefix=sys.prefix)
        if self.heartbeat is not None:
            self.log("heartbeat_config", **vars(self.heartbeat.config), relay_delay=self.relay_delay)
            self.heartbeat.start()

    async def close(self):
        if self.heartbeat is not None:
            await self.heartbeat.close()
        if self.server is not None:
            self.server.close()
            # Close active streams before wait_closed (Python 3.12 waits for them).
            tasks = list(self.handlers)
            for task in tasks:
                task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            await self.server.wait_closed()
            self.server = None
            self.log("node_stopped")

    def error(self, code: str, detail: str, message: Message | None = None, **fields):
        self.log("error", message, code=code, detail=detail, **fields)
        return ErrorResponse(node=self.node_id, code=code, detail=detail,
                             message_id=message.message_id if message else None)

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        task = asyncio.current_task()
        self.handlers.add(task)
        shutdown = False
        try:
            if len(self.handlers) > 128:
                response = self.error("busy", "Concurrent connection limit reached")
            else:
                try:
                    request = REQUEST.validate_python(await read_frame(reader, self.timeout))
                    if isinstance(request, Shutdown):
                        self.log("shutdown_requested")
                        response = Stopped(node=self.node_id)
                        shutdown = True
                    elif isinstance(request, Heartbeat):
                        if self.heartbeat is None:
                            response = self.error("resilience_disabled", "Heartbeat is not enabled")
                        else:
                            response = self.heartbeat.reply(request)
                    elif isinstance(request, StatusRequest):
                        response = StatusResponse(
                            node=self.node_id, enabled=self.heartbeat is not None,
                            neighbors=self.heartbeat.status() if self.heartbeat else {},
                            advertisements=self.heartbeat.database.snapshot() if self.heartbeat else [],
                        )
                    elif isinstance(request, ReliableSend):
                        response = await deliver_reliably(self, request)
                    elif isinstance(request, GuidanceQuery):
                        receipt, latest = self.guidance_inbox.query(request.message_id)
                        response = GuidanceReply(node=self.node_id, queried_message_id=request.message_id,
                                                 receipt=receipt, latest=latest)
                    else:
                        response = await self.process(request)
                except (ValidationError, ProtocolError) as exc:
                    response = self.error("invalid_message", type(exc).__name__)
                except TimeoutError:
                    response = self.error("timeout", "Incoming request frame timed out", phase="request")
            await write_frame(writer, response, self.timeout)
            if isinstance(response, Ack):
                self.log("ack_sent", message_id=str(response.message_id), duplicate=response.duplicate)
        except (OSError, TimeoutError, ProtocolError) as exc:
            self.log("connection_closed", reason=type(exc).__name__)
        finally:
            await close_writer(writer)
            self.handlers.discard(task)
            if shutdown:
                self.stop_event.set()

    def validate_message(self, message: Message):
        if message.route[message.hop_index] != self.node_id:
            return self.error("wrong_hop", "Message sent to a node outside its current route hop", message)
        if any(node not in self.nodes for node in message.route):
            return self.error("invalid_route", "Route contains unknown node", message)
        if any(frozenset(pair) not in self.links for pair in zip(message.route, message.route[1:])):
            return self.error("invalid_route", "Route contains a link absent from topology", message)
        return None

    async def process(self, message: Message):
        invalid = self.validate_message(message)
        if invalid:
            return invalid
        # No await between checking and reserving an ID: atomic on this event loop.
        now = time.monotonic()
        while self.cache and next(iter(self.cache.values()))[0] <= now:
            self.cache.popitem(last=False)
        key = (message.source, message.message_id)
        # Logical content remains stable across retry routes, hop indexes and
        # decreasing TTL. Reusing the ID with different content is still denied.
        identity = message.model_dump_json(include={"message_id", "source", "destination", "timestamp", "payload"})
        fingerprint = hashlib.sha256(identity.encode()).hexdigest()
        if key in self.cache:
            _, old_fingerprint, ack = self.cache[key]
            if old_fingerprint != fingerprint:
                return self.error("message_id_conflict", "ID reused with different message content", message)
            self.log("duplicate", message)
            return ack.model_copy(update={"duplicate": True, "route": message.route})
        if key in self.pending:
            old_fingerprint, future = self.pending[key]
            if old_fingerprint != fingerprint:
                return self.error("message_id_conflict", "ID reused with different message content", message)
            self.log("duplicate_pending", message)
            result = await asyncio.shield(future)
            return result.model_copy(update={"duplicate": True, "route": message.route}) if isinstance(result, Ack) else result

        future = asyncio.get_running_loop().create_future()
        self.pending[key] = (fingerprint, future)
        try:
            result = await self.deliver_or_forward(message)
            if isinstance(result, Ack):
                self.cache[key] = (time.monotonic() + self.dedup_seconds, fingerprint, result)
                while len(self.cache) > self.cache_size:
                    self.cache.popitem(last=False)
            future.set_result(result)
            return result
        finally:
            self.pending.pop(key, None)
            if not future.done():
                future.cancel()

    async def deliver_or_forward(self, message: Message):
        if message.destination == self.node_id:
            try:
                guidance = parse_guidance(message)
                if guidance is not None:
                    receipt = self.guidance_inbox.receive(guidance)
                    self.log("guidance_" + receipt.disposition, message,
                             scenario_id=str(guidance.scenario_id), audience_id=guidance.audience_id,
                             scenario_revision=guidance.scenario_revision, route_version=guidance.route_version,
                             latest_guidance_id=str(receipt.latest_guidance_id), human_evacuation_verified=False)
            except (ValueError, ValidationError):
                return self.error("invalid_guidance", "Invalid guidance or transport identity", message)
            except OSError:
                return self.error("guidance_state_failed", "Guidance version state could not be saved", message)
            self.log("received", message, payload=message.payload)
            return Ack(message_id=message.message_id, source=self.node_id,
                       destination=message.source, route=message.route)
        if message.ttl == 0:
            return self.error("ttl_expired", "No forwarding hops remain", message)
        if self.relay_delay and message.hop_index > 0:
            self.log("relay_wait", message, configured_delay_s=self.relay_delay)
            await asyncio.sleep(self.relay_delay)
        next_id = message.route[message.hop_index + 1]
        next_node = self.nodes[next_id]
        forwarded = message.model_copy(update={
            "hop_index": message.hop_index + 1, "from_node": self.node_id, "ttl": message.ttl - 1,
        })
        self.log("send_attempt", message, next_node=next_id)
        try:
            response = await exchange(
                next_node.host, next_node.port, forwarded, self.timeout,
                on_sent=lambda: self.log("sent" if message.hop_index == 0 else "relayed", message, next_node=next_id),
            )
        except ConnectionFailed as exc:
            return self.error(
                "connection_failed", f"Cannot establish TCP connection to {next_id} ({exc.reason})", message,
                phase="connect", reason=exc.reason, errno=exc.cause_errno, winerror=exc.cause_winerror,
            )
        except TimeoutError:
            return self.error("timeout", f"TCP established but I/O with {next_id} timed out; delivery may be unknown",
                              message, phase="io")
        except OSError:
            return self.error("connection_failed", f"TCP I/O with {next_id} failed; delivery may be unknown",
                              message, phase="io")
        except (ProtocolError, ValidationError):
            return self.error("invalid_response", f"Invalid response from {next_id}", message)
        if not isinstance(response, (Ack, ErrorResponse)) or response.message_id != message.message_id:
            return self.error("invalid_response", "Unexpected response type or message ID", message)
        if isinstance(response, Ack):
            if (response.source != message.destination or response.destination != message.source
                    or response.route != message.route):
                return self.error("invalid_response", "ACK route/endpoints mismatch", message)
            self.log("ack_received", message, from_node=next_id, duplicate=response.duplicate)
        return response
