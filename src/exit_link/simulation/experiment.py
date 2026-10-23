"""Kill a real relay during forwarding, verify rerouting, then restart it."""
import asyncio
import time

from exit_link.communication.client import get_status, send_reliably
from exit_link.communication.protocol import ReliableSend


async def fault_and_recovery(cluster, max_retries=3):
    await cluster.wait_ready()
    before = await get_status(cluster.topology, "N1")
    old_epoch = next(item.epoch for item in before.advertisements if item.origin == "N2")
    request = ReliableSend(source="N1", destination="N4", payload="Actual relay termination experiment",
                           initial_route=["N1", "N2", "N4"], max_retries=max_retries)
    delivery = asyncio.create_task(send_reliably(cluster.topology, request, timeout=20))
    detection = None
    fault = None
    try:
        await cluster.wait_event("N2", "relay_wait", request.message_id)
        # The relay is processing this exact real TCP message at this point.
        fault = cluster.kill("N2")
        detection = asyncio.create_task(cluster.wait_status("N1", "N2", "down"))
        result = await delivery
        ack_observed = time.monotonic_ns()
        observed = await detection
        down_events = cluster.records("N1", "neighbor_down")
        event = next((item for item in reversed(down_events) if item.get("neighbor") == "N2"), None)
        if event is None:
            raise AssertionError("No actual neighbor_down event")
        after_detection = await send_reliably(cluster.topology, ReliableSend(
            source="N1", destination="N4", payload="Delivery after confirmed heartbeat failure",
        ))
        if not after_detection.success or "N2" in after_detection.ack.route:
            raise AssertionError("Delivery after confirmed detection did not avoid the down relay")
        report = {
            "transport": "real_tcp_loopback", "topology_origin": "simulation", "message_id": str(request.message_id),
            "conditions": {"relay_delay_s": cluster.relay_delay, "probe_interval_s": 0.1,
                           "probe_timeout_s": 0.15, "failure_threshold": 2, "state_ttl_s": 3,
                           "source": "N1", "destination": "N4", "ttl_budget": request.ttl,
                           "max_retries": request.max_retries},
            "fault": fault, "result": result.model_dump(mode="json"),
            "detection_observed_after_fault_ms": (observed["observed_monotonic_ns"] - fault["issued_monotonic_ns"]) / 1e6,
            "down_since_first_failed_probe_observation_ms": event["detection_since_first_failure_ms"],
            "delivery_recovered_after_fault_ms": (ack_observed - fault["issued_monotonic_ns"]) / 1e6 if result.success else None,
            "path_before": request.initial_route, "path_after": result.ack.route if result.ack else None,
            "after_confirmed_detection": after_detection.model_dump(mode="json"),
        }
    finally:
        if not delivery.done():
            delivery.cancel()
        await asyncio.gather(delivery, return_exceptions=True)
        if detection is not None and not detection.done():
            detection.cancel()
            await asyncio.gather(detection, return_exceptions=True)
        if cluster.processes["N2"].poll() is not None:
            restart_started = time.monotonic_ns()
            cluster.start("N2")
            await cluster.wait_ready()
    recovered = await get_status(cluster.topology, "N1")
    new_epoch = next(item.epoch for item in recovered.advertisements if item.origin == "N2")
    if new_epoch <= old_epoch:
        raise AssertionError("Recovered node incarnation did not replace the old state")
    report["node_recovery_observed_ms"] = (time.monotonic_ns() - restart_started) / 1e6
    report["old_epoch"], report["new_epoch"] = old_epoch, new_epoch
    return report
