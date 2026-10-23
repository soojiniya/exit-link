"""Aligned-v3: precommitted intents, independent timers and off-loop disk/control I/O.

Only experiment launchers use this module. No production TCP/API behavior changes.
"""
import asyncio
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4

from exit_link.communication import protocol
from exit_link.communication.client import get_status
from exit_link.experiments.comparison import (
    BenchmarkCluster, PAYLOAD, ROUTE, WARMUP, all_events, arrival_observation, check_ports, now,
)
from exit_link.experiments.journal import DurableJournal, inspect_journal, settle
from exit_link.experiments.safety import atomic_json

PROTOCOL = "aligned_v3"
POLICY = dict(intent_policy="all_messages_fsynced_before_window", recording_policy="bounded_single_writer",
              anchor_policy="confirmed_fault_before_any_disk_wait", observation_policy="independent_timer",
              tolerance_policy="absolute_100ms", response_deadline_seconds=6)


async def at(target_ns):
    # Proactor timers can wake slightly early. Keep the declared absolute target.
    while (remaining := target_ns - time.perf_counter_ns()) > 0:
        await asyncio.sleep(remaining / 1e9)


def phase_for(condition, offset):
    if condition == "normal":
        return "normal"
    if condition == "no_route" or condition == "sequential_failures" and offset >= 1:
        return "isolated"
    if condition == "restart" and offset >= 1:
        return "scheduled_post_restart"
    return "after_fault"


def timing_valid(record):
    values = [m.get("scheduling_lateness_ms") for m in record["messages"]]
    values += [a.get("lateness_ms") for a in record["scheduled_actions"]]
    values += [f.get("lateness_ms") for f in record["faults"]]
    if "restart" in record:
        values.append(record["restart"].get("lateness_ms"))
    values.append(record.get("observation_end_lateness_ms"))
    return all(v is not None and abs(v) <= 100 for v in values)


async def exchange_measured(config, request, row):
    """Same framing/deadlines as production, with experiment-only start telemetry."""
    if config.host != "127.0.0.1":
        raise ValueError("Only IPv4 loopback is supported")
    async def connect():
        row["tcp_request_start_perf_ns"] = time.perf_counter_ns()
        row["dispatch_perf_ns"] = row["tcp_request_start_perf_ns"]
        row["scheduling_lateness_ms"] = (row["dispatch_perf_ns"] - row["scheduled_perf_ns"]) / 1e6
        return await asyncio.open_connection(config.host, config.port)

    try:
        reader, writer = await asyncio.wait_for(connect(), 6)
    except OSError as exc:
        raise protocol.ConnectionFailed(config.host, config.port, exc) from exc
    try:
        await protocol.write_frame(writer, request, 6)
        row["tcp_frame_sent_perf_ns"] = time.perf_counter_ns()
        return protocol.RESPONSE.validate_python(await protocol.read_frame(reader, 6))
    finally:
        await protocol.close_writer(writer)


def validate_response(request, response):
    allowed = (protocol.Ack, protocol.ErrorResponse) if isinstance(request, protocol.Message) else (protocol.DeliveryResult,)
    if not isinstance(response, allowed):
        raise protocol.ProtocolError("Unexpected delivery response type")
    if response.message_id != request.message_id:
        raise protocol.ProtocolError("Response message ID mismatch")
    if isinstance(request, protocol.Message):
        ack = response if isinstance(response, protocol.Ack) else None
        if ack and (ack.source != request.destination or ack.destination != request.source or ack.route != request.route):
            raise protocol.ProtocolError("ACK route/endpoints mismatch")
        return ack
    if not isinstance(response, protocol.DeliveryResult) or response.source != request.source or response.destination != request.destination:
        raise protocol.ProtocolError("Unexpected reliable response")
    if response.success:
        ack = response.ack
        if ack is None or response.error is not None or ack.message_id != request.message_id or (
            ack.source != request.destination or ack.destination != request.source or not response.attempts
            or ack.route != response.attempts[-1].route
        ):
            raise protocol.ProtocolError("Reliable ACK correlation mismatch")
        return ack
    if response.ack is not None or response.error is None or response.error.message_id != request.message_id:
        raise protocol.ProtocolError("Invalid failed delivery response")
    return None


async def trial(directory, specification):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=False)
    record = dict(**specification, protocol_version=PROTOCOL, experiment_id=str(uuid4()),
                  purpose="contest_main_study", transport="real_tcp_loopback", topology_origin="simulation",
                  started_at=now(), status="starting", comparable=False, messages=[], faults=[],
                  scheduled_actions=[], cleanup={}, recording_policy=POLICY)
    journal = DurableJournal(directory)
    controls = ThreadPoolExecutor(max_workers=1, thread_name_prefix="exit-link-control")
    loop = asyncio.get_running_loop()
    tasks = []
    receipts = []
    result_receipts = []
    control_futures = set()
    cluster = None
    interrupted = False
    condition, method = specification["condition"], specification["method"]
    inflight = specification["fault_timing"] == "inflight"
    anchor_future, window_future = loop.create_future(), loop.create_future()

    def emit(kind, **fields):
        future = journal.submit(dict(event_id=str(uuid4()), kind=kind, occurred_perf_ns=time.perf_counter_ns(), **fields))
        receipts.append((kind, future))
        return future

    async def control(call, *args):
        # Shield the owned action. Cancellation must not race cleanup against a
        # still-running Popen/kill in a worker thread.
        future = loop.run_in_executor(controls, call, *args)
        control_futures.add(future)
        try:
            result, cancelled = await settle(future)
            if cancelled:
                raise asyncio.CancelledError
            return result
        finally:
            if future.done():
                control_futures.discard(future)

    async def fault(node, target, basis):
        journal.check()
        def kill():
            issued = time.perf_counter_ns()
            raw = cluster.kill(node)
            return dict(node=node, fault_id=str(uuid4()), scheduled_perf_ns=target,
                        issued_perf_ns=issued, confirmed_perf_ns=time.perf_counter_ns(), raw=raw,
                        schedule_basis=basis, lateness_ms=(issued - target) / 1e6)
        entry = await control(kill)
        record["faults"].append(entry)
        emit("fault", **entry)
        return entry

    async def send(request, offset, position):
        anchor = await (window_future if inflight and position == 0 else anchor_future)
        target = anchor + int(offset * 1e9)
        await at(target)
        journal.check()
        started = time.perf_counter_ns()
        row = dict(experiment_id=record["experiment_id"], message_id=str(request.message_id),
                   condition=condition, method=method, repetition=specification["repetition"],
                   phase="inflight_fault" if inflight and position == 0 else phase_for(condition, offset),
                   position=position, scheduled_perf_ns=target, started_perf_ns=started,
                   started_at=now(),
                   task_started_perf_ns=started, task_lateness_ms=(started-target)/1e6,
                   intent_recording_completed_perf_ns=record["intent_recording_completed_perf_ns"],
                   raw_response=None, ack_received=False, error=None, route=None,
                   retries=0 if method == "fixed" else None, route_calculation_ms=None, engine_elapsed_ms=None,
                   tcp_request_start_perf_ns=None, scheduling_lateness_ms=None)
        emit("dispatch_intent", message_id=row["message_id"], scheduled_perf_ns=target, task_started_perf_ns=started)
        try:
            config = next(n for n in cluster.topology.nodes if n.id == request.source)
            response = await asyncio.wait_for(exchange_measured(config, request, row), 6)
            ack = validate_response(request, response)
            row.update(raw_response=response.model_dump(mode="json"), ack_received=ack is not None,
                       route=ack.route if ack else None,
                       error=None if ack else response.code if isinstance(response, protocol.ErrorResponse) else response.error.code)
            if isinstance(response, protocol.DeliveryResult):
                row.update(retries=response.retries, route_calculation_ms=response.route_calculation_ms,
                           engine_elapsed_ms=response.elapsed_ms)
        except asyncio.CancelledError:
            row["error"] = "controller_cancelled"
            raise
        except (OSError, ValueError, protocol.ProtocolError, TimeoutError) as exc:
            row["error"] = type(exc).__name__ + ": " + str(exc)
        finally:
            row["completed_perf_ns"] = time.perf_counter_ns()
            row["completed_at"] = now()
            row["client_elapsed_ms"] = (row["completed_perf_ns"]-started)/1e6
            record["messages"].append(row)
            result_receipts.append((row, emit("message_result", message=dict(row))))

    async def secondary():
        anchor = await anchor_future
        target = anchor + 1_000_000_000
        await at(target)
        started = time.perf_counter_ns()
        action = dict(scheduled_perf_ns=target, started_perf_ns=started, lateness_ms=(started-target)/1e6)
        record["scheduled_actions"].append(action)
        if condition == "sequential_failures":
            await fault("N3", target, "anchor_plus_1s")
        else:
            journal.check()
            def restart():
                requested = time.perf_counter_ns()
                cluster.start("N2")
                return dict(node="N2", scheduled_perf_ns=target, requested_perf_ns=requested,
                            worker_completed_perf_ns=time.perf_counter_ns())
            entry = await control(restart)
            entry["observed_ready_perf_ns"] = time.perf_counter_ns()
            entry["started_perf_ns"] = entry["requested_perf_ns"]
            entry["lateness_ms"] = (entry["requested_perf_ns"]-target)/1e6
            record["restart"] = entry
            emit("restart_ready_observed", **entry)

    async def observation_end():
        anchor = await anchor_future
        target = anchor + 9_000_000_000
        record["scheduled_observation_end_perf_ns"] = target
        await at(target)
        actual = time.perf_counter_ns()
        record.update(observation_ended_perf_ns=actual, observation_end_lateness_ms=(actual-target)/1e6)
        emit("observation_end", scheduled_perf_ns=target, actual_perf_ns=actual)

    try:
        await journal.snapshot(directory / "trial.json", record)
        cluster = await control(BenchmarkCluster, directory / "p", method)
        record["topology"] = cluster.topology.model_dump(mode="json")
        await control(cluster.start_all)
        if method == "exit_link":
            await cluster.wait_ready()
        else:
            for node in cluster.topology.nodes:
                if (await get_status(cluster.topology, node.id)).enabled:
                    raise AssertionError("Fixed mode unexpectedly enabled heartbeat")
        # All IDs and immutable requests are durable BEFORE any timing anchor.
        requests = []
        for _ in range(3):
            fields = dict(source="N1", destination="N4", payload=PAYLOAD, ttl=16)
            requests.append(protocol.Message(**fields, route=ROUTE) if method == "fixed"
                            else protocol.ReliableSend(**fields, initial_route=ROUTE, max_retries=3))
        receipt = await journal.commit(dict(kind="prepared_intents", experiment_id=record["experiment_id"],
                                           requests=[r.model_dump(mode="json") for r in requests],
                                           specification=specification, state="uncertain_until_cell_checkpoint"))
        record["intent_recording_completed_perf_ns"] = receipt["recording_completed_perf_ns"]
        offsets = [0, .8, 2.5] if inflight else [.05, .8, 2.5]
        # Arm every future input BEFORE the first fault; no disk await follows F.
        tasks = [asyncio.create_task(send(req, offset, pos)) for pos, (req, offset) in enumerate(zip(requests, offsets))]
        if condition in ("sequential_failures", "restart"):
            tasks.append(asyncio.create_task(secondary()))
        tasks.append(asyncio.create_task(observation_end()))
        await asyncio.sleep(WARMUP + specification.get("warmup_extra_seconds", 0))
        window = time.perf_counter_ns()
        record.update(status="running", window_start_perf_ns=window)
        window_future.set_result(window)
        if inflight:
            def wait_relay():
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    events = cluster.records("N2", "relay_wait", str(requests[0].message_id))
                    if events:
                        return events[-1]["benchmark_perf_ns"]
                    time.sleep(.005)
                raise TimeoutError("Missing N2 relay_wait")
            trigger = await control(wait_relay)
            entry = await fault("N2", trigger, "N2_relay_wait_event")
            anchor = entry["confirmed_perf_ns"]
        elif condition != "normal":
            entry = await fault("N2", window, "window_start")
            if condition == "no_route":
                entry = await fault("N3", entry["confirmed_perf_ns"], "N2_confirmed")
            anchor = entry["confirmed_perf_ns"]
        else:
            anchor = window
        record["schedule_anchor_perf_ns"] = anchor
        anchor_future.set_result(anchor)
        await asyncio.gather(*tasks)
        journal.check()
        record.update(status="completed", timing_valid=timing_valid(record))
        record["comparable"] = record["timing_valid"]
        if not record["comparable"]:
            record["error"] = dict(type="schedule_deviation", detail="Predeclared absolute 100ms tolerance exceeded")
    except (asyncio.CancelledError, KeyboardInterrupt) as exc:
        interrupted = True
        record.update(status="interrupted", comparable=False, error=dict(type=type(exc).__name__, detail="controller_cancelled"))
    except Exception as exc:
        record.update(status="failed", comparable=False, error=dict(type=type(exc).__name__, detail=str(exc)))
    finally:
        async def finalize():
            async def cleanup_and_observe():
                for task in tasks:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                # start_all may have been interrupted at its await boundary. Join
                # every submitted control before snapshotting ownership or closing
                # any node: otherwise later nodes can be spawned after cleanup.
                if control_futures:
                    await asyncio.gather(*list(control_futures), return_exceptions=True)
                # A cancelled asyncio wrapper is not proof that its executor
                # callable stopped. A real queue barrier covers that case too.
                def control_barrier():
                    controls.submit(lambda: None).result()
                await asyncio.to_thread(control_barrier)
                if cluster is not None:
                    try:
                        await cluster.close()
                        record["cleanup"]["normal_stop_confirmed"] = True
                    except Exception as exc:
                        record["cleanup"]["error"] = str(exc)
                        record["comparable"] = False
                        raise
                    record["cleanup"]["all_owned_processes_exited"] = all(p.poll() is not None for p in cluster.processes.values())
                    record["cleanup"]["ports"] = await control(check_ports, cluster.topology)
                    if not record["cleanup"].get("normal_stop_confirmed") or not record["cleanup"]["all_owned_processes_exited"] or not all(p["available"] for p in record["cleanup"]["ports"]):
                        record["comparable"] = False
                    events = await control(all_events, cluster)
                    record["processes"] = cluster.history
                    cutoff = record.get("scheduled_observation_end_perf_ns")
                    for row in record["messages"]:
                        row.update(arrival_observation(events, row["message_id"], cutoff))
                        if cutoff and row["completed_perf_ns"] > cutoff and row["ack_received"]:
                            row.update(ack_received=False, ack_received_after_window=True)
                        if row["destination_received_count"] > 1:
                            record.update(comparable=False, error=dict(type="duplicate_delivery"))
                    for entry in record["faults"]:
                        eligible = [m for m in record["messages"] if m["ack_received"] and m["completed_perf_ns"] >= entry["confirmed_perf_ns"]]
                        entry["first_ack_after_fault_ms"] = min((m["completed_perf_ns"]-entry["confirmed_perf_ns"])/1e6 for m in eligible) if eligible else None
                        entry["no_ack_observation_window_ms"] = (cutoff-entry["confirmed_perf_ns"])/1e6 if not eligible and cutoff else None
                    if "restart" in record:
                        entry = record["restart"]
                        ready = [e["benchmark_perf_ns"] for e in cluster.records("N2", "node_started")]
                        entry["node_ready_perf_ns"] = min(ready) if ready else None
                        entry["listening_perf_ns"] = entry["node_ready_perf_ns"]
                        late = next((m for m in record["messages"] if m["position"] == 2), None)
                        entry["listening_before_final_send"] = bool(ready and late and late["tcp_request_start_perf_ns"] and min(ready) <= late["tcp_request_start_perf_ns"])
                        acknowledgements = [m["completed_perf_ns"] for m in record["messages"] if m["phase"] == "scheduled_post_restart" and m["ack_received"]]
                        entry["first_post_restart_ack_ms"] = (min(acknowledgements)-entry["requested_perf_ns"])/1e6 if acknowledgements else None
                    begin = record.get("schedule_anchor_perf_ns")
                    frames = [e for e in events if e.get("event") == "benchmark_control_frame" and begin is not None and cutoff and begin <= e["benchmark_perf_ns"] <= cutoff]
                    probes = [e for e in events if e.get("event") == "benchmark_probe_attempt" and begin is not None and cutoff and begin <= e["benchmark_perf_ns"] <= cutoff]
                    record["overhead"] = dict(window_seconds=9, heartbeat_frames=len(frames), framed_bytes=sum(e["bytes"] for e in frames),
                                              gossip_delta_bytes=sum(e["gossip_delta_bytes"] for e in frames), probe_attempts=len(probes),
                                              framed_bytes_per_second=sum(e["bytes"] for e in frames)/9)
                    record["detection_observations"] = [dict(observer=e["node"], target=e["neighbor"], detection_ms=e.get("detection_since_first_failure_ms"), occurred_perf_ns=e["benchmark_perf_ns"])
                        for e in events if e.get("event") == "neighbor_down" and begin is not None and cutoff and begin <= e["benchmark_perf_ns"] <= cutoff
                        and any(f["node"] == e.get("neighbor") and f["issued_perf_ns"] <= e["benchmark_perf_ns"] for f in record["faults"])]
                    if inflight and record["faults"]:
                        arrivals = [e for e in events if e.get("node") == "N4" and e.get("event") == "received" and e.get("message_id") == str(requests[0].message_id)]
                        if any(e["benchmark_perf_ns"] < record["faults"][0]["issued_perf_ns"] for e in arrivals):
                            record.update(comparable=False, timing_valid=False, error=dict(type="schedule_deviation", detail="Fault occurred after delivery"))
            try:
                await cleanup_and_observe()
            except BaseException as exc:
                record.update(comparable=False, status="interrupted" if isinstance(exc, (asyncio.CancelledError, KeyboardInterrupt)) else "failed")
                record["cleanup"]["error"] = type(exc).__name__ + ": " + str(exc)
                record["cleanup"]["normal_stop_confirmed"] = False
                if cluster is not None:
                    # Last resort uses only live Popen handles owned by this
                    # invocation. Never kill PIDs loaded from historical files.
                    def reap_remaining():
                        failures = []
                        for node, process in cluster.processes.items():
                            try:
                                if process.poll() is None:
                                    process.kill()
                                    process.wait(timeout=5)
                            except Exception as error:
                                failures.append(dict(node=node, error=str(error)))
                        return failures
                    try:
                        record["cleanup"]["forced_reap_errors"] = await control(reap_remaining)
                        record["cleanup"]["all_owned_processes_exited"] = all(p.poll() is not None for p in cluster.processes.values())
                        record["cleanup"]["ports"] = await control(check_ports, cluster.topology)
                    except BaseException as error:
                        record["cleanup"]["fallback_error"] = type(error).__name__ + ": " + str(error)
                        record["cleanup"]["all_owned_processes_exited"] = False
            await asyncio.to_thread(controls.shutdown, wait=True)
            record["ended_at"] = now()
            recording_errors = []
            try:
                await journal.drain()
                record["recording_receipts"] = [dict(kind=k, **f.result()) for k, f in receipts]
                for row, future in result_receipts:
                    row["result_recording_completed_perf_ns"] = future.result()["recording_completed_perf_ns"]
                if journal.path.exists():
                    record["journal_manifest"] = await asyncio.to_thread(inspect_journal, journal.path)
                    if record["journal_manifest"]["entries"] == 0:
                        raise ValueError("Journal contains no durable intents")
                    record["journal_state"] = "verified"
                else:
                    record.update(journal_manifest=None, journal_state="not_created", comparable=False)
                    if record["status"] == "completed":
                        record.update(status="failed", error=dict(type="missing_journal"))
            except Exception as exc:
                recording_errors.append(type(exc).__name__ + ": " + str(exc))
                record.update(journal_manifest=None, journal_state="unverified", comparable=False)
            finally:
                try:
                    await journal.close()
                except Exception as exc:
                    recording_errors.append(type(exc).__name__ + ": " + str(exc))
            if recording_errors:
                logging.getLogger(__name__).error("Experiment recording failed: %s", recording_errors)
                record.update(recording_errors=recording_errors, comparable=False)
                if record["status"] != "interrupted":
                    record.update(status="failed", error=dict(type="recording_failed"))
            # The error/interrupt snapshot must not depend on a failed journal
            # accepting new submissions. If the disk also rejects this atomic
            # write, propagate that failure and leave the lease needs_audit.
            await asyncio.to_thread(atomic_json, directory / "trial.json", record)
        _, teardown_cancelled = await settle(finalize())
        interrupted = interrupted or teardown_cancelled
        if teardown_cancelled:
            record.update(status="interrupted", comparable=False, error=dict(type="controller_cancelled_during_cleanup"))
            await settle(asyncio.to_thread(atomic_json, directory / "trial.json", record))
    if interrupted or record["status"] == "interrupted":
        raise asyncio.CancelledError
    return record
