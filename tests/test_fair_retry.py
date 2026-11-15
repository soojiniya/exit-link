"""fair_retry_v1 unit tests. Synthetic fixtures only: no TCP node is started here.

The real-TCP rehearsal at the bottom runs only when EXIT_LINK_FAIR_REAL_TCP=1 is set
(Windows, after explicit approval). These results are never contest measurements.
"""
import asyncio
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path
from types import SimpleNamespace

import pytest

from exit_link.communication import protocol, reliable
from exit_link.experiments import aligned_v3 as engine
from exit_link.experiments import fair_retry as fair
from exit_link.experiments.comparison import ROUTE
from exit_link.experiments.fixed_retry import RETRIABLE, deliver_fixed_retry
from exit_link.experiments.safety import atomic_json
from exit_link.topology.loader import load_communication

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))


# ---------------------------------------------------------------- policy level
def fake_node(responses, *, heartbeat=None):
    """process() answers from a script; records the route of every attempt."""
    topology = load_communication()
    seen = []
    async def process(message):
        seen.append(list(message.route))
        kind = responses[min(len(seen), len(responses)) - 1]
        if kind == "ack":
            return protocol.Ack(message_id=message.message_id, source=message.destination,
                                destination=message.source, route=message.route)
        return protocol.ErrorResponse(node=message.route[0], message_id=message.message_id, code=kind, detail="unit")
    node = SimpleNamespace(node_id="N1", nodes={n.id: n for n in topology.nodes}, topology=topology,
                           heartbeat=heartbeat, log=lambda *a, **k: None, process=process)
    return node, seen


def all_links_up_heartbeat(topology):
    links = {n.id: {} for n in topology.nodes}
    for e in topology.edges:
        links[e.source][e.target] = "up"
        links[e.target][e.source] = "up"
    database = SimpleNamespace(local_id="N1", fresh=lambda: {k: SimpleNamespace(links=v) for k, v in links.items()})
    return SimpleNamespace(database=database)


def request(max_retries=fair.MAX_RETRIES):
    return protocol.ReliableSend(source="N1", destination="N4", payload="x" * 256, ttl=16,
                                 initial_route=list(ROUTE), max_retries=max_retries)


def test_fixed_retry_keeps_the_fixed_route_on_every_attempt():
    node, seen = fake_node(["connection_failed", "connection_failed", "ack"])
    result = asyncio.run(deliver_fixed_retry(node, request()))
    assert result.success and result.retries == 2 and len(result.attempts) == 3
    assert seen == [ROUTE, ROUTE, ROUTE]
    assert all(a.route == ROUTE for a in result.attempts)
    assert result.ttl_remaining == 16 - 3 * 2  # same per-attempt hop reservation as reliable.py


def test_retry_count_excludes_the_first_attempt():
    node, seen = fake_node(["connection_failed"])
    result = asyncio.run(deliver_fixed_retry(node, request()))
    assert not result.success and result.error.code == "retry_exhausted"
    assert len(seen) == fair.MAX_RETRIES + 1 == 4  # first attempt + 3 retries


def test_non_retriable_error_stops_immediately_like_production():
    node, seen = fake_node(["message_id_conflict"])
    result = asyncio.run(deliver_fixed_retry(node, request()))
    assert len(seen) == 1 and result.error.code == "message_id_conflict"


def test_no_heartbeat_is_needed_for_fixed_retry():
    node, _ = fake_node(["ack"], heartbeat=None)
    assert asyncio.run(deliver_fixed_retry(node, request())).success
    production = asyncio.run(reliable.deliver_reliably(node, request()))
    assert production.error.code == "resilience_disabled"  # why EXIT-LINK keeps --resilient


def test_retriable_codes_match_production_source():
    source = (ROOT / "src/exit_link/communication/reliable.py").read_text(encoding="utf-8")
    literal = re.search(r'response\.code not in \{([^}]*)\}', source).group(1)
    assert set(re.findall(r'"([a-z_]+)"', literal)) == set(RETRIABLE)


def test_same_failure_sequence_differs_only_in_route_choice():
    script = ["connection_failed", "ack"]
    fixed_node, fixed_routes = fake_node(script)
    exit_node, exit_routes = fake_node(script, heartbeat=all_links_up_heartbeat(load_communication()))
    fixed = asyncio.run(deliver_fixed_retry(fixed_node, request()))
    exit_link = asyncio.run(reliable.deliver_reliably(exit_node, request()))
    assert fixed.success and exit_link.success
    assert len(fixed.attempts) == len(exit_link.attempts) == 2 and fixed.retries == exit_link.retries == 1
    assert fixed.ttl_remaining == exit_link.ttl_remaining
    assert fixed_routes == [ROUTE, ROUTE]
    assert exit_routes[0] == ROUTE and exit_routes[1] != ROUTE and "N2" not in exit_routes[1]


def test_documented_difference_exit_link_can_stop_early_with_no_route():
    """Both get 4 attempts, but EXIT-LINK stops once exclusions leave no path."""
    fixed_node, fixed_routes = fake_node(["connection_failed"])
    exit_node, exit_routes = fake_node(["connection_failed"], heartbeat=all_links_up_heartbeat(load_communication()))
    fixed = asyncio.run(deliver_fixed_retry(fixed_node, request()))
    exit_link = asyncio.run(reliable.deliver_reliably(exit_node, request()))
    assert len(fixed_routes) == 4 and fixed.error.code == "retry_exhausted"
    assert len(exit_routes) <= 4 and exit_link.error.code in {"no_route", "retry_exhausted"}


# ---------------------------------------------------------------- launcher
def run_python(code):
    env = dict(os.environ, PYTHONPATH=str(ROOT / "src"))
    return subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, env=env, timeout=60)


def test_launcher_binds_fixed_retry_into_the_node_module_only_in_its_process():
    done = run_python(
        "from exit_link.experiments import fixed_retry_node as f; f.install();"
        "from exit_link.communication import node;"
        "from exit_link.experiments.fixed_retry import deliver_fixed_retry;"
        "assert node.deliver_reliably is deliver_fixed_retry; print('bound')")
    assert done.returncode == 0 and "bound" in done.stdout, done.stderr
    untouched = run_python(
        "from exit_link.communication import node, reliable;"
        "assert node.deliver_reliably is reliable.deliver_reliably;"
        "assert reliable.deliver_reliably.__module__ == 'exit_link.communication.reliable'; print('production')")
    assert untouched.returncode == 0 and "production" in untouched.stdout, untouched.stderr


def test_launcher_refuses_late_binding():
    late = run_python("import exit_link.communication.node\n"
                      "from exit_link.experiments import fixed_retry_node as f\n"
                      "try:\n    f.install()\nexcept RuntimeError:\n    print('refused')")
    assert "refused" in late.stdout, late.stderr


def test_launcher_reuses_v3_instrumentation_without_heartbeat():
    source = (ROOT / "src/exit_link/experiments/fixed_retry_node.py").read_text(encoding="utf-8")
    assert "instrumented_main(fixed=True)" in source  # experiments.node.main removes --resilient
    assert fair.NODE_MODULES == {"fixed_retry": "exit_link.experiments.fixed_retry_node",
                                 "exit_link": "exit_link.experiments.node"}  # exit_link = v3 launcher
    assert fair.FairCluster.start is fair.LocalCluster.start  # identical command line otherwise


# ---------------------------------------------------------------- plan
def test_plan_is_paired_counterbalanced_and_states_one_retry_budget(tmp_path):
    plan = fair.prepare(tmp_path / "run", repetitions=4, seed=7)
    assert fair.validate(tmp_path / "run")["design_sha256"] == plan["design_sha256"]
    assert Counter(s["method"] for s in plan["schedule"]) == {"fixed_retry": 32, "exit_link": 32}
    retry = plan["settings"]["retry_policy"]
    assert retry["max_retries_after_first_attempt"] == 3 and retry["max_attempts"] == 4 and retry["backoff_seconds"] == 0
    assert "fixed_retries" not in plan["settings"] and "exit_link_max_retries" not in plan["settings"]
    from exit_link.experiments.study_v3 import SETTINGS as V3
    for key in ("client_timeout_seconds", "observation_window_seconds", "secondary_fault_or_restart_seconds",
                "send_offsets_seconds", "inflight_followup_seconds", "scheduling_tolerance_ms", "payload_bytes", "ttl",
                "relay_delay_seconds", "probe_interval_seconds", "probe_timeout_seconds", "failure_threshold",
                "recovery_threshold", "state_ttl_seconds", "warmup_seconds", "node_hop_timeout_seconds"):
        assert plan["settings"][key] == V3[key], key
    assert plan["settings"]["execution_policy"] == V3["execution_policy"]


@pytest.mark.parametrize("mutation", ["settings", "methods", "protocol", "schedule"])
def test_plan_rejects_edits_and_legacy(tmp_path, mutation):
    fair.prepare(tmp_path / "run", repetitions=2, seed=1)
    path = tmp_path / "run" / "plan.json"
    plan = json.loads(path.read_text(encoding="utf-8"))
    if mutation == "settings":
        plan["settings"]["retry_policy"]["max_retries_after_first_attempt"] = 0
    elif mutation == "methods":
        plan["methods"] = ["fixed", "exit_link"]
    elif mutation == "protocol":
        plan["protocol_version"] = "aligned_v3"
    else:
        plan["schedule"][0], plan["schedule"][1] = plan["schedule"][1], plan["schedule"][0]
    plan["design_sha256"] = fair.design_hash(plan)
    atomic_json(path, plan)
    with pytest.raises(ValueError):
        fair.validate(tmp_path / "run")


def test_runner_only_executes_under_its_own_root():
    import prepare_fair_retry as runner
    assert runner.inside_fair_root(runner.ROOT / "pilot-abc")
    assert not runner.inside_fair_root(ROOT / "data/measured/v3-6d329cd9")
    assert not runner.inside_fair_root(ROOT / "data/measured")


# ---------------------------------------------------------------- engine binding
def test_bound_engine_restores_v3_globals_even_on_error():
    before = engine.BenchmarkCluster, engine.PROTOCOL
    with pytest.raises(KeyError):
        with fair.bound_engine():
            assert engine.BenchmarkCluster is fair.FairCluster and engine.PROTOCOL == "fair_retry_v1"
            raise KeyError("boom")
    assert (engine.BenchmarkCluster, engine.PROTOCOL) == before == (engine.BenchmarkCluster, "aligned_v3")
    with fair.bound_engine():
        with pytest.raises(RuntimeError, match="already bound"):
            with fair.bound_engine():
                pass


@pytest.mark.parametrize("method", ["fixed_retry", "exit_link"])
def test_trial_uses_v3_timetable_with_one_request_type(tmp_path, monkeypatch, method):
    """Synthetic transport fixture (not TCP evidence): the shared v3 cell runs both methods."""
    events, calls, sent = [], Counter(), []
    class FixtureCluster:
        def __init__(self, directory, m):
            assert m == method
            self.topology, self.processes, self.history = load_communication(), {}, []
        def start_all(self): pass
        async def wait_ready(self): calls["wait_ready"] += 1
        def kill(self, node): return dict(unit_fixture=True)
        def start(self, node): events.append(dict(node=node, event="node_started", benchmark_perf_ns=time.perf_counter_ns()))
        def records(self, node, event=None, message_id=None):
            return [e for e in events if e["node"] == node and e["event"] == event]
        async def close(self): pass
    async def status(*args):
        calls["status"] += 1
        return SimpleNamespace(enabled=False)
    async def exchange(config, req, row):
        sent.append(req)
        row["tcp_request_start_perf_ns"] = row["dispatch_perf_ns"] = time.perf_counter_ns()
        row["scheduling_lateness_ms"] = (row["dispatch_perf_ns"] - row["scheduled_perf_ns"]) / 1e6
        ack = protocol.Ack(message_id=req.message_id, source="N4", destination="N1", route=list(ROUTE))
        attempt = protocol.Attempt(number=1, route=list(ROUTE), started_at=protocol.utc_now(), duration_ms=1,
                                   route_calculation_ms=0, outcome="ack")
        return protocol.DeliveryResult(message_id=req.message_id, source="N1", destination="N4", success=True, ack=ack,
                                       attempts=[attempt], retries=0, ttl_remaining=14, elapsed_ms=1, route_calculation_ms=0)
    monkeypatch.setattr(fair, "FairCluster", FixtureCluster)
    monkeypatch.setattr(engine, "get_status", status)
    monkeypatch.setattr(engine, "exchange_measured", exchange)
    monkeypatch.setattr(engine, "check_ports", lambda t: [dict(available=True)])
    monkeypatch.setattr(engine, "all_events", lambda cluster: events)
    cell = asyncio.run(fair.trial(tmp_path / "cell", dict(condition="restart", fault_timing="before_send",
                                                           method=method, repetition=0)))
    assert cell["status"] == "completed" and cell["comparable"], cell
    assert cell["protocol_version"] == "fair_retry_v1" and engine.PROTOCOL == "aligned_v3"
    assert len(sent) == 3 and all(isinstance(r, protocol.ReliableSend) for r in sent)
    assert all(r.max_retries == 3 and r.initial_route == ROUTE for r in sent)
    if method == "fixed_retry":
        assert calls["status"] == 6 and calls["wait_ready"] == 0  # heartbeat verified OFF on all 6 nodes
    else:
        assert calls["wait_ready"] == 1 and calls["status"] == 0
    assert [m["retries"] for m in cell["messages"]] == [0, 0, 0]


def test_trial_refuses_legacy_methods(tmp_path):
    with pytest.raises(ValueError):
        asyncio.run(fair.trial(tmp_path / "x", dict(condition="normal", fault_timing="none", method="fixed", repetition=0)))
    assert not (tmp_path / "x").exists()


# ---------------------------------------------------------------- analysis
def synthetic_run(tmp_path, outcomes):
    run = tmp_path / "data" / "measured" / "fair-retry" / "unit-run"
    plan = fair.prepare(run, repetitions=2, seed=3)
    for index, spec in enumerate(plan["schedule"]):
        delivered = outcomes(spec)
        record = dict(protocol_version="fair_retry_v1", comparable=not (spec["condition"] == "restart" and spec["repetition"] == 1
                      and spec["fault_timing"] == "inflight" and spec["method"] == "exit_link"),
                      messages=[dict(position=p, delivered_observed=d, ack_received=d, client_elapsed_ms=200.0 + p,
                                     raw_response=dict(attempts=[{}] * (1 if d else 4))) for p, d in enumerate(delivered)],
                      overhead=dict(framed_bytes_per_second=0 if spec["method"] == "fixed_retry" else 100.0))
        if not record["comparable"]:
            record["error"] = dict(type="schedule_deviation")
        folder = run / f"t{index:03}"
        folder.mkdir()
        (folder / "trial.json").write_text(json.dumps(record), encoding="utf-8")
        plan["completed"][str(index)] = dict(sha256=hashlib.sha256((folder / "trial.json").read_bytes()).hexdigest(),
                                             comparable=record["comparable"])
    atomic_json(run / "plan.json", plan)
    return run


def test_analysis_pairs_blocks_excludes_both_sides_and_never_overwrites(tmp_path):
    import analyze_fair_retry as analysis
    def outcomes(spec):
        if spec["condition"] in ("single_failure",) and spec["method"] == "fixed_retry":
            return [False, False, False]
        if spec["condition"] == "no_route":
            return [False, False, False]
        return [True, True, True]
    run = synthetic_run(tmp_path, outcomes)
    summary, rows = analysis.analyze(run, tmp_path / "outputs" / "fair")
    assert summary["planned_blocks"] == 16 and summary["excluded_blocks"] == 1 and summary["valid_blocks"] == 15
    overall = next(r for r in rows if r["scope"] == "overall" and r["metric"] == "delivered")
    assert overall["fixed_retry_n"] == overall["exit_link_n"] == 45  # failures stay in the denominator
    single = next(r for r in rows if r["scope"] == "single_failure/before_send" and r["metric"] == "delivered")
    assert single["fixed_retry_success"] == 0 and single["exit_link_success"] == 6 and single["blocks_exit_better"] == 2
    assert summary["attempts_per_message"]["fixed_retry"]["4"] > 0
    sums = (tmp_path / "outputs" / "fair" / "OUTPUT_SHA256SUMS.txt").read_text(encoding="utf-8")
    assert "stats.csv" in sums and "summary.json" in sums
    with pytest.raises(FileExistsError):
        analysis.analyze(run, tmp_path / "outputs" / "fair")
    with pytest.raises(ValueError):
        analysis.analyze(run, run.parent / "inside")


def test_analysis_refuses_legacy_runs(tmp_path):
    import analyze_fair_retry as analysis
    legacy = tmp_path / "legacy"
    legacy.mkdir()
    (legacy / "plan.json").write_text(json.dumps(dict(protocol_version="aligned_v3", schedule=[], completed={})), encoding="utf-8")
    with pytest.raises(ValueError):
        analysis.analyze(legacy, tmp_path / "out")


def test_sign_test_and_holm():
    import analyze_fair_retry as analysis
    assert analysis.sign_test(0, 0) == 1.0
    assert analysis.sign_test(5, 0) == pytest.approx(2 / 32)
    assert analysis.holm([0.01, 0.04, 0.03]) == pytest.approx([0.03, 0.06, 0.06])


# ---------------------------------------------------------------- real TCP (opt-in)
@pytest.mark.skipif(os.environ.get("EXIT_LINK_FAIR_REAL_TCP") != "1",
                    reason="Real TCP rehearsal: set EXIT_LINK_FAIR_REAL_TCP=1 on Windows after approval")
@pytest.mark.parametrize("method", ["fixed_retry", "exit_link"])
def test_real_tcp_restart_rehearsal(tmp_path, method):
    cell = asyncio.run(fair.trial(tmp_path / "real", dict(condition="restart", fault_timing="before_send",
                                                           method=method, repetition=0)))
    assert cell["status"] == "completed", cell
    assert cell["cleanup"]["normal_stop_confirmed"] and cell["cleanup"]["all_owned_processes_exited"]
    assert all(p["available"] for p in cell["cleanup"]["ports"])
