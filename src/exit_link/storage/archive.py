"""One SQLite connection on one bounded worker, independent of the TCP engine.

Accepted jobs are FIFO; history queries are barriers for preceding writes. Failures
are visible and logged; they never turn a transport ACK into a failed transmission.
"""
import asyncio
import json
import logging
import math
import os
import platform
import queue
import statistics
import sys
import threading
import time
from concurrent.futures import Future
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID, uuid4, uuid5, NAMESPACE_URL

import apsw
from pydantic import TypeAdapter

from exit_link.api.contracts import LiveEvent, ExperimentView
from exit_link.evacuation.models import Guidance, ScenarioSnapshot
from exit_link.evacuation.transport import GuidanceDelivery
from exit_link.storage import schema
from exit_link.storage.models import (ArchiveEventPage, ArchivedDelivery, ArchivedEvent, ComparisonPage,
    DeliveryHistoryPage, ExperimentComparison, ExperimentHistory, ExperimentPage, MetricStats, StorageStatus,
    ArchivedControl, ControlHistoryPage)

log = logging.getLogger("exit_link.storage")
EVENT = TypeAdapter(LiveEvent)


def utc():
    return datetime.now(timezone.utc).isoformat()


def dump(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def environment():
    return {"platform": platform.platform(), "python": sys.version, "sqlite": apsw.sqlitelibversion(),
        "apsw": apsw.apswversion(), "clock_domain_id": str(uuid4()),
        "monotonic": vars(time.get_clock_info("monotonic")),
        "perf_counter": vars(time.get_clock_info("perf_counter")), "topology_origin": "simulation"}


def nonnegative(value):
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise ValueError("Invalid nonnegative measured value")
    return value


def stats(values):
    values = [v for v in values if v is not None]
    return None if not values else MetricStats(n=len(values), minimum=min(values), maximum=max(values),
        mean=statistics.mean(values), median=statistics.median(values))


class StorageUnavailable(RuntimeError):
    pass


class Archive:
    def __init__(self, path, enabled=True, capacity=1024):
        self.path, self.enabled = Path(path), enabled
        self.run_id, self.environment = str(uuid4()), environment()
        self.jobs = queue.Queue(capacity)
        self.thread, self.connection, self.owner_lock = None, None, None
        self.guard = threading.Lock()
        self.closing = False
        self.failed_experiments = set()
        self._status = dict(enabled=enabled, state="not_started" if enabled else "disabled", run_id=self.run_id,
            sqlite_version=None, journal_mode=None, schema_version=None, pending=0, failed=0, dropped=0,
            last_error=None, last_error_at=None, last_commit_at=None)

    def status(self):
        with self.guard:
            return StorageStatus(**self._status)

    def _ensure_thread(self):
        with self.guard:
            if self.thread is None and self.enabled and not self.closing:
                self.thread = threading.Thread(target=self._worker, name="exit-link-archive", daemon=True)
                self.thread.start()

    def record(self, kind, payload, context):
        if not self.enabled:
            return False
        return self._enqueue(kind, payload, context, None)

    def _enqueue(self, kind, payload, context, future):
        self._ensure_thread()
        if self.closing:
            if future:
                future.set_exception(StorageUnavailable("Archive is closing"))
            return False
        try:
            # Freeze the captured experiment association and DTO before the caller mutates state.
            item = (kind, json.loads(dump(payload)), json.loads(dump(context)), future)
            with self.guard:
                self._status["pending"] += 1
            try:
                self.jobs.put_nowait(item)
            except queue.Full:
                with self.guard:
                    self._status["pending"] -= 1
                raise
            return True
        except Exception as exc:
            self._error(kind, context, exc, dropped=True)
            if future:
                future.set_exception(StorageUnavailable(str(exc)))
            return False

    async def query(self, operation, **params):
        if not self.enabled:
            raise StorageUnavailable("Persistence is disabled")
        future = Future()
        self._enqueue("query", {"operation": operation, **params}, {}, future)
        try:
            return await asyncio.wait_for(asyncio.wrap_future(future), timeout=15)
        except asyncio.TimeoutError as exc:
            raise StorageUnavailable("Archive query timed out") from exc

    async def start(self):
        if self.enabled:
            try:
                await self.query("barrier")
            except StorageUnavailable:
                pass  # Live operation remains available; status/history expose the failure.

    def _error(self, kind, context, exc, dropped=False, payload=None):
        message = type(exc).__name__ + ": " + str(exc)
        with self.guard:
            self._status.update(state="degraded", last_error=message, last_error_at=utc())
            self._status["failed"] += 1
            self._status["dropped"] += int(dropped)
            if context.get("experiment_id"):
                self.failed_experiments.add(context["experiment_id"])
        log.error("archive_write_error kind=%s experiment=%s error=%s", kind, context.get("experiment_id"), message)
        # Worker-side dead letters retain failed data. Queue-overflow is counted/logged
        # without doing filesystem I/O on the real-time event-loop thread.
        if payload is not None:
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                with (self.path.parent / f"archive-errors-{self.run_id}.jsonl").open("a", encoding="utf-8") as stream:
                    stream.write(dump({"timestamp": utc(), "kind": kind, "context": context,
                                       "error": message, "payload": payload}) + "\n")
            except OSError:
                log.exception("Unable to write archive dead-letter log")

    def _acquire_owner(self):
        handle = self.path.with_suffix(self.path.suffix + ".lock").open("a+b")
        try:
            if handle.tell() == 0:
                handle.write(b"0")
                handle.flush()
            handle.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except Exception:
            handle.close()
            raise StorageUnavailable("Another backend owns this archive; use one worker")
        self.owner_lock = handle

    def _open(self):
        version = tuple(map(int, apsw.sqlitelibversion().split(".")))
        if version < (3, 51, 3) and version not in {(3, 50, 7), (3, 44, 6)}:
            raise StorageUnavailable("A SQLite WAL-reset fix is required")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._acquire_owner()
        con = apsw.Connection(str(self.path))
        self.connection = con
        con.set_busy_timeout(150)
        con.execute("PRAGMA foreign_keys=ON")
        app_id = con.execute("PRAGMA application_id").fetchone()[0]
        tables = con.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        if app_id not in (0, schema.APPLICATION_ID) or (app_id == 0 and tables):
            raise StorageUnavailable("Database is not an EXIT-LINK archive")
        mode = con.execute("PRAGMA journal_mode=WAL").fetchone()[0]
        if mode != "wal":
            raise StorageUnavailable("WAL mode could not be enabled")
        con.execute("PRAGMA synchronous=FULL")
        con.execute("PRAGMA wal_autocheckpoint=1000")
        con.execute("BEGIN IMMEDIATE")
        try:
            current = con.execute("PRAGMA user_version").fetchone()[0]
            if current == 0:
                con.execute(schema.DDL)
                con.execute("INSERT INTO schema_migrations VALUES(?,?,?)", (schema.VERSION, schema.CHECKSUM, utc()))
                con.execute(f"PRAGMA application_id={schema.APPLICATION_ID}")
                con.execute(f"PRAGMA user_version={schema.VERSION}")
            elif current != schema.VERSION or con.execute("SELECT checksum FROM schema_migrations WHERE version=?", (current,)).fetchone() != (schema.CHECKSUM,):
                raise StorageUnavailable("Unsupported or modified archive migration")
            now = utc()
            # The process lock proves no other live backend owns these previous runs.
            con.execute("UPDATE experiments SET status='interrupted',interruption_detected_at=? WHERE status IN ('starting','running','stopping')", (now,))
            con.execute("UPDATE control_actions SET state='interrupted' WHERE state='requested'")
            con.execute("UPDATE backend_runs SET ended_at=?,end_reason='interrupted',recording_complete=0 WHERE ended_at IS NULL", (now,))
            con.execute("INSERT INTO backend_runs(run_id,started_at,environment_json) VALUES(?,?,?)",
                        (self.run_id, now, dump(self.environment)))
            con.execute("COMMIT")
        except Exception:
            con.execute("ROLLBACK")
            raise
        if con.execute("PRAGMA quick_check").fetchone() != ("ok",) or con.execute("PRAGMA foreign_key_check").fetchone():
            raise StorageUnavailable("Archive integrity check failed")
        with self.guard:
            self._status.update(state="degraded" if self._status["failed"] else "ready", sqlite_version=apsw.sqlitelibversion(),
                                journal_mode=mode, schema_version=schema.VERSION)

    def _discard_connection(self):
        if self.connection:
            self.connection.close()
            self.connection = None
        if self.owner_lock:
            self.owner_lock.close()
            self.owner_lock = None

    def _worker(self):
        while True:
            kind, payload, context, future = self.jobs.get()
            try:
                if self.connection is None:
                    try:
                        self._open()
                    except Exception:
                        self._discard_connection()
                        raise
                if kind == "close":
                    self._persist_incompleteness()
                    self.connection.execute("UPDATE backend_runs SET ended_at=?,end_reason='normal' WHERE run_id=?", (utc(), self.run_id))
                    self.connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                    self._discard_connection()
                    with self.guard:
                        self._status["state"] = "closed"
                    if future and not future.done():
                        future.set_result(None)
                    return
                if kind == "query":
                    self._persist_incompleteness()
                    result = self._query(payload)
                else:
                    self.connection.execute("BEGIN IMMEDIATE")
                    try:
                        self._ensure_experiment(context)
                        self._write(kind, payload, context)
                        self._mark_incomplete()
                        self.connection.execute("COMMIT")
                        result = None
                        with self.guard:
                            self._status["last_commit_at"] = utc()
                    except Exception:
                        self.connection.execute("ROLLBACK")
                        raise
                if future and not future.done():
                    future.set_result(result)
            except Exception as exc:
                self._error(kind, context, exc, payload=payload)
                if future and not future.done():
                    future.set_exception(StorageUnavailable(str(exc)))
                if kind == "close":
                    self._discard_connection()
                    return
            finally:
                with self.guard:
                    self._status["pending"] -= 1
                self.jobs.task_done()

    def _mark_incomplete(self):
        with self.guard:
            incomplete = self._status["failed"] > 0
            affected = tuple(self.failed_experiments)
        if incomplete:
            self.connection.execute("UPDATE backend_runs SET recording_complete=0 WHERE run_id=?", (self.run_id,))
            for exp_id in affected:
                self.connection.execute("UPDATE experiments SET recording_complete=0 WHERE experiment_id=?", (exp_id,))

    def _persist_incompleteness(self):
        # Also flush after a failed final write, even when no more live events arrive.
        if not self.status().failed:
            return
        self.connection.execute("BEGIN IMMEDIATE")
        try:
            self._mark_incomplete()
            self.connection.execute("COMMIT")
        except Exception:
            self.connection.execute("ROLLBACK")
            raise

    def _ensure_experiment(self, context):
        if not context.get("experiment_id"):
            return
        con = self.connection
        exp_id = str(UUID(context["experiment_id"]))
        view = ExperimentView.model_validate(context["view"])
        if str(view.experiment_id) != exp_id:
            raise ValueError("Experiment context mismatch")
        topology = context.get("topology")
        if topology is not None:
            from exit_link.topology.models import CommunicationTopology
            topology = CommunicationTopology.model_validate(topology).model_dump(mode="json")
        existing = con.execute("SELECT run_id FROM experiments WHERE experiment_id=?", (exp_id,)).fetchone()
        if existing and existing[0] != self.run_id:
            raise ValueError("Cannot mutate an experiment from another backend run")
        con.execute("""INSERT INTO experiments(experiment_id,run_id,created_at,status,recording_complete,conditions_json,topology_json,last_control_json)
            VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(experiment_id) DO NOTHING""",
            (exp_id, self.run_id, context["created_at"], view.status, int(exp_id not in self.failed_experiments),
             dump(context.get("conditions", {})), dump(topology) if topology is not None else None, view.model_dump_json()))

    def _immutable(self, table, key_column, key, json_column, body):
        existing = self.connection.execute(f"SELECT {json_column} FROM {table} WHERE {key_column}=?", (key,)).fetchone()
        if existing:
            if json.loads(existing[0]) != body:
                raise ValueError(f"Conflicting immutable {table} ID")
            return True
        return False

    def _revision(self, snapshot):
        state = snapshot.state
        body = state.hazards.model_dump(mode="json")
        row = self.connection.execute("SELECT building_id,hazards_json FROM scenario_revisions WHERE scenario_id=? AND revision=?",
                                      (str(state.scenario_id), state.revision)).fetchone()
        if row and (row[0] != state.building_id or json.loads(row[1]) != body):
            raise ValueError("Scenario revision content conflict")
        self.connection.execute("INSERT OR IGNORE INTO scenario_revisions VALUES(?,?,?,?)",
                               (str(state.scenario_id), state.revision, state.building_id, dump(body)))

    def _write(self, kind, payload, context):
        con, exp_id = self.connection, context.get("experiment_id")
        if kind == "config":
            con.execute("UPDATE experiments SET conditions_json=?,topology_json=coalesce(?,topology_json) WHERE experiment_id=?",
                (dump(context.get("conditions",{})),dump(context["topology"]) if context.get("topology") else None,exp_id))
            return
        if kind == "control":
            action_id = str(UUID(payload["action_id"]))
            if payload["action"] not in {"start", "stop", "kill", "recover"} or payload["state"] not in {"requested", "succeeded", "failed"}:
                raise ValueError("Invalid control record")
            previous = con.execute("SELECT run_id,experiment_id,action,node_id,requested_at,state,details_json FROM control_actions WHERE action_id=?", (action_id,)).fetchone()
            if previous:
                if previous[:5] != (self.run_id,exp_id,payload["action"],payload.get("node_id"),payload["requested_at"]):
                    raise ValueError("Control action identity conflict")
                if previous[5] != "requested":
                    if payload["state"] == "requested":
                        return
                    if previous[5] != payload["state"] or json.loads(previous[6]) != payload.get("details",{}):
                        raise ValueError("Control completion conflict")
                    return
            con.execute("""INSERT INTO control_actions(action_id,run_id,experiment_id,action,node_id,requested_at,completed_at,state,details_json)
                VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(action_id) DO UPDATE SET
                completed_at=excluded.completed_at,state=excluded.state,details_json=excluded.details_json""",
                (action_id, self.run_id, exp_id, payload["action"], payload.get("node_id"), payload["requested_at"],
                 payload.get("completed_at"), payload["state"], dump(payload.get("details", {}))))
            return
        if kind == "guidance":
            guidance = Guidance.model_validate(payload["guidance"])
            snapshot = ScenarioSnapshot.model_validate(payload["scenario"])
            if guidance.scenario_id != snapshot.state.scenario_id or guidance.scenario_revision != snapshot.state.revision:
                raise ValueError("Guidance scenario revision mismatch")
            self._revision(snapshot)
            body = guidance.model_dump(mode="json")
            previous = con.execute("SELECT run_id,experiment_id FROM guidance_messages WHERE message_id=?", (str(guidance.guidance_id),)).fetchone()
            if previous and previous != (self.run_id, exp_id):
                raise ValueError("Guidance ID experiment association conflict")
            if not self._immutable("guidance_messages", "message_id", str(guidance.guidance_id), "guidance_json", body):
                con.execute("INSERT INTO guidance_messages VALUES(?,?,?,?,?,?,?,?)", (str(guidance.guidance_id), self.run_id,
                    exp_id, str(guidance.scenario_id), guidance.scenario_revision, guidance.route_version, guidance.issued_at.isoformat(), dump(body)))
            return
        if kind not in {"event", "process_config"}:
            raise ValueError("Unknown archive operation")
        if kind == "event":
            event = EVENT.validate_python(payload)
            payload = event.model_dump(mode="json")
            if event.type == "network.changed":
                return  # Periodic topology polls remain in live memory; avoid unbounded gossip duplication.
            body = payload["payload"]
            source_key = context.get("source_key") or f"live:{self.run_id}:{event.stream_id}:{event.sequence}"
            occurred = body["timestamp"] if event.type == "network.event" else payload["timestamp"]
            stream_id, sequence = str(event.stream_id), event.sequence
            event_id, event_type = str(event.event_id), event.type
        else:
            body, source_key = payload, context["source_key"]
            occurred = body["timestamp"]
            stream_id, sequence, event_type = None, None, "process.config"
            event_id = str(uuid5(NAMESPACE_URL, source_key))
        old = con.execute("SELECT type,payload_json,experiment_id FROM event_log WHERE source_key=? OR event_id=?", (source_key, event_id)).fetchone()
        if old:
            if old[0] != event_type or json.loads(old[1]) != body or old[2] != exp_id:
                raise ValueError("Event ID/source content conflict")
            return
        details = body.get("details", {}) if event_type == "network.event" else {}
        detection = nonnegative(details.get("detection_since_first_failure_ms")) if body.get("event") == "neighbor_down" else None
        con.execute("""INSERT INTO event_log(event_id,run_id,experiment_id,source_key,stream_id,sequence,type,occurred_at,
            recorded_at,payload_json,node_id,target_node,detection_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (event_id, self.run_id, exp_id, source_key, stream_id, sequence, event_type, occurred, utc(), dump(body),
             body.get("node_id"), details.get("neighbor"), detection))
        if event_type == "experiment.changed":
            state = body["status"]
            con.execute("""UPDATE experiments SET status=?,last_control_json=?,
                started_at=CASE WHEN ?='running' THEN coalesce(started_at,?) ELSE started_at END,
                ended_at=CASE WHEN ? IN ('stopped','failed') THEN coalesce(ended_at,?) ELSE ended_at END
                WHERE experiment_id=?""", (state, dump(body), state, occurred, state, occurred, str(body["experiment_id"])))
        elif event_type == "scenario.changed":
            snapshot = ScenarioSnapshot.model_validate(body)
            self._revision(snapshot)
            con.execute("INSERT INTO scenario_snapshots VALUES(?,?,?,?)", (event_id, str(snapshot.state.scenario_id), snapshot.state.revision, dump(body)))
        elif event_type == "guidance.result":
            self._delivery(body, exp_id)

    def _delivery(self, body, exp_id):
        con = self.connection
        delivery = GuidanceDelivery.model_validate(body)
        message_id = str(delivery.message_id)
        message = con.execute("SELECT experiment_id,guidance_json FROM guidance_messages WHERE message_id=?", (message_id,)).fetchone()
        if message is None or message[0] != exp_id:
            raise ValueError("Missing guidance intent or wrong experiment association")
        guidance = Guidance.model_validate_json(message[1])
        if (guidance.scenario_id, guidance.scenario_revision, guidance.route_version, guidance.audience_id,
            guidance.source_node, guidance.destination_node) != (delivery.scenario_id, delivery.scenario_revision,
            delivery.route_version, delivery.audience_id, delivery.source_node, delivery.destination_node):
            raise ValueError("Delivery does not match prepared guidance")
        if self._immutable("guidance_deliveries", "message_id", message_id, "delivery_json", body):
            return
        result = delivery.transport_result
        con.execute("""INSERT INTO guidance_deliveries(message_id,ack_received,elapsed_ms,route_calculation_ms,recovery_ms,retries,observed_at,delivery_json)
            VALUES(?,?,?,?,?,?,?,?)""", (message_id, int(delivery.ack_received), nonnegative(result.elapsed_ms) if result else None,
            nonnegative(result.route_calculation_ms) if result else None, nonnegative(result.recovery_after_first_failure_ms) if result else None,
            result.retries if result else None, delivery.observed_at.isoformat(), dump(body)))
        if result:
            for attempt in result.attempts:
                con.execute("INSERT INTO delivery_attempts VALUES(?,?,?,?,?,?)", (message_id, attempt.number,
                    nonnegative(attempt.duration_ms), nonnegative(attempt.route_calculation_ms), dump(attempt.route), attempt.outcome))

    def _experiment(self, row):
        archive_id, exp_id, run_id, created, started, ended, interrupted, status, complete, conditions, topology, view, env, run_complete = row
        return ExperimentHistory(archive_id=archive_id, experiment_id=exp_id, run_id=run_id, created_at=created,
            started_at=started, ended_at=ended, interruption_detected_at=interrupted, status=status,
            recording_complete=bool(complete and run_complete), environment=json.loads(env), conditions=json.loads(conditions),
            topology=json.loads(topology) if topology else None, last_control_state=json.loads(view))

    def _experiment_rows(self, where="", params=()):
        return self.connection.execute("SELECT e.*,r.environment_json,r.recording_complete FROM experiments e JOIN backend_runs r USING(run_id) " + where, params).fetchall()

    def _query(self, args):
        operation = args["operation"]
        con = self.connection
        if operation == "barrier":
            return self.status()
        if operation == "experiments":
            cursor, limit = args.get("cursor"), args.get("limit", 50)
            rows = self._experiment_rows("WHERE (? IS NULL OR e.archive_id<?) ORDER BY e.archive_id DESC LIMIT ?", (cursor, cursor, limit + 1))
            return ExperimentPage(items=[self._experiment(r) for r in rows[:limit]], next_cursor=rows[limit-1][0] if len(rows)>limit else None)
        exp_id = args.get("experiment_id")
        if operation == "detail":
            rows = self._experiment_rows("WHERE e.experiment_id=?", (exp_id,))
            return self._experiment(rows[0]) if rows else None
        if operation == "events":
            rows = con.execute("""SELECT archive_id,event_id,run_id,experiment_id,stream_id,sequence,type,occurred_at,recorded_at,payload_json
                FROM event_log WHERE experiment_id=? AND archive_id>? AND (? IS NULL OR type=? OR json_extract(payload_json,'$.event')=?)
                ORDER BY archive_id LIMIT ?""", (exp_id, args.get("after",0), args.get("event_type"), args.get("event_type"),
                args.get("event_type"),args.get("limit",100)+1)).fetchall()
            limit = args.get("limit",100)
            return ArchiveEventPage(items=[ArchivedEvent(archive_id=r[0],event_id=r[1],run_id=r[2],experiment_id=r[3],stream_id=r[4],
                sequence=r[5],type=r[6],occurred_at=r[7],recorded_at=r[8],payload=json.loads(r[9])) for r in rows[:limit]],
                next_after=rows[limit-1][0] if len(rows)>limit else None)
        if operation == "deliveries":
            cursor,limit = args.get("cursor"),args.get("limit",50)
            rows = con.execute("""SELECT d.archive_id,m.experiment_id,d.delivery_json FROM guidance_deliveries d
                JOIN guidance_messages m USING(message_id) WHERE m.experiment_id=? AND (? IS NULL OR d.archive_id<?)
                ORDER BY d.archive_id DESC LIMIT ?""",(exp_id,cursor,cursor,limit+1)).fetchall()
            return DeliveryHistoryPage(items=[ArchivedDelivery(archive_id=r[0],experiment_id=r[1],delivery=json.loads(r[2])) for r in rows[:limit]],
                next_cursor=rows[limit-1][0] if len(rows)>limit else None)
        if operation == "controls":
            cursor,limit = args.get("cursor"),args.get("limit",50)
            rows = con.execute("""SELECT archive_id,action_id,experiment_id,action,node_id,requested_at,completed_at,state,details_json
                FROM control_actions WHERE experiment_id=? AND (? IS NULL OR archive_id<?) ORDER BY archive_id DESC LIMIT ?""",
                (exp_id,cursor,cursor,limit+1)).fetchall()
            return ControlHistoryPage(items=[ArchivedControl(archive_id=r[0],action_id=r[1],experiment_id=r[2],action=r[3],node_id=r[4],
                requested_at=r[5],completed_at=r[6],state=r[7],details=json.loads(r[8])) for r in rows[:limit]],
                next_cursor=rows[limit-1][0] if len(rows)>limit else None)
        if operation == "comparison":
            return ComparisonPage(items=[self._comparison(exp) for exp in args["experiment_ids"] if self._experiment_rows("WHERE e.experiment_id=?",(exp,))])
        raise ValueError("Unknown history query")

    def _comparison(self, exp_id):
        con = self.connection
        exp = self._experiment(self._experiment_rows("WHERE e.experiment_id=?", (exp_id,))[0])
        rows = con.execute("""SELECT d.delivery_json FROM guidance_deliveries d JOIN guidance_messages m USING(message_id)
            WHERE m.experiment_id=? ORDER BY m.issued_at,m.message_id""", (exp_id,)).fetchall()
        deliveries = [GuidanceDelivery.model_validate_json(r[0]) for r in rows]
        results = [d.transport_result for d in deliveries if d.transport_result]
        dispositions, previous, changes = {}, {}, 0
        for d in deliveries:
            disp = d.application_receipt.disposition if d.application_receipt else "unconfirmed"
            dispositions[disp] = dispositions.get(disp,0) + 1
            if d.transport_result:
                key = (str(d.scenario_id),d.audience_id,d.source_node,d.destination_node)
                for attempt in d.transport_result.attempts:
                    if key in previous and previous[key] != attempt.route:
                        changes += 1
                    previous[key] = attempt.route
        ready = exp.started_at.isoformat().replace("+00:00", "Z") if exp.started_at else None
        detection = [r[0] for r in con.execute("SELECT detection_ms FROM event_log WHERE experiment_id=? AND detection_ms IS NOT NULL AND ? IS NOT NULL AND occurred_at>=?", (exp_id,ready,ready))]
        return ExperimentComparison(experiment_id=exp_id,recording_complete=exp.recording_complete,
            recorded_deliveries=len(deliveries),ack_received=sum(d.ack_received for d in deliveries),
            ack_rate=sum(d.ack_received for d in deliveries)/len(deliveries) if deliveries else None,
            disposition_counts=dispositions,retries_total=sum(r.retries for r in results) if results else None,
            delivery_latency=stats([r.elapsed_ms for r in results]),route_calculation=stats([r.route_calculation_ms for r in results]),
            delivery_recovery=stats([r.recovery_after_first_failure_ms for r in results]), heartbeat_detection=stats(detection),route_changes=changes)

    async def close(self):
        if self.thread is None:
            self.closing = True
            return
        self.closing = True
        future = Future()
        with self.guard:
            self._status["pending"] += 1
        try:
            await asyncio.to_thread(self.jobs.put, ("close",{}, {},future), True, 10)
            await asyncio.wait_for(asyncio.wrap_future(future), timeout=15)
            await asyncio.to_thread(self.thread.join, 2)
        except Exception as exc:
            self._error("close", {}, exc)
