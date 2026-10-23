from uuid import uuid4

import pytest

from exit_link.communication.protocol import Message
from exit_link.evacuation.inbox import GuidanceInbox, parse_guidance
from exit_link.evacuation.models import HazardUpdate, now_utc
from exit_link.evacuation.service import ScenarioSession
from exit_link.topology.loader import load_building


def guidance_pair():
    scenario = ScenarioSession(load_building())
    old = scenario.guidance("F3_W", "N1", "N4")
    scenario.update(HazardUpdate(fire_locations=["F2_SW"]))
    return old, scenario.guidance("F3_W", "N1", "N4")


def test_delayed_old_guidance_does_not_replace_newer(tmp_path):
    old, new = guidance_pair()
    inbox = GuidanceInbox("N4", tmp_path / "state.json")
    assert inbox.receive(new).disposition == "applied"
    receipt = inbox.receive(old)
    assert receipt.disposition == "stale"
    assert receipt.latest_guidance_id == new.guidance_id
    assert inbox.query(old.guidance_id)[1] == new


def test_guard_survives_restart_and_reports_specific_receipt(tmp_path):
    old, new = guidance_pair()
    path = tmp_path / "state.json"
    GuidanceInbox("N4", path).receive(new)
    restarted = GuidanceInbox("N4", path)
    assert restarted.receive(old).disposition == "stale"
    assert restarted.query(old.guidance_id)[0].message_id == old.guidance_id
    assert restarted.query(uuid4()) == (None, None)


def test_same_version_same_route_is_duplicate_not_new_application():
    old, _ = guidance_pair()
    inbox = GuidanceInbox("N4")
    inbox.receive(old)
    repeated = old.model_copy(update={"guidance_id": uuid4(), "issued_at": now_utc()})
    assert inbox.receive(repeated).disposition == "duplicate"
    assert inbox.query(repeated.guidance_id)[1].guidance_id == old.guidance_id


def test_same_version_different_route_is_conflict():
    old, new = guidance_pair()
    inbox = GuidanceInbox("N4")
    inbox.receive(old)
    conflict = new.model_copy(update={"scenario_revision": old.scenario_revision, "route_version": old.route_version})
    assert inbox.receive(conflict).disposition == "version_conflict"
    assert inbox.query(conflict.guidance_id)[1] == old


def test_no_route_guidance_clears_previous_path():
    scenario = ScenarioSession(load_building())
    old = scenario.guidance("F3_W", "N1", "N4")
    inbox = GuidanceInbox("N4")
    inbox.receive(old)
    scenario.update(HazardUpdate(blocked_nodes=["EXIT_W", "EXIT_E"]))
    newest = scenario.guidance("F3_W", "N1", "N4")
    assert inbox.receive(newest).disposition == "applied"
    assert inbox.query(newest.guidance_id)[1].path == []
    assert inbox.receive(old).disposition == "stale"


def test_streams_are_separated_by_scenario_and_audience():
    first, _ = guidance_pair()
    inbox = GuidanceInbox("N4")
    inbox.receive(first)
    another = first.model_copy(update={"scenario_id": uuid4(), "guidance_id": uuid4()})
    assert inbox.receive(another).disposition == "applied"
    group = first.model_copy(update={"audience_id": "group_b", "guidance_id": uuid4()})
    assert inbox.receive(group).disposition == "applied"
    assert len(inbox.latest) == 3


def test_other_publisher_cannot_override_existing_stream():
    old, new = guidance_pair()
    inbox = GuidanceInbox("N4")
    inbox.receive(old)
    receipt = inbox.receive(new.model_copy(update={"source_node": "N3"}))
    assert receipt.disposition == "publisher_conflict"
    assert inbox.query(new.guidance_id)[1] == old


def test_message_id_content_conflict_is_rejected_after_restart(tmp_path):
    old, new = guidance_pair()
    path = tmp_path / "state.json"
    GuidanceInbox("N4", path).receive(old)
    with pytest.raises(ValueError, match="ID reused"):
        GuidanceInbox("N4", path).receive(new.model_copy(update={"guidance_id": old.guidance_id}))


def test_corrupt_or_wrong_node_file_fails_closed(tmp_path):
    old, _ = guidance_pair()
    path = tmp_path / "state.json"
    GuidanceInbox("N4", path).receive(old)
    with pytest.raises(ValueError):
        GuidanceInbox("N3", path)
    path.write_text("broken json", encoding="utf-8")
    with pytest.raises(ValueError):
        GuidanceInbox("N4", path)


def test_failed_persistence_does_not_advance_memory_state(tmp_path):
    old, _ = guidance_pair()
    blocker = tmp_path / "not-a-directory"
    blocker.write_text("x", encoding="utf-8")
    inbox = GuidanceInbox("N4", blocker / "state.json")
    with pytest.raises(OSError):
        inbox.receive(old)
    assert inbox.latest == {} and not inbox.receipts


def test_transport_and_guidance_id_must_match():
    old, _ = guidance_pair()
    message = Message(source="N1", destination="N4", route=["N1", "N2", "N4"], payload=old.model_dump_json())
    with pytest.raises(ValueError):
        parse_guidance(message)
    message = message.model_copy(update={"message_id": old.guidance_id})
    assert parse_guidance(message) == old


@pytest.mark.parametrize("payload", ["ordinary text", "{invalid", '{"kind":"other"}', "[]"])
def test_generic_stage2_payload_remains_generic(payload):
    message = Message(source="N1", destination="N4", route=["N1", "N2", "N4"], payload=payload)
    assert parse_guidance(message) is None
