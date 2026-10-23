"""Bounded real-loopback pilot; raw failures and cleanup evidence are first class."""
import asyncio
import csv
import hashlib
import json
import math
import os
import platform
import random
import statistics
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from exit_link.communication.client import get_status, send_message, send_reliably
from exit_link.communication.protocol import Ack, Message, ProtocolError, ReliableSend
from exit_link.metrics.recording import write_observation
from exit_link.simulation.processes import LocalCluster, read_events
from exit_link.topology.loader import load_communication
from exit_link.experiments.safety import atomic_json

CONDITIONS = ("normal", "single_failure", "sequential_failures", "no_route", "restart")
METHODS = ("fixed", "exit_link")
ROUTE = ["N1", "N2", "N4"]
PAYLOAD = "x" * 256
RELAY_DELAY = 0.2
WARMUP = 0.6
FAULT_GAP = 0.4


def now():
    return datetime.now(timezone.utc).isoformat()


def schedule(repetitions, seed):
    rng = random.Random(seed)
    conditions = list(CONDITIONS)
    rng.shuffle(conditions)
    starts = {condition: rng.randrange(2) for condition in conditions}
    result = []
    for repetition in range(repetitions):
        order = conditions.copy()
        rng.shuffle(order)
        for condition in order:
            methods = list(METHODS)
            if (starts[condition] + repetition) % 2:
                methods.reverse()
            for method in methods:
                result.append(dict(condition=condition, repetition=repetition, method=method))
    return result


def distribution(values, unit="ms"):
    values = sorted(value for value in values if value is not None)
    if not values:
        return None
    # Nearest-rank percentiles; small pilot tails are not stable estimators.
    return dict(n=len(values), mean=statistics.mean(values), median=statistics.median(values),
                p95=values[math.ceil(.95*len(values))-1], p99=values[math.ceil(.99*len(values))-1],
                minimum=values[0], maximum=values[-1], unit=unit)


class BenchmarkCluster(LocalCluster):
    def __init__(self, directory, method):
        self.node_module = ("exit_link.experiments.fixed_node" if method == "fixed"
                            else "exit_link.experiments.node")
        super().__init__(directory, relay_delay=RELAY_DELAY)


def all_events(cluster):
    return [event for entry in cluster.history for event in read_events(cluster.directory / entry["log"])]


def arrival_observation(events, message_id, cutoff=None):
    arrivals=[e for e in events if e.get('node')=='N4' and e.get('event')=='received' and e.get('message_id')==message_id]
    on_time=[e for e in arrivals if cutoff is None or e['benchmark_perf_ns']<=cutoff]
    return dict(delivered_observed=bool(on_time),destination_received_count=len(arrivals),
                received_after_window_count=len(arrivals)-len(on_time))


async def trial(directory, specification, *, aligned=False):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=False)
    record = dict(experiment_id=str(uuid4()), purpose="contest_main_study" if aligned else "contest_comparison_pilot", transport="real_tcp_loopback",
                  topology_origin="simulation", **specification, started_at=now(), messages=[], faults=[],
                  status="starting", cleanup={}, comparable=False)
    record['protocol_version']='aligned_v2' if aligned else 'pilot_v1'
    cluster, task, window_start, window_end = None, None, None, None
    scheduled_tasks=[]

    def persist():
        # Each cell is recoverable independently; complete messages are also append-only.
        atomic_json(directory / "trial.json", record)

    def fault(node):
        issued = time.perf_counter_ns()
        actual = cluster.kill(node)
        entry = dict(fault_id=str(uuid4()), node=node, issued_perf_ns=issued,
                     confirmed_perf_ns=time.perf_counter_ns(), raw=actual)
        record["faults"].append(entry)
        persist()
        return entry

    async def send(phase, target_ns=None):
        if target_ns is not None:
            await asyncio.sleep(max(0,(target_ns-time.perf_counter_ns())/1e9))
        fields = dict(source="N1", destination="N4", payload=PAYLOAD, ttl=16)
        request = (Message(**fields, route=ROUTE) if specification["method"] == "fixed"
                   else ReliableSend(**fields, initial_route=ROUTE, max_retries=3))
        row = dict(experiment_id=record["experiment_id"], condition=record["condition"], method=record["method"],
                   repetition=record["repetition"], phase=phase, message_id=str(request.message_id),
                   started_at=now(), started_perf_ns=time.perf_counter_ns(), ack_received=False,
                   raw_response=None, error=None, route=None, retries=0 if specification["method"] == "fixed" else None,
                   route_calculation_ms=None, engine_elapsed_ms=None)
        if target_ns is not None:
            row.update(scheduled_perf_ns=target_ns,scheduling_lateness_ms=(row['started_perf_ns']-target_ns)/1e6)
        with (directory/'message-intents.jsonl').open('a',encoding='utf-8') as stream:
            stream.write(json.dumps(dict(message_id=row['message_id'],phase=phase,started_at=row['started_at'],
                started_perf_ns=row['started_perf_ns'],state='intent'))+'\n')
            stream.flush()
            os.fsync(stream.fileno())
        if target_ns is not None:
            row['dispatch_perf_ns']=time.perf_counter_ns()
            row['scheduling_lateness_ms']=(row['dispatch_perf_ns']-target_ns)/1e6
        try:
            if specification["method"] == "fixed":
                operation = send_message(cluster.topology, request, timeout=6 if aligned else 8)
                response = await response_with_limit(operation) if aligned else await operation
                ack = response if isinstance(response, Ack) else None
            else:
                operation = send_reliably(cluster.topology, request, timeout=6 if aligned else 12)
                response = await response_with_limit(operation) if aligned else await operation
                ack = response.ack
                row.update(retries=response.retries, route_calculation_ms=response.route_calculation_ms,
                           engine_elapsed_ms=response.elapsed_ms)
            row["raw_response"] = response.model_dump(mode="json")
            row["ack_received"] = ack is not None
            row["route"] = ack.route if ack else None
            row["error"] = None if ack else (response.code if hasattr(response, "code") else response.error.code)
        except (OSError, ValueError, ProtocolError, TimeoutError) as exc:
            row["error"] = type(exc).__name__ + ": " + str(exc)
        except asyncio.CancelledError:
            row['error']='controller_cancelled'
            raise
        finally:
            row["completed_perf_ns"] = time.perf_counter_ns()
            row["client_elapsed_ms"] = (row["completed_perf_ns"]-row["started_perf_ns"])/1e6
            row["completed_at"] = now()
            record["messages"].append(row)
            with (directory / "messages.jsonl").open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(row, allow_nan=False) + "\n")
                stream.flush()
                os.fsync(stream.fileno())
            persist()
        return row

    persist()
    try:
        cluster = BenchmarkCluster(directory / "p", specification["method"])
        record["topology"] = cluster.topology.model_dump(mode="json")
        cluster.start_all()
        if specification["method"] == "exit_link":
            await cluster.wait_ready()
        else:
            statuses = [await get_status(cluster.topology, node.id) for node in cluster.topology.nodes]
            if any(status.enabled for status in statuses):
                raise AssertionError("Fixed mode unexpectedly enabled heartbeat")
        await asyncio.sleep(WARMUP+specification.get('warmup_extra_seconds',0))
        window_start = time.perf_counter_ns()
        record["status"] = "running"
        condition = specification["condition"]
        if aligned:
            timing=specification['fault_timing']
            anchor=window_start
            if condition=='no_route':
                fault('N2'); fault('N3')
                anchor=record['faults'][-1]['confirmed_perf_ns']
            elif condition!='normal' and timing=='before_send':
                fault('N2')
                anchor=record['faults'][-1]['confirmed_perf_ns']
            if condition!='normal' and condition!='no_route' and timing=='inflight':
                task=asyncio.create_task(send('inflight_fault',window_start))
                await cluster.wait_event('N2','relay_wait',await _pending_id(record,directory))
                fault('N2')
                anchor=record['faults'][-1]['confirmed_perf_ns']
                offsets=[.8,2.5]
            else:
                offsets=[.05,.8,2.5]
            record['schedule_anchor_perf_ns']=anchor
            record['scheduled_actions']=[]

            async def secondary():
                target=anchor+1_000_000_000
                await asyncio.sleep(max(0,(target-time.perf_counter_ns())/1e9))
                action=dict(scheduled_perf_ns=target,started_perf_ns=time.perf_counter_ns())
                action['lateness_ms']=(action['started_perf_ns']-target)/1e6
                record['scheduled_actions'].append(action)
                if condition=='sequential_failures':
                    fault('N3')
                else:
                    restart=dict(node='N2',started_perf_ns=time.perf_counter_ns())
                    record['restart']=restart
                    await asyncio.to_thread(cluster.start,'N2')
                    restart['listening_perf_ns']=time.perf_counter_ns()
                persist()

            if condition in ('sequential_failures','restart'):
                scheduled_tasks.append(asyncio.create_task(secondary()))
            for offset in offsets:
                phase=('normal' if condition=='normal' else 'isolated' if condition=='no_route' or
                       condition=='sequential_failures' and offset>=1 else 'scheduled_post_restart' if condition=='restart' and offset>=1
                       else 'after_fault')
                scheduled_tasks.append(asyncio.create_task(send(phase,anchor+int(offset*1e9))))
            # All future inputs are scheduled before awaiting any delivery outcome.
            await asyncio.gather(*scheduled_tasks,*([task] if task is not None else []))
            record['scheduled_observation_end_perf_ns']=anchor+9_000_000_000
            await asyncio.sleep(max(0,(record['scheduled_observation_end_perf_ns']-time.perf_counter_ns())/1e9))
            record['observation_end_lateness_ms']=(time.perf_counter_ns()-record['scheduled_observation_end_perf_ns'])/1e6
            record['timing_valid']=all(r['scheduling_lateness_ms']<=100 for r in record['messages']) and all(
                a['lateness_ms']<=100 for a in record['scheduled_actions']) and record['observation_end_lateness_ms']<=100
            if condition=='restart':
                late=next(r for r in record['messages'] if r['phase']=='scheduled_post_restart')
                record['restart']['listening_before_final_send']=record['restart']['listening_perf_ns']<=late['started_perf_ns']
            if task is not None:
                inflight=next(r for r in record['messages'] if r['phase']=='inflight_fault')
                arrivals=cluster.records('N4','received',inflight['message_id'])
                if arrivals and arrivals[0]['benchmark_perf_ns']<record['faults'][0]['issued_perf_ns']:
                    record['timing_valid']=False
        elif condition == "no_route":
            fault("N2")
            fault("N3")
            await asyncio.sleep(FAULT_GAP)
            for _ in range(3):
                await send("isolated")
        elif condition == "normal":
            for _ in range(3):
                await send("normal")
        else:
            task = asyncio.create_task(send("inflight_fault"))
            # Deterministic injection at the same processing phase in both methods.
            await cluster.wait_event("N2", "relay_wait", next_id := await _pending_id(record, directory))
            first_fault = fault("N2")
            await task
            received = cluster.records("N4", "received", next_id)
            if received and received[0]["benchmark_perf_ns"] < first_fault["issued_perf_ns"]:
                raise AssertionError("Fault arrived after delivery; cell is not comparable")
            await asyncio.sleep(FAULT_GAP)
            if condition == "sequential_failures":
                fault("N3")
                await asyncio.sleep(FAULT_GAP)
            elif condition == "restart":
                restart = dict(node="N2", started_perf_ns=time.perf_counter_ns())
                cluster.start("N2")
                restart["listening_perf_ns"] = time.perf_counter_ns()
                record["restart"] = restart
                await asyncio.sleep(WARMUP)
            phase = dict(single_failure="after_fault", sequential_failures="isolated", restart="after_restart")[condition]
            for _ in range(2):
                await send(phase)
        window_end = time.perf_counter_ns()
        record.update(status="completed", comparable=True)
        if aligned and not record.get('timing_valid'):
            record.update(comparable=False,error=dict(type='schedule_deviation',detail='Predeclared 100ms tolerance exceeded or fault was late'))
    except asyncio.CancelledError:
        record.update(status='interrupted',comparable=False,error=dict(type='controller_cancelled',detail='Cleanup attempted; inspect artifacts'))
        raise
    except Exception as exc:
        record.update(status="failed", error=dict(type=type(exc).__name__, detail=str(exc)))
    finally:
        for pending in scheduled_tasks:
            if not pending.done():
                pending.cancel()
        await asyncio.gather(*scheduled_tasks,return_exceptions=True)
        if task is not None and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        if window_start is not None and window_end is None:
            window_end = time.perf_counter_ns()
        if cluster is not None:
            try:
                await cluster.close()
                record["cleanup"]["normal_stop_confirmed"] = True
            except Exception as exc:
                record["cleanup"]["error"] = str(exc)
                record["comparable"] = False
            record["cleanup"]["all_owned_processes_exited"] = all(p.poll() is not None for p in cluster.processes.values())
            # Bind every former listening endpoint, retaining errors rather than hiding them.
            record["cleanup"]["ports"] = check_ports(cluster.topology)
            if not record["cleanup"]["all_owned_processes_exited"] or not all(p["available"] for p in record["cleanup"]["ports"]):
                record["comparable"] = False
            events = all_events(cluster)
            record["processes"] = cluster.history
            for row in record["messages"]:
                row.update(arrival_observation(events,row['message_id'],record.get('scheduled_observation_end_perf_ns') if aligned else None))
                if row['destination_received_count'] > 1:
                    record.update(comparable=False, error=dict(type="duplicate_delivery", detail=row["message_id"]))
            for entry in record["faults"]:
                eligible = [row for row in record["messages"] if row["ack_received"] and row["completed_perf_ns"] >= entry["confirmed_perf_ns"]]
                entry["first_ack_after_fault_ms"] = min((r["completed_perf_ns"]-entry["confirmed_perf_ns"])/1e6 for r in eligible) if eligible else None
                entry["no_ack_observation_window_ms"] = ((window_end-entry["confirmed_perf_ns"])/1e6 if not eligible and window_end else None)
            record["detection_observations"] = [dict(observer=e["node"], target=e["neighbor"],
                detection_ms=e.get("detection_since_first_failure_ms"), occurred_perf_ns=e["benchmark_perf_ns"])
                for e in events if e.get("event") == "neighbor_down" and window_start is not None
                and window_start <= e["benchmark_perf_ns"] <= window_end
                and any(f["node"] == e.get("neighbor") and f["issued_perf_ns"] <= e["benchmark_perf_ns"] for f in record["faults"])]
            metric_start=record.get('schedule_anchor_perf_ns',window_start) if aligned else window_start
            metric_end=record.get('scheduled_observation_end_perf_ns',window_end) if aligned else window_end
            frames = [e for e in events if e.get("event") == "benchmark_control_frame" and metric_start is not None
                      and metric_start <= e["benchmark_perf_ns"] <= metric_end]
            probes = [e for e in events if e.get("event") == "benchmark_probe_attempt" and window_start is not None
                      and metric_start <= e["benchmark_perf_ns"] <= metric_end]
            seconds = (metric_end-metric_start)/1e9 if metric_start is not None else None
            record["overhead"] = dict(window_seconds=seconds, heartbeat_frames=len(frames),
                framed_bytes=sum(e["bytes"] for e in frames), gossip_delta_bytes=sum(e["gossip_delta_bytes"] for e in frames),
                probe_attempts=len(probes), framed_bytes_per_second=sum(e["bytes"] for e in frames)/seconds if seconds else None)
            if record.get("restart"):
                restart = record["restart"]
                acknowledgements = [r["completed_perf_ns"] for r in record["messages"]
                                    if r["phase"] in ("after_restart","scheduled_post_restart") and r["ack_received"]]
                restart["first_post_restart_ack_ms"] = ((min(acknowledgements)-restart["started_perf_ns"])/1e6
                                                         if acknowledgements else None)
        record.update(ended_at=now(), window_start_perf_ns=window_start, window_end_perf_ns=window_end)
        persist()
    return record


async def response_with_limit(operation):
    """One overall response deadline for both benchmark clients; cancel cleans I/O.

    Socket connect/write/read also have their own timeouts. Cancellation cleanup
    can take extra time, but a result after the overall deadline is not accepted.
    """
    return await asyncio.wait_for(operation,timeout=6)


async def _pending_id(record, directory):
    # Observe the real source log, not an invented message completion. The same ID
    # then gates the actual N2 relay_wait event before termination.
    deadline = time.perf_counter() + 10
    while time.perf_counter() < deadline:
        for path in (directory / "p").glob("N1-*.jsonl"):
            for event in read_events(path):
                if event.get("event") == "send_attempt":
                    return event["message_id"]
        await asyncio.sleep(.005)
    raise TimeoutError("Source did not start the in-flight pilot message")


def check_ports(topology):
    import socket
    result = []
    for node in topology.nodes:
        try:
            with socket.socket() as sock:
                if sys.platform == "win32":
                    sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
                sock.bind(("127.0.0.1", node.port))
            result.append(dict(node=node.id, port=node.port, available=True))
        except OSError as exc:
            result.append(dict(node=node.id, port=node.port, available=False, error=str(exc)))
    return result


def summarize(trials):
    groups = defaultdict(list)
    for cell in trials:
        for row in cell["messages"]:
            groups[(cell["condition"], cell["method"], row["phase"])].append(row)
    result = []
    for (condition, method, phase), rows in sorted(groups.items()):
        ack = [row for row in rows if row["ack_received"]]
        result.append(dict(condition=condition, method=method, phase=phase, attempted=len(rows),
            delivered=sum(row["delivered_observed"] for row in rows), ack_received=len(ack),
            delivery_rate=sum(row["delivered_observed"] for row in rows)/len(rows), ack_rate=len(ack)/len(rows),
            ack_success_latency=distribution([row["client_elapsed_ms"] for row in ack]),
            all_response_latency=distribution([row["client_elapsed_ms"] for row in rows]),
            route_calculation=distribution([row["route_calculation_ms"] for row in rows]),
            retries_total=sum(row["retries"] for row in rows if row["retries"] is not None),
            retries_observed_n=sum(row["retries"] is not None for row in rows),
            errors={error:sum(row["error"] == error for row in rows) for error in sorted(set(row["error"] for row in rows if row["error"]))}))
    return result


def export(output, manifest, trials):
    rows = []
    for cell in trials:
        for row in cell["messages"]:
            rows.append({key:value for key,value in row.items() if key != "raw_response"} | {"comparable":cell["comparable"]})
    if rows:
        with (output / "messages.csv").open("w", encoding="utf-8-sig", newline="") as stream:
            columns = sorted({key for row in rows for key in row})
            writer = csv.DictWriter(stream, fieldnames=columns)
            writer.writeheader()
            for row in rows:
                writer.writerow({key:json.dumps(value) if isinstance(value, (list,dict)) else value for key,value in row.items()})
    metrics = []
    for condition in CONDITIONS:
        for method in METHODS:
            cells = [c for c in trials if c["condition"] == condition and c["method"] == method]
            if not cells:
                continue
            metrics.append(dict(condition=condition,method=method,trials=len(cells),
                comparable_trials=sum(c["comparable"] for c in cells),
                attempted_messages=sum(len(c["messages"]) for c in cells),
                planned_messages=3*len(cells),
                detection=distribution([o["detection_ms"] for c in cells for o in c.get("detection_observations",[])]),
                recovery_by_fault_node={node:distribution([f["first_ack_after_fault_ms"] for c in cells
                    for f in c["faults"] if f["node"]==node]) for node in sorted({f["node"] for c in cells for f in c["faults"]})},
                no_ack_episodes=sum(f["first_ack_after_fault_ms"] is None for c in cells for f in c["faults"]),
                restart_to_ack=distribution([c.get("restart",{}).get("first_post_restart_ack_ms") for c in cells]),
                heartbeat_framed_bytes_per_second=distribution([c.get("overhead",{}).get("framed_bytes_per_second") for c in cells],"bytes/s"),
                heartbeat_frames_total=sum(c.get("overhead",{}).get("heartbeat_frames",0) for c in cells),
                heartbeat_framed_bytes_total=sum(c.get("overhead",{}).get("framed_bytes",0) for c in cells),
                gossip_delta_bytes_total=sum(c.get("overhead",{}).get("gossip_delta_bytes",0) for c in cells)))
    summary = dict(purpose="contest_comparison_pilot", run_id=manifest["run_id"],
        trials_planned=len(manifest["schedule"]), trials_recorded=len(trials),
        comparable_trials=sum(cell["comparable"] for cell in trials),
        failed_or_incomparable=[dict(experiment_id=c["experiment_id"],condition=c["condition"],method=c["method"],error=c.get("error"),cleanup=c["cleanup"])
                                for c in trials if not c["comparable"]],
        groups=summarize(trials), condition_metrics=metrics,
        trial_metrics=[dict(experiment_id=c["experiment_id"],condition=c["condition"],method=c["method"],
            repetition=c["repetition"],comparable=c["comparable"],overhead=c.get("overhead"), faults=c["faults"],
            detection_observations=c.get("detection_observations",[])) for c in trials])
    summary["status"] = "completed" if len(trials)==len(manifest["schedule"]) and not summary["failed_or_incomparable"] else "incomplete"
    atomic_json(output / "summary.json", summary)
    return summary


async def run(output, repetitions=2, seed=20261021):
    output = Path(output)
    output.mkdir(parents=True,exist_ok=False)
    root = Path(__file__).resolve().parents[3]
    files = sorted((root / "src/exit_link").rglob("*.py"))
    manifest = dict(schema_version="1.0",run_id=str(uuid4()),purpose="contest_comparison_pilot",started_at=now(),
        python=sys.version,platform=platform.platform(),perf_counter=vars(time.get_clock_info("perf_counter")),
        source_sha256={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in files},
        topology=load_communication().model_dump(mode="json"),repetitions=repetitions,seed=seed,schedule=schedule(repetitions,seed),
        settings=dict(messages_per_trial=3,payload_bytes=len(PAYLOAD.encode()),relay_delay_seconds=RELAY_DELAY,
            warmup_seconds=WARMUP,fault_gap_seconds=FAULT_GAP,ttl=16,fixed_retries=0,exit_link_max_retries=3,
            probe_interval_seconds=.1,probe_timeout_seconds=.15,failure_threshold=2,recovery_threshold=2,state_ttl_seconds=3))
    write_observation(output / "manifest.json",manifest)
    trials = []
    try:
        for index,specification in enumerate(manifest["schedule"]):
            print(f"Pilot {index+1}/{len(manifest['schedule'])}: {specification}",flush=True)
            cell = await trial(output / f"t{index:02}",specification)
            trials.append(cell)
            export(output,manifest,trials)
            if not cell["comparable"]:
                print("Cell failed or incomparable; retaining evidence and stopping pilot.",flush=True)
                break
    finally:
        manifest["ended_at"] = now()
        write_observation(output / "manifest.json",manifest)
        summary = export(output,manifest,trials)
    return summary
