"""Pure state/graph tests. These are NOT TCP experiments or performance data."""
from datetime import datetime, timedelta, timezone

import pytest
from pydantic import ValidationError

from exit_link.communication.protocol import ReliableSend
from exit_link.fault_detection.models import Advertisement
from exit_link.fault_detection.state import HeartbeatConfig, LinkStateDatabase, NeighborState
from exit_link.routing.communication import available_graph, choose_route
from exit_link.topology.loader import load_communication


class Clock:
    def __init__(self):
        self.now = 0.0
        self.wall = datetime(2026, 1, 1, tzinfo=timezone.utc)

    def advance(self, seconds):
        self.now += seconds
        self.wall += timedelta(seconds=seconds)


def database():
    clock = Clock()
    topology = load_communication()
    db = LinkStateDatabase(topology, "N1", 6, clock=lambda: clock.now, wall_clock=lambda: clock.wall)
    for node_id, neighbors in db.neighbors.items():
        assert db.accept(Advertisement(origin=node_id, epoch=1, sequence=1, generated_at=clock.wall,
                                       links={neighbor: "up" for neighbor in neighbors}), local=node_id == "N1")
    return topology, db, clock


def test_healthy_heartbeat_and_transient_failure():
    state, config = NeighborState(), HeartbeatConfig()
    assert state.observe(True, 0, config)[:2] == ("unknown", "up")
    assert state.observe(False, 1, config)[:2] == ("up", "suspect")
    assert state.failures == 1
    assert state.observe(True, 2, config)[:2] == ("suspect", "up")
    assert state.failures == 0


def test_failure_confirmation_and_stable_recovery():
    state, config = NeighborState(status="up"), HeartbeatConfig()
    state.observe(False, 10, config)
    state.observe(False, 11, config)
    assert state.status == "suspect"
    assert state.observe(False, 12, config) == ("suspect", "down", 2000)
    state.observe(True, 13, config)
    assert state.status == "down"
    state.observe(False, 14, config)
    assert state.status == "down"  # An isolated recovery probe must not undo down.
    state.observe(True, 15, config)
    state.observe(True, 16, config)
    assert state.status == "up"
    assert state.first_failure_at is None


@pytest.mark.parametrize("changes", [{"interval": 0}, {"timeout": float("nan")}, {"state_ttl": 0.1},
                                     {"failure_threshold": 1}, {"recovery_threshold": 0}])
def test_invalid_heartbeat_config(changes):
    with pytest.raises(ValueError):
        HeartbeatConfig(**changes)


def test_healthy_graph_matches_original_topology():
    topology, db, _ = database()
    graph = available_graph(topology, db)
    assert graph.number_of_nodes() == 6
    assert graph.number_of_edges() == 7
    assert len(choose_route(topology, db, "N1", "N4")) == 3


def test_one_link_down_uses_alternate_route_without_removing_healthy_node():
    topology, db, clock = database()
    update = db.fresh()["N1"].model_copy(deep=True, update={"sequence": 2})
    update.links["N2"] = "down"
    assert db.accept(update, local=True)
    assert choose_route(topology, db, "N1", "N4") == ["N1", "N3", "N4"]
    assert "N2" in available_graph(topology, db)  # Its other link remains usable.


def test_isolated_source_is_not_a_successful_recovery():
    topology, db, _ = database()
    assert choose_route(topology, db, "N1", "N4", [frozenset(("N1", "N2")), frozenset(("N1", "N3"))]) is None


def test_expired_state_is_not_routable_and_replay_cannot_refresh_it():
    topology, db, clock = database()
    replay = db.fresh()["N2"]
    clock.advance(4)
    assert not db.accept(replay)
    clock.advance(2.1)
    assert not db.fresh()
    assert choose_route(topology, db, "N1", "N4") is None
    assert not db.accept(replay)


def test_new_incarnation_replaces_old_and_delayed_old_boot_is_rejected():
    _, db, _ = database()
    old = db.fresh()["N2"]
    assert db.accept(old.model_copy(update={"epoch": 2}))
    assert not db.accept(old.model_copy(update={"sequence": 999}))
    assert db.fresh()["N2"].epoch == 2


def test_gossip_does_not_renew_generated_time():
    _, db, clock = database()
    update = db.fresh()["N2"].model_copy(update={"sequence": 2})
    clock.advance(5)
    assert db.accept(update)
    clock.advance(1.1)
    assert "N2" not in db.fresh()


@pytest.mark.parametrize("case", ["unknown_origin", "wrong_neighbors", "future", "expired", "own_origin"])
def test_invalid_or_untrusted_advertisements_are_rejected(case):
    _, db, clock = database()
    origin = "N1" if case == "own_origin" else "N2"
    fields = dict(origin=origin, epoch=2, sequence=1, generated_at=clock.wall,
                  links={neighbor: "up" for neighbor in db.neighbors[origin]})
    if case == "unknown_origin":
        fields["origin"] = "UNKNOWN"
    elif case == "wrong_neighbors":
        fields["links"] = {"N6": "up"}
    elif case == "future":
        fields["generated_at"] += timedelta(seconds=10)
    elif case == "expired":
        fields["generated_at"] -= timedelta(seconds=10)
    assert not db.accept(Advertisement(**fields))


def test_suspect_or_one_sided_link_is_not_selected():
    topology, db, _ = database()
    update = db.fresh()["N2"].model_copy(deep=True, update={"sequence": 2})
    update.links["N1"] = "suspect"
    assert db.accept(update)
    assert not available_graph(topology, db).has_edge("N1", "N2")


@pytest.mark.parametrize("changes", [{"max_retries": -1}, {"max_retries": 7}, {"ttl": 65},
                                     {"source": "N4"}, {"initial_route": ["N2", "N4"]}])
def test_reliable_delivery_limits_and_endpoints(changes):
    fields = dict(source="N1", destination="N4", payload="test")
    fields.update(changes)
    with pytest.raises(ValidationError):
        ReliableSend(**fields)
