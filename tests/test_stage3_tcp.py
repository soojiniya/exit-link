"""Real TCP fault tests, never substituted with graph or transport mocks."""
import asyncio
import os
from pathlib import Path

import pytest

from exit_link.communication.client import get_status, send_message, send_reliably
from exit_link.communication.protocol import Ack, Message, ReliableSend, exchange
from exit_link.metrics.recording import write_observation
from exit_link.simulation.experiment import fault_and_recovery
from exit_link.simulation.processes import LocalCluster


@pytest.fixture(scope="module")
def resilient_cluster(tmp_path_factory):
    configured = os.environ.get("EXIT_LINK_STAGE3_ARTIFACT_DIR")
    path = Path(configured) if configured else tmp_path_factory.mktemp("stage3-processes")
    cluster = LocalCluster(path)
    try:
        cluster.start_all()
        asyncio.run(cluster.wait_ready())
        yield cluster
    finally:
        asyncio.run(cluster.close())


def test_heartbeat_and_distributed_state(resilient_cluster):
    cluster = resilient_cluster
    async def check():
        await cluster.wait_ready()
        for node in cluster.topology.nodes:
            status = await get_status(cluster.topology, node.id)
            assert status.enabled
            assert len(status.advertisements) == 6
            assert all(state["status"] == "up" and state["failures"] == 0 for state in status.neighbors.values())
    asyncio.run(check())


def test_inflight_relay_kill_reroute_ack_and_recovery(resilient_cluster):
    cluster = resilient_cluster
    report = asyncio.run(fault_and_recovery(cluster))
    write_observation(cluster.directory / "fault-recovery.json", report)
    result = report["result"]
    assert result["success"]
    assert 1 <= result["retries"] <= 3
    assert result["attempts"][0]["route"] == ["N1", "N2", "N4"]
    assert result["attempts"][0]["outcome"] in {"invalid_response", "timeout", "connection_failed"}
    assert report["path_after"] == ["N1", "N3", "N4"]
    assert result["ack"]["message_id"] == report["message_id"]
    assert len(cluster.records("N4", "received", report["message_id"])) == 1
    assert cluster.records("N1", "retry_scheduled", report["message_id"])
    assert cluster.records("N1", "route_changed", report["message_id"])
    assert any(item.get("neighbor") == "N2" for item in cluster.records("N1", "neighbor_down"))
    assert any(item.get("neighbor") == "N2" for item in cluster.records("N1", "neighbor_recovered"))
    assert report["new_epoch"] > report["old_epoch"]
    assert report["delivery_recovered_after_fault_ms"] >= 0
    assert report["detection_observed_after_fault_ms"] >= 0
    assert result["route_calculation_ms"] >= 0


def test_consecutive_failures_and_no_route(resilient_cluster):
    cluster = resilient_cluster
    async def check():
        await cluster.wait_ready()
        try:
            cluster.kill("N2")
            await cluster.wait_status("N1", "N2", "down")
            alternate = await send_reliably(cluster.topology, ReliableSend(source="N1", destination="N4", payload="one failed"))
            assert alternate.success
            assert alternate.ack.route == ["N1", "N3", "N4"]
            cluster.kill("N3")
            await cluster.wait_status("N1", "N3", "down")
            failed = await send_reliably(cluster.topology, ReliableSend(source="N1", destination="N4", payload="two failed"))
            write_observation(cluster.directory / "consecutive-failures.json", failed.model_dump(mode="json"))
            assert not failed.success
            assert failed.ack is None and failed.error.code == "no_route"
            assert not failed.attempts
        finally:
            for node in ("N2", "N3"):
                if cluster.processes[node].poll() is not None:
                    cluster.start(node)
            await cluster.wait_ready()
    asyncio.run(check())


def test_no_retry_when_limit_zero(resilient_cluster):
    report = asyncio.run(fault_and_recovery(resilient_cluster, max_retries=0))
    result = report["result"]
    assert not result["success"]
    assert result["error"]["code"] == "retry_exhausted"
    assert result["retries"] == 0 and len(result["attempts"]) == 1
    assert not resilient_cluster.records("N4", "received", report["message_id"])


def test_logical_duplicate_across_changed_route(resilient_cluster):
    cluster = resilient_cluster
    async def check():
        await cluster.wait_ready()
        message = Message(source="N1", destination="N4", payload="one logical delivery", route=["N1", "N2", "N4"])
        assert isinstance(await send_message(cluster.topology, message), Ack)
        # Submit the next attempt at a different relay to exercise the actual
        # destination's cache rather than merely the original source's cache.
        changed = message.model_copy(update={"route": ["N1", "N3", "N4"], "hop_index": 1, "from_node": "N1", "ttl": 4})
        peer = next(node for node in cluster.topology.nodes if node.id == "N3")
        ack = await exchange(peer.host, peer.port, changed)
        assert isinstance(ack, Ack) and ack.duplicate
        assert ack.route == changed.route
        assert len(cluster.records("N4", "received", message.message_id)) == 1
        assert cluster.records("N4", "duplicate", message.message_id)
    asyncio.run(check())


def test_global_ttl_budget_prevents_attempt(resilient_cluster):
    cluster = resilient_cluster
    async def check():
        await cluster.wait_ready()
        result = await send_reliably(cluster.topology, ReliableSend(source="N1", destination="N4", payload="ttl", ttl=1))
        assert not result.success and result.error.code == "ttl_expired"
        assert result.retries == 0 and result.attempts == []
        assert not cluster.records("N4", "received", result.message_id)
    asyncio.run(check())


def test_dead_origin_expires_and_new_incarnation_recovers(resilient_cluster):
    cluster = resilient_cluster
    async def check():
        await cluster.wait_ready()
        initial = await get_status(cluster.topology, "N1")
        old_epoch = next(item.epoch for item in initial.advertisements if item.origin == "N6")
        cluster.kill("N6")
        try:
            await cluster.wait_status("N4", "N6", "down")
            deadline = asyncio.get_running_loop().time() + 8
            while True:
                status = await get_status(cluster.topology, "N1")
                if "N6" not in {item.origin for item in status.advertisements}:
                    break
                assert asyncio.get_running_loop().time() < deadline, "Dead origin state never expired"
                await asyncio.sleep(0.05)
            result = await send_reliably(cluster.topology, ReliableSend(source="N1", destination="N6", payload="dead destination"))
            assert not result.success and result.error.code == "no_route"
        finally:
            cluster.start("N6")
            await cluster.wait_ready()
        updated = await get_status(cluster.topology, "N1")
        assert next(item.epoch for item in updated.advertisements if item.origin == "N6") > old_epoch
    asyncio.run(check())
