"""Single-worker adapter over the existing scenario and real TCP engines.

Scenario/catalog state and the bounded event stream live in this app's memory.
Owned subprocess logs and receiver version guards are written under data/measured.
"""
import asyncio
import errno
import json
import logging
from collections import deque
from contextlib import suppress
from uuid import uuid4

from exit_link.api.contracts import (BackendSnapshot, BuildingView, DeliveryObserved, ExperimentChanged,
    ExperimentView, FaultObserved, NetworkChanged, NetworkView, OwnedNode, RouteChanged, ScenarioChanged)
from exit_link.api.events import EventBus
from exit_link.api.security import ApiSettings, fail
from exit_link.evacuation.dashboard import FloorView, network_event, observe_network
from exit_link.evacuation.models import now_utc
from exit_link.evacuation.service import ScenarioSession
from exit_link.evacuation.transport import send_guidance
from exit_link.simulation.processes import LocalCluster, NodeStartError
from exit_link.topology.loader import load_building, load_communication
from exit_link.storage.archive import Archive, utc


class Backend:
    def __init__(self, settings: ApiSettings):
        self.settings = settings
        self.building, self.project_topology = load_building(), load_communication()
        self.sessions = {}
        self.deliveries = deque(maxlen=512)
        self.bus = EventBus()
        self.network = NetworkView(topology=self.project_topology)
        self.experiment = ExperimentView(enabled=settings.experiments_enabled)
        self.cluster = None
        self.control_lock, self.observe_lock = asyncio.Lock(), asyncio.Lock()
        self.log_offsets = {}
        self.monitor_task = None
        self.inflight = 0
        self.archive = Archive(settings.database_path or settings.artifact_directory / "history.sqlite3", settings.persistence_enabled)
        self.archive_contexts, self.message_contexts = {}, {}

    def archive_context(self, experiment_id=None):
        experiment_id = str(experiment_id) if experiment_id else (str(self.experiment.experiment_id) if self.cluster else None)
        if not experiment_id:
            return {}
        context = self.archive_contexts.get(experiment_id)
        if context is None:
            return {}
        if str(self.experiment.experiment_id) == experiment_id:
            context["view"] = self.experiment_view().model_dump(mode="json")
            if self.cluster:
                context["topology"] = self.cluster.topology.model_dump(mode="json")
                context["conditions"] = {"poll_seconds": self.settings.poll_seconds,
                    "observation_timeout_seconds": self.settings.observation_timeout,
                    "relay_delay_seconds": self.cluster.relay_delay,
                    "processes": self.cluster.history.copy()}
        return context

    def publish(self, model, payload, source_key=None):
        event = self.bus.publish(model, payload)
        if event.type == "network.changed":
            return event
        if event.type == "experiment.changed" and payload.experiment_id:
            key = str(payload.experiment_id)
            self.archive_contexts.setdefault(key, {"experiment_id": key, "created_at": event.timestamp.isoformat(),
                "view": payload.model_dump(mode="json"), "conditions": {}, "topology": None})
            context = self.archive_context(key)
        elif event.type == "guidance.result":
            context = self.message_contexts.get(str(payload.message_id), {})
        else:
            context = self.archive_context()
        context = dict(context)
        if source_key:
            context["source_key"] = source_key
        self.archive.record("event", event.model_dump(mode="json"), context)
        return event

    def control_intent(self, action, node_id=None):
        record = {"action_id": str(uuid4()), "action": action, "node_id": node_id,
            "requested_at": utc(), "completed_at": None, "state": "requested",
            "details": {"fault_type": "owned_process_kill"} if action == "kill" else {}}
        context = self.archive_context(self.experiment.experiment_id)
        self.archive.record("control", record, context)
        return record

    def control_completed(self, record, error=None, **details):
        record.update(completed_at=utc(), state="failed" if error else "succeeded")
        record["details"].update(details)
        if error:
            record["details"]["error"] = error
        self.archive.record("control", record, self.archive_context(self.experiment.experiment_id))

    @property
    def topology(self):
        return self.cluster.topology if self.cluster else self.project_topology

    def building_view(self):
        return BuildingView(building=self.building, floors=[FloorView(floor=f,
            node_ids=[p.id for p in self.building.nodes if p.floor == f],
            corridor_ids=[p.id for p in self.building.nodes if p.floor == f and p.kind == "corridor"],
            stair_ids=[p.id for p in self.building.nodes if p.floor == f and p.kind == "stair"],
            exit_ids=[p.id for p in self.building.nodes if p.floor == f and p.kind == "exit"])
            for f in self.building.floors])

    def snapshot(self):
        return BackendSnapshot(stream_id=self.bus.stream_id, sequence=self.bus.sequence,
            scenarios=[session.snapshot() for session in self.sessions.values()], network=self.network,
            experiment=self.experiment_view(), deliveries=list(self.deliveries))

    def session(self, scenario_id):
        session = self.sessions.get(scenario_id)
        if session is None:
            fail("scenario_not_found", "Unknown scenario", 404)
        return session

    def writable_session(self, scenario_id, expected=None):
        session = self.session(scenario_id)
        if expected is not None and session.state.revision != expected:
            fail("revision_conflict", f"Current revision is {session.state.revision}", 409)
        if len(session.events) >= 2048:
            fail("scenario_limit", "Session event limit reached; create a new scenario", 409)
        return session

    def create_scenario(self, request):
        if len(self.sessions) >= 32:
            fail("scenario_limit", "At most 32 scenarios per server session", 409)
        session = ScenarioSession(self.building)
        session.update(request.hazards)
        for start in request.starts:
            session.plan(start)
        self.sessions[session.state.scenario_id] = session
        self.publish(ScenarioChanged, session.snapshot())
        for plan in session.plans.values():
            self.publish(RouteChanged, plan)
        return session.snapshot()

    def replace_hazards(self, scenario_id, request):
        session = self.writable_session(scenario_id, request.expected_revision)
        previous = session.state.revision
        result = session.update(request.hazards)
        if previous != session.state.revision:
            self.publish(ScenarioChanged, result)
            for plan in result.plans:
                self.publish(RouteChanged, plan)
        return result

    def plan(self, scenario_id, start):
        session = self.writable_session(scenario_id)
        existed = start in session.plans
        plan = session.plan(start)
        if not existed:
            self.publish(ScenarioChanged, session.snapshot())
            self.publish(RouteChanged, plan)
        return plan

    async def deliver(self, scenario_id, request):
        session = self.writable_session(scenario_id, request.expected_revision)
        known = {node.id for node in self.topology.nodes}
        if request.source_node not in known or request.destination_node not in known or request.source_node == request.destination_node:
            fail("invalid_nodes", "Use distinct known source and destination nodes", 422)
        if self.inflight >= 8:
            fail("delivery_limit", "At most 8 simultaneous guidance sends", 429)
        guidance = session.guidance(request.start_location, request.source_node, request.destination_node)
        self.publish(ScenarioChanged, session.snapshot())
        self.publish(RouteChanged, session.plans[request.start_location])
        context = self.archive_context()
        self.message_contexts[str(guidance.guidance_id)] = dict(context)
        self.archive.record("guidance", {"guidance": guidance.model_dump(mode="json"),
            "scenario": session.snapshot().model_dump(mode="json")}, context)
        topology = self.topology.model_copy(deep=True)
        self.inflight += 1
        try:
            delivery = await send_guidance(topology, guidance, ttl=request.ttl, max_retries=request.max_retries,
                                           timeout=request.timeout_seconds)
            session.record_delivery(delivery)
            self.deliveries.append(delivery)
            self.publish(DeliveryObserved, delivery)
            return delivery
        finally:
            self.inflight -= 1
            self.message_contexts.pop(str(guidance.guidance_id), None)

    def experiment_view(self):
        nodes = [] if self.cluster is None else [OwnedNode(node_id=node, pid=process.pid,
            running=process.poll() is None) for node, process in self.cluster.processes.items()]
        return self.experiment.model_copy(update={"nodes": nodes}, deep=True)

    def experiment_changed(self, **changes):
        self.experiment = self.experiment.model_copy(update=changes)
        self.publish(ExperimentChanged, self.experiment_view())
        self.archive.record("config", {}, self.archive_context(self.experiment.experiment_id))

    def require_experiment(self):
        if not self.settings.experiments_enabled:
            fail("experiments_disabled", "Set EXIT_LINK_ENABLE_EXPERIMENTS=1 before starting the server", 403)

    async def start_experiment(self):
        self.require_experiment()
        async with self.control_lock:
            if self.cluster is not None:
                fail("experiment_exists", "Stop the owned experiment before starting another", 409)
            if self.inflight:
                fail("delivery_in_progress", "Wait for pending guidance results", 409)
            experiment_id = uuid4()
            self.experiment_changed(experiment_id=experiment_id, status="starting", last_error=None)
            action = self.control_intent("start")
            try:
                self.cluster = LocalCluster(self.settings.artifact_directory / str(experiment_id), relay_delay=0)
                self.reset_network()
                self.archive.record("config", {}, self.archive_context(experiment_id))
                await asyncio.to_thread(self.cluster.start_all)
                await self.cluster.wait_ready()
            except Exception as exc:
                error = type(exc).__name__ + ": " + str(exc)
                if self.cluster:
                    try:
                        await self.cluster.close()
                    except Exception as cleanup:
                        error += "; cleanup: " + str(cleanup)
                self.cluster = None
                self.reset_network()
                self.experiment_changed(status="failed", last_error=error)
                self.control_completed(action, error=error)
                fail("experiment_start_failed", error, 503)
            self.experiment_changed(status="running")
            self.control_completed(action)
            await self.refresh_network()
            return self.experiment_view()

    async def control_node(self, node_id, recover=False):
        self.require_experiment()
        async with self.control_lock:
            if self.cluster is None or self.experiment.status != "running":
                fail("experiment_not_running", "No running owned experiment", 409)
            if node_id not in self.cluster.processes:
                fail("node_not_found", "Unknown owned node", 404)
            process = self.cluster.processes[node_id]
            if (process.poll() is None) == recover:
                fail("node_state_conflict", "Node already has the requested process state", 409)
            action = self.control_intent("recover" if recover else "kill", node_id)
            try:
                if recover:
                    for attempt in range(3):
                        try:
                            await asyncio.to_thread(self.cluster.start, node_id)
                            break
                        except NodeStartError as exc:
                            failure = exc.record["failure"]
                            # Retry only a proven bind conflict that has already cleared.
                            # Occupied/reserved endpoints and all other failures surface as 503.
                            conflict = failure["errno"] == errno.EADDRINUSE or failure["winerror"] == 10048
                            released = failure["port_evidence"]["bind"]["available"]
                            if not conflict or not released or attempt == 2:
                                raise
                            exc.record["retry_reason"] = "address_conflict_cleared_before_retry"
                else:
                    action["details"]["fault"] = await asyncio.to_thread(self.cluster.kill, node_id)
            except Exception as exc:
                self.control_completed(action, error=str(exc), old_pid=process.pid)
                self.experiment_changed(last_error=str(exc))
                fail("node_control_failed", str(exc), 503)
            self.experiment_changed(last_error=None)
            self.control_completed(action, old_pid=process.pid, current_pid=self.cluster.processes[node_id].pid)
            await self.refresh_network()
            return self.experiment_view()

    def reset_network(self):
        self.network = NetworkView(topology=self.topology, configuration_source="owned_experiment" if self.cluster else "project")
        self.publish(NetworkChanged, self.network)

    async def stop_experiment(self):
        async with self.control_lock:
            if self.cluster is None:
                return self.experiment_view()
            self.experiment_changed(status="stopping")
            action = self.control_intent("stop")
            error = None
            try:
                await self.cluster.close()
                self.collect_logs(self.cluster)
            except Exception as exc:
                error = str(exc)
            finally:
                self.cluster = None
                self.reset_network()
                self.experiment_changed(status="failed" if error else "stopped", last_error=error)
                self.control_completed(action, error=error)
            if error:
                fail("experiment_cleanup_failed", error, 503)
            return self.experiment_view()

    def collect_logs(self, cluster):
        for entry in cluster.history:
            path = cluster.directory / entry["log"]
            # Read only complete, newly appended JSONL records. Gossip sequence changes
            # stay in raw evidence; state transitions and message events reach the UI.
            with path.open("rb") as handle:
                handle.seek(self.log_offsets.get(path, 0))
                while line := handle.readline():
                    if not line.endswith(b"\n"):
                        break
                    offset = handle.tell() - len(line)
                    self.log_offsets[path] = handle.tell()
                    try:
                        raw = json.loads(line)
                        if not isinstance(raw, dict):
                            raise ValueError("Process event must be a JSON object")
                    except (ValueError, UnicodeError) as exc:
                        # stdout and stderr share the owned process log. Native
                        # asyncio diagnostics are not JSON events and must not
                        # turn a confirmed normal shutdown into an HTTP 503.
                        # Keep the raw evidence and make the skipped offset visible.
                        logging.getLogger(__name__).warning(
                            "Non-event process log line retained at %s byte %s: %s",
                            path, offset, exc,
                            extra={"diagnostic_code": "process_log_non_event", "log_path": str(path), "byte_offset": offset})
                        continue
                    source_key = f"process:{self.experiment.experiment_id}:{entry['log']}:{entry['pid']}:{offset}"
                    if raw.get("event") == "heartbeat_config":
                        self.archive.record("process_config", raw, dict(self.archive_context(), source_key=source_key))
                        continue
                    if raw.get("event") == "state_updated":
                        continue
                    if raw.get("transport") == "tcp_loopback" and raw.get("observation_origin") == "real_process":
                        self.publish(FaultObserved, network_event(raw), source_key=source_key)

    async def refresh_network(self):
        async with self.observe_lock:
            cluster, topology = self.cluster, self.topology
            try:
                nodes = await observe_network(topology, self.settings.observation_timeout)
                # Discard observations from a cluster that has been replaced while awaiting I/O.
                if cluster is not self.cluster:
                    return self.network
                self.network = NetworkView(topology=topology, nodes=nodes, observation_status="observed",
                    observed_at=now_utc(), configuration_source="owned_experiment" if cluster else "project")
                if cluster:
                    self.collect_logs(cluster)
            except Exception as exc:
                self.network = self.network.model_copy(update={"observation_status": "error",
                    "monitor_error": type(exc).__name__ + ": " + str(exc)})
            self.publish(NetworkChanged, self.network)
            return self.network

    async def monitor(self):
        while True:
            await self.refresh_network()
            await asyncio.sleep(self.settings.poll_seconds)

    async def start(self):
        await self.archive.start()
        if self.settings.monitor_enabled:
            self.monitor_task = asyncio.create_task(self.monitor())

    async def close(self):
        if self.monitor_task:
            self.monitor_task.cancel()
            with suppress(asyncio.CancelledError):
                await self.monitor_task
        try:
            await self.stop_experiment()
        finally:
            await self.archive.close()
