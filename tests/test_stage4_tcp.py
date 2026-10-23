"""Real TCP/independent processes; synthetic fire input is kept separate."""
import asyncio
import os
from pathlib import Path
from uuid import uuid4

import pytest

from exit_link.communication.client import send_message
from exit_link.communication.protocol import Message
from exit_link.evacuation.models import HazardUpdate, now_utc
from exit_link.evacuation.service import ScenarioSession
from exit_link.evacuation.transport import query_guidance, send_guidance
from exit_link.simulation.evacuation_experiment import guidance_during_fault
from exit_link.simulation.processes import LocalCluster
from exit_link.topology.loader import load_building


@pytest.fixture(scope="module")
def guidance_cluster(tmp_path_factory):
    configured = os.environ.get("EXIT_LINK_STAGE4_ARTIFACT_DIR")
    cluster = LocalCluster(Path(configured) if configured else tmp_path_factory.mktemp("stage4-processes"))
    try:
        cluster.start_all()
        asyncio.run(cluster.wait_ready())
        yield cluster
    finally:
        asyncio.run(cluster.close())


def test_guidance_is_delivered_over_tcp_and_application_receipt_is_distinct(guidance_cluster):
    cluster = guidance_cluster
    scenario = ScenarioSession(load_building())
    guidance = scenario.guidance("F2_E", "N1", "N4")
    result = asyncio.run(send_guidance(cluster.topology, guidance))
    assert result.ack_received and result.transport_result.success
    assert result.message_id == guidance.guidance_id
    assert result.application_receipt.disposition == "applied"
    assert not result.human_evacuation_verified
    assert cluster.records("N4", "guidance_applied", guidance.guidance_id)


def test_late_old_guidance_is_acked_but_not_applied(guidance_cluster):
    cluster = guidance_cluster
    async def check():
        scenario = ScenarioSession(load_building())
        old = scenario.guidance("F2_E", "N1", "N4")
        scenario.update(HazardUpdate(fire_locations=["F1_SE"]))
        new = scenario.guidance("F2_E", "N1", "N4")
        assert (await send_guidance(cluster.topology, new)).application_receipt.disposition == "applied"
        result = await send_guidance(cluster.topology, old)
        assert result.ack_received and result.application_receipt.disposition == "stale"
        assert (await query_guidance(cluster.topology, "N4", old.guidance_id)).latest.guidance_id == new.guidance_id
        assert cluster.records("N4", "guidance_stale", old.guidance_id)
    asyncio.run(check())


def test_guidance_survives_real_relay_termination_with_stage3_rerouting(guidance_cluster):
    scenario = ScenarioSession(load_building())
    guidance = scenario.guidance("F2_E", "N1", "N4")
    result, fault = asyncio.run(guidance_during_fault(guidance_cluster, guidance))
    assert fault["node"] == "N2"
    assert result.ack_received and result.application_receipt.disposition == "applied"
    assert result.transport_result.retries >= 1
    assert result.transport_result.ack.route == ["N1", "N3", "N4"]
    assert len(guidance_cluster.records("N4", "received", guidance.guidance_id)) == 1


def test_no_route_guidance_removes_old_usable_route(guidance_cluster):
    cluster = guidance_cluster
    async def check():
        scenario = ScenarioSession(load_building())
        old = scenario.guidance("F2_E", "N1", "N4")
        assert (await send_guidance(cluster.topology, old)).ack_received
        scenario.update(HazardUpdate(blocked_nodes=["EXIT_W", "EXIT_E"]))
        blocked = scenario.guidance("F2_E", "N1", "N4")
        result = await send_guidance(cluster.topology, blocked)
        assert result.ack_received and result.application_receipt.disposition == "applied"
        latest = (await query_guidance(cluster.topology, "N4", blocked.guidance_id)).latest
        assert latest.status == "no_route" and latest.path == [] and latest.exit_id is None
    asyncio.run(check())


def test_receiver_restart_keeps_latest_version_guard(guidance_cluster):
    cluster = guidance_cluster
    async def check():
        scenario = ScenarioSession(load_building())
        old = scenario.guidance("F2_E", "N1", "N4")
        scenario.update(HazardUpdate(fire_locations=["F1_SE"]))
        new = scenario.guidance("F2_E", "N1", "N4")
        assert (await send_guidance(cluster.topology, new)).application_receipt.disposition == "applied"
        cluster.kill("N4")
        cluster.start("N4")
        await cluster.wait_ready()
        delayed = old.model_copy(update={"guidance_id": uuid4(), "issued_at": now_utc()})
        result = await send_guidance(cluster.topology, delayed)
        assert result.ack_received and result.application_receipt.disposition == "stale"
        assert (await query_guidance(cluster.topology, "N4", delayed.guidance_id)).latest.guidance_id == new.guidance_id
    asyncio.run(check())


def test_invalid_guidance_identity_returns_error_without_crashing_node(guidance_cluster):
    scenario = ScenarioSession(load_building())
    guidance = scenario.guidance("F2_E", "N1", "N4")
    invalid = Message(source="N1", destination="N4", route=["N1", "N2", "N4"], payload=guidance.model_dump_json())
    result = asyncio.run(send_message(guidance_cluster.topology, invalid))
    assert result.code == "invalid_guidance"
    assert asyncio.run(send_guidance(guidance_cluster.topology, guidance)).application_receipt.disposition == "applied"
