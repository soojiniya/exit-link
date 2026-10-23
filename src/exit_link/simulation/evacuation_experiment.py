"""Stage 4 integration: virtual guidance transported over real TCP processes."""
import asyncio
from uuid import uuid4

from exit_link.evacuation.dashboard import dashboard_snapshot, network_event, observe_network
from exit_link.evacuation.models import HazardUpdate, now_utc
from exit_link.evacuation.service import ScenarioSession
from exit_link.evacuation.transport import query_guidance, send_guidance
from exit_link.metrics.recording import write_observation
from exit_link.simulation.processes import LocalCluster, read_events
from exit_link.topology.loader import load_building


async def guidance_during_fault(cluster, guidance):
    await cluster.wait_ready()
    delivery = asyncio.create_task(send_guidance(cluster.topology, guidance, initial_route=["N1", "N2", "N4"], timeout=20))
    try:
        await cluster.wait_event("N2", "relay_wait", guidance.guidance_id)
        fault = cluster.kill("N2")
        result = await delivery
        await cluster.wait_status("N1", "N2", "down")
        return result, fault
    finally:
        if not delivery.done():
            delivery.cancel()
        await asyncio.gather(delivery, return_exceptions=True)
        if cluster.processes["N2"].poll() is not None:
            cluster.start("N2")
            await cluster.wait_ready()


async def run_stage4_experiment(output):
    cluster = LocalCluster(output / "processes")
    session = ScenarioSession(load_building())
    deliveries = []
    try:
        cluster.start_all()
        await cluster.wait_ready()
        old = session.guidance("F2_E", "N1", "N4")
        session.update(HazardUpdate(fire_locations=["F1_SE"]))
        new = session.guidance("F2_E", "N1", "N4")
        applied = await send_guidance(cluster.topology, new)
        deliveries.append(applied)
        if not applied.ack_received or applied.application_receipt is None or applied.application_receipt.disposition != "applied":
            raise AssertionError("New guidance was not ACKed and applied")
        delayed = await send_guidance(cluster.topology, old)
        deliveries.append(delayed)
        if not delayed.ack_received or delayed.application_receipt is None or delayed.application_receipt.disposition != "stale":
            raise AssertionError("Late old guidance was not ACKed and discarded")
        session.update(HazardUpdate(blocked_nodes=["EXIT_W", "EXIT_E"]))
        cancellation = session.guidance("F2_E", "N1", "N4")
        no_route = await send_guidance(cluster.topology, cancellation)
        deliveries.append(no_route)
        if not no_route.ack_received or no_route.application_receipt is None or no_route.application_receipt.disposition != "applied":
            raise AssertionError("No-route guidance was not applied")
        if (await query_guidance(cluster.topology, "N4", cancellation.guidance_id)).latest.path:
            raise AssertionError("Old usable route was not cleared")
        session.update(HazardUpdate(fire_locations=["F1_SE"]))
        rerouted = session.guidance("F2_E", "N1", "N4")
        fault_delivery, fault = await guidance_during_fault(cluster, rerouted)
        deliveries.append(fault_delivery)
        if not fault_delivery.ack_received or fault_delivery.application_receipt is None or fault_delivery.application_receipt.disposition != "applied":
            raise AssertionError("Guidance during relay failure was not applied")
        if fault_delivery.transport_result.retries < 1 or fault_delivery.transport_result.ack.route != ["N1", "N3", "N4"]:
            raise AssertionError("Actual alternate TCP path/retry was not verified")
        cluster.kill("N4")
        cluster.start("N4")
        await cluster.wait_ready()
        late_after_restart = old.model_copy(update={"guidance_id": uuid4(), "issued_at": now_utc()})
        recovered_receipt = await send_guidance(cluster.topology, late_after_restart)
        deliveries.append(recovered_receipt)
        if not recovered_receipt.ack_received or recovered_receipt.application_receipt is None or recovered_receipt.application_receipt.disposition != "stale":
            raise AssertionError("Restart lost the latest-version ordering guard")
        latest = await query_guidance(cluster.topology, "N4", late_after_restart.guidance_id)
        if latest.latest.guidance_id != rerouted.guidance_id:
            raise AssertionError("Old guidance replaced the current plan")
        for delivery in deliveries:
            session.record_delivery(delivery)
        network = await observe_network(cluster.topology)
        events = [network_event(raw) for entry in cluster.history for raw in read_events(cluster.directory / entry["log"])]
        snapshot = dashboard_snapshot(load_building(), cluster.topology, session.snapshot(), network, deliveries, events)
        write_observation(output / "dashboard.json", snapshot.model_dump(mode="json"))
        return {"status": "passed", "disaster_origin": "simulation", "transport": "real_tcp_loopback",
                "human_evacuation_verified": False, "fault": fault,
                "deliveries": [delivery.model_dump(mode="json") for delivery in deliveries]}
    finally:
        await cluster.close()
