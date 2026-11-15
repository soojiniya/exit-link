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
def n1_log_lines(message_id, attempts, *, result=True, duplicate_route=False, extra_noise=True):
    """N1 JSONL as the instrumented node writes it: one route_* line per attempt, then delivery_result."""
    lines = []
    for number in range(1, attempts + 1):
        event = dict(event="route_selected" if number == 1 else "route_reused", node="N1", message_id=message_id,
                     route=list(ROUTE), attempt=number)
        lines.append(json.dumps(event))
        if duplicate_route and number == 1:
            lines.append(json.dumps(event))  # same line printed twice = one attempt
        if extra_noise:  # per-hop and retry bookkeeping lines are not attempts
            lines.append(json.dumps(dict(event="forwarded", node="N1", message_id=message_id)))
            if number < attempts:
                lines.append(json.dumps(dict(event="retry_scheduled", node="N1", message_id=message_id, attempt=number + 1)))
    if result:
        lines.append(json.dumps(dict(event="delivery_result", node="N1", message_id=message_id, success=False,
                                     attempts=[dict(number=n, route=list(ROUTE)) for n in range(1, attempts + 1)])))
    return lines


def synthetic_run(tmp_path, outcomes, stage="pilot", seed=3):
    run = tmp_path / "data" / "measured" / "fair-retry" / "unit-run"
    plan = fair.prepare(run, repetitions=2, seed=seed, stage=stage)
    for index, spec in enumerate(plan["schedule"]):
        delivered = outcomes(spec)
        rows, log = [], []
        for p, d in enumerate(delivered):
            mid = f"m-{index}-{p}"
            attempts = 1 if d else 4
            timed_out = not d and spec["method"] == "fixed_retry"  # client deadline missed: no client-side attempts
            rows.append(dict(message_id=mid, position=p, delivered_observed=d, ack_received=d,
                             client_elapsed_ms=6010.0 if timed_out else 200.0 + p,
                             raw_response=None if timed_out else dict(attempts=[{}] * attempts)))
            log += n1_log_lines(mid, attempts)
        record = dict(protocol_version="fair_retry_v1", comparable=not (spec["condition"] == "restart" and spec["repetition"] == 1
                      and spec["fault_timing"] == "inflight" and spec["method"] == "exit_link"),
                      messages=rows, overhead=dict(framed_bytes_per_second=0 if spec["method"] == "fixed_retry" else 100.0))
        if not record["comparable"]:
            record["error"] = dict(type="schedule_deviation")
        folder = run / f"t{index:03}"
        (folder / "p").mkdir(parents=True)
        (folder / "p" / "N1-0.jsonl").write_text("\n".join(log) + "\n", encoding="utf-8")
        (folder / "trial.json").write_text(json.dumps(record), encoding="utf-8")
        plan["completed"][str(index)] = dict(sha256=hashlib.sha256((folder / "trial.json").read_bytes()).hexdigest(),
                                             comparable=record["comparable"])
    atomic_json(run / "plan.json", plan)
    return run


def tree_hashes(root):
    return {p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(Path(root).rglob("*")) if p.is_file()}


def single_failure_fixed_fails(spec):
    if spec["condition"] == "single_failure" and spec["method"] == "fixed_retry":
        return [False, False, False]
    if spec["condition"] == "no_route":
        return [False, False, False]
    return [True, True, True]


def test_analysis_pairs_blocks_excludes_both_sides_and_never_overwrites(tmp_path):
    import analyze_fair_retry as analysis
    run = synthetic_run(tmp_path, single_failure_fixed_fails)
    before = tree_hashes(run)
    summary, rows = analysis.analyze(run, tmp_path / "outputs" / "fair")
    assert tree_hashes(run) == before  # originals (plan, trial.json, node logs) untouched
    assert summary["planned_blocks"] == 16 and summary["excluded_blocks"] == 1 and summary["valid_blocks"] == 15
    overall = next(r for r in rows if r["scope"] == "overall" and r["metric"] == "delivered")
    assert overall["role"] == "primary" and overall["fixed_retry_n"] == overall["exit_link_n"] == 45
    single = next(r for r in rows if r["scope"] == "single_failure/before_send" and r["metric"] == "delivered")
    assert single["fixed_retry_success"] == 0 and single["exit_link_success"] == 6 and single["blocks_exit_better"] == 2
    sums = (tmp_path / "outputs" / "fair" / "OUTPUT_SHA256SUMS.txt").read_text(encoding="utf-8")
    assert "stats.csv" in sums and "summary.json" in sums
    with pytest.raises(FileExistsError):
        analysis.analyze(run, tmp_path / "outputs" / "fair")
    with pytest.raises(ValueError):
        analysis.analyze(run, run.parent / "inside")


def test_attempts_missing_at_client_deadline_are_recovered_from_n1_log(tmp_path):
    import analyze_fair_retry as analysis
    run = synthetic_run(tmp_path, single_failure_fixed_fails)
    summary, _ = analysis.analyze(run, tmp_path / "out")
    fixed = summary["attempts_per_message"]["fixed_retry"]
    assert fixed["unconfirmed"] == 0 and fixed["client_deadline_missed"] > 0  # client had no attempts for these
    assert fixed["distribution"]["4"] == fixed["client_deadline_missed"]      # N1 log supplies all 4 attempts
    assert "wilson_overall" not in summary and any("Wilson" in x for x in summary["not_reported"])


def write_cell_log(tmp_path, lines):
    cell = tmp_path / "cell"
    (cell / "p").mkdir(parents=True)
    (cell / "p" / "N1-0.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return cell


def test_attempt_counting_ignores_non_attempt_events_and_duplicate_lines(tmp_path):
    import analyze_fair_retry as analysis
    cell = write_cell_log(tmp_path, n1_log_lines("m", 3, duplicate_route=True))
    before = tree_hashes(cell)
    out = analysis.n1_attempts(cell, [dict(message_id="m", raw_response=None)])
    assert out["m"] == dict(attempts=3, status="confirmed", reason="n1_delivery_result")
    assert tree_hashes(cell) == before


@pytest.mark.parametrize("case, reason", [
    ("no_result", "no_delivery_result"),
    ("missing_attempt_event", "attempt_events_do_not_match_result"),
    ("conflicting_route_lines", "conflicting_attempt_events"),
    ("client_conflict", "client_result_conflicts_with_n1_log"),
    ("no_log", "n1_log_missing"),
])
def test_incomplete_or_conflicting_logs_stay_unconfirmed(tmp_path, case, reason):
    import analyze_fair_retry as analysis
    lines = n1_log_lines("m", 3, result=case != "no_result")
    raw = None
    if case == "missing_attempt_event":
        lines = [l for l in lines if '"attempt": 2' not in l or "route_" not in l]
    if case == "conflicting_route_lines":
        lines.insert(1, json.dumps(dict(event="route_selected", node="N1", message_id="m", route=["N1", "N3", "N4"], attempt=1)))
    if case == "client_conflict":
        raw = dict(attempts=[{}, {}])
    cell = write_cell_log(tmp_path, lines)
    if case == "no_log":
        (cell / "p" / "N1-0.jsonl").unlink()
    if case == "no_result":
        (cell / "p" / "N1-0.jsonl").write_bytes((cell / "p" / "N1-0.jsonl").read_bytes() + b'{"event": "deliv')  # torn tail
    out = analysis.n1_attempts(cell, [dict(message_id="m", raw_response=raw)])["m"]
    assert out["attempts"] is None and out["status"] == "unconfirmed" and out["reason"].startswith(reason)
    if case == "no_result":
        assert "malformed_lines=1" in out["reason"]


def test_zero_attempt_no_route_is_a_confirmed_zero(tmp_path):
    import analyze_fair_retry as analysis
    cell = write_cell_log(tmp_path, [json.dumps(dict(event="delivery_result", node="N1", message_id="m", attempts=[]))])
    assert analysis.n1_attempts(cell, [dict(message_id="m", raw_response=dict(attempts=[]))])["m"]["attempts"] == 0


def test_stratified_bootstrap_is_reproducible_and_resamples_within_strata():
    import analyze_fair_retry as analysis
    data = {"a": [1.0, 1.0, 0.0, 1.0], "b": [0.0, 1 / 3, 0.0, 0.0]}
    first, second = analysis.stratified_bootstrap(data, seed=5, draws=2000), analysis.stratified_bootstrap(data, seed=5, draws=2000)
    assert first == second and first["method"] == "stratified_block_percentile_bootstrap"
    assert analysis.stratified_bootstrap(data, seed=6, draws=2000)["lower"] is not None
    # Each stratum keeps its own block count in every draw: constant strata give a zero-width interval.
    fixed = analysis.stratified_bootstrap({"a": [1.0, 1.0], "b": [0.0, 0.0]}, seed=1, draws=500)
    assert fixed["lower"] == fixed["upper"] == fixed["estimate"] == .5 and fixed["zero_width_note"]
    assert analysis.stratified_bootstrap({"a": []}) is None


def test_primary_test_is_separate_from_the_holm_family(tmp_path):
    import analyze_fair_retry as analysis
    summary, rows = analysis.analyze(synthetic_run(tmp_path, single_failure_fixed_fails), tmp_path / "out")
    primary = [r for r in rows if r["role"] == "primary"]
    assert len(primary) == 1 and primary[0]["scope"] == "overall" and primary[0]["metric"] == "delivered"
    assert primary[0]["sign_test_p_holm"] == "not_applicable_primary" and primary[0]["multiplicity"] == "single_primary_test"
    family = [r for r in rows if r["metric"] == "delivered" and r["multiplicity"] == "holm_over_8_strata"]
    assert len(family) == 8 and all(isinstance(r["sign_test_p_holm"], float) for r in family)
    assert summary["primary"]["contrast"] == "exit_link - fixed_retry" and summary["primary"]["ci_method"].startswith("stratified")
    # synthetic outcomes are constant within each stratum -> zero-width interval must carry its caveat
    assert summary["primary"]["ci_low"] == summary["primary"]["ci_high"] and "not certainty" in summary["primary"]["ci_note"]


def test_pilot_summary_is_labelled_and_runs_are_never_pooled(tmp_path):
    import analyze_fair_retry as analysis
    summary, _ = analysis.analyze(synthetic_run(tmp_path, single_failure_fixed_fails), tmp_path / "out")
    assert summary["stage"] == "pilot" and summary["use"].startswith("PILOT")
    with pytest.raises(SystemExit):  # the CLI takes exactly one run folder
        sys_argv = sys.argv
        try:
            sys.argv = ["analyze_fair_retry.py", "a", "b", "--out", str(tmp_path / "x")]
            import runpy
            runpy.run_path(str(ROOT / "scripts" / "analyze_fair_retry.py"), run_name="__main__")
        finally:
            sys.argv = sys_argv


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


# ---------------------------------------------------------------- stages and seed
def test_main_stage_is_pinned_to_480_cells_and_the_registered_seed(tmp_path):
    plan = fair.prepare(tmp_path / "main", repetitions=fair.MAIN_REPETITIONS, seed=fair.MAIN_SEED, stage="main")
    assert len(plan["schedule"]) == 480 and plan["stage"] == "main" and plan["seed"] == 20261117 != fair.PILOT_SEED
    assert fair.validate(tmp_path / "main")["design_sha256"] == plan["design_sha256"]
    with pytest.raises(ValueError, match="pre-registered"):
        fair.prepare(tmp_path / "x", repetitions=30, seed=1, stage="main")
    with pytest.raises(ValueError, match="pre-registered"):
        fair.prepare(tmp_path / "y", repetitions=2, seed=fair.MAIN_SEED, stage="main")
    with pytest.raises(ValueError, match="main seed"):
        fair.prepare(tmp_path / "z", repetitions=2, seed=fair.MAIN_SEED, stage="pilot")


def test_design_document_is_pinned_in_the_plan(tmp_path):
    plan = fair.prepare(tmp_path / "run")
    assert "docs/fair-retry-main-study-design.md" in plan["source_sha256"]
    text = (ROOT / "docs/fair-retry-main-study-design.md").read_text(encoding="utf-8")
    for fixed in ("20261117", "480", "max_retries=3", "층화 블록 bootstrap", "--audit-interrupted"):
        assert fixed in text


def test_source_hash_keys_are_posix_relative_paths():
    hashes = fair.source_hashes()
    assert not [k for k in hashes if "\\" in k or k.startswith("/") or ":" in k]
    for key in ("docs/fair-retry-main-study-design.md", "scripts/prepare_fair_retry.py",
                "scripts/analyze_fair_retry.py", "src/exit_link/experiments/fair_retry.py"):
        assert hashes[key] == hashlib.sha256((ROOT / key).read_bytes()).hexdigest()


def test_windows_source_hash_keys_match_linux(monkeypatch):
    """Simulates Windows: the shared study.source_hashes() returns str(Path) keys with backslashes."""
    from pathlib import PureWindowsPath
    linux = fair.source_hashes()
    shared = fair.study.source_hashes()
    windows_shared = {k.replace("/", "\\"): v for k, v in shared.items()}
    assert any("\\" in k for k in windows_shared)
    monkeypatch.setattr(fair.study, "source_hashes", lambda: dict(windows_shared))
    original = fair.posix_keys
    monkeypatch.setattr(fair, "posix_keys", lambda hashes: original(hashes, sep="\\"))
    assert fair.source_hashes() == linux
    # the SCRIPTS half uses Path.as_posix(), which is "/" on Windows too
    assert PureWindowsPath("C:/repo/docs/fair-retry-main-study-design.md").relative_to("C:/repo").as_posix() \
        == "docs/fair-retry-main-study-design.md"
    with pytest.raises(ValueError, match="collide"):
        original({"a\\b": "1", "a/b": "2"}, sep="\\")


def test_plan_with_backslash_source_keys_is_rejected(tmp_path):
    """A plan written by the old str(Path) code on Windows would not validate silently."""
    fair.prepare(tmp_path / "run")
    fair.validate(tmp_path / "run")  # round trip with POSIX keys
    raw = json.loads((tmp_path / "run/plan.json").read_text(encoding="utf-8"))
    raw["source_sha256"] = {k.replace("/", "\\"): v for k, v in raw["source_sha256"].items()}
    raw["design_sha256"] = fair.design_hash(raw)
    atomic_json(tmp_path / "run/plan.json", raw)
    with pytest.raises(ValueError, match="Source/runtime changed"):
        fair.validate(tmp_path / "run")


def test_pre_stage_pilot_plans_stay_read_only(tmp_path):
    plan = fair.prepare(tmp_path / "old")
    raw = json.loads((tmp_path / "old/plan.json").read_text(encoding="utf-8"))
    raw.pop("stage")
    atomic_json(tmp_path / "old/plan.json", raw)
    with pytest.raises(ValueError, match="predates"):
        fair.validate(tmp_path / "old")
    assert plan["stage"] == "pilot"


# ---------------------------------------------------------------- interruption audit / resume
def fake_cell(folder, spec, *, interrupt=False):
    """Writes what a real cell writes (journal chain, node log, trial.json); no TCP."""
    from exit_link.experiments.journal import canonical
    folder = Path(folder)
    (folder / "p").mkdir(parents=True)
    (folder / "p" / "N1-0.jsonl").write_text(json.dumps(dict(event="node_started", node="N1")) + "\n", encoding="utf-8")
    body = dict(sequence=0, previous_sha256="0" * 64, record=dict(kind="intent", spec=spec))
    digest = hashlib.sha256(canonical(body)).hexdigest()
    (folder / "journal.jsonl").write_text(json.dumps(dict(body, sha256=digest)) + "\n", encoding="utf-8")
    if interrupt:
        raise RuntimeError("synthetic interruption after intents were journaled")
    from exit_link.experiments.journal import inspect_journal
    record = dict(status="completed", comparable=True, experiment_id=f"x-{folder.name}", messages=[],
                  journal_manifest=inspect_journal(folder / "journal.jsonl"),
                  cleanup=dict(normal_stop_confirmed=True, all_owned_processes_exited=True, ports=[dict(available=True)]))
    (folder / "trial.json").write_text(json.dumps(record), encoding="utf-8")
    return record


def free_ports(topology):
    return [dict(node=n.id, port=n.port, available=True) for n in topology.nodes]


def busy_ports(topology):
    return [dict(node=n.id, port=n.port, available=n.id != "N1") for n in topology.nodes]


def test_interrupted_cell_audit_exclude_and_resume(tmp_path, monkeypatch):
    root = tmp_path / "fair-retry"
    run = root / "pilot-unit"
    plan = fair.prepare(run, repetitions=2, seed=11)
    calls = []
    async def runner(directory, spec):
        calls.append(Path(directory).name)
        return fake_cell(directory, spec, interrupt=Path(directory).name == "t004")
    monkeypatch.setattr(fair, "trial", runner)

    # 1) run until the synthetic interruption in t004
    with pytest.raises(RuntimeError, match="synthetic interruption"):
        asyncio.run(fair.execute(run, 10))
    assert calls == ["t000", "t001", "t002", "t003", "t004"]
    lease = root / ".benchmark-owner.json"
    assert json.loads(lease.read_text(encoding="utf-8"))["state"] == "needs_audit"
    assert (root / ".benchmark.lock").exists()
    completed_before = {i: tree_hashes(run / f"t{i:03}") for i in range(4)}

    # 2) blocked until audited: no replay, no silent skip
    with pytest.raises(RuntimeError, match="Uncheckpointed cell"):
        fair.validate(run)
    with pytest.raises(RuntimeError):
        asyncio.run(fair.execute(run, 10))
    assert calls[-1] == "t004" and len(calls) == 5

    # 3) audit refuses while node ports are busy, without a reason, or for a checkpointed cell
    with pytest.raises(RuntimeError, match="ports"):
        fair.audit_interrupted(run, 4, "power loss", "tester", port_checker=busy_ports)
    with pytest.raises(ValueError):
        fair.audit_interrupted(run, 4, " ", "tester", port_checker=free_ports)
    with pytest.raises(ValueError, match="Checkpointed"):
        fair.audit_interrupted(run, 1, "x", "tester", port_checker=free_ports)
    assert not (run / "audit").exists()

    # 4) audit writes ONLY the audit log; originals keep their bytes
    protected = dict(plan=tree_hashes(run)["plan.json"], lease=hashlib.sha256(lease.read_bytes()).hexdigest(),
                     cell=tree_hashes(run / "t004"))
    batch = fair.audit_interrupted(run, 4, "synthetic interruption during unit test", "tester", port_checker=free_ports)
    partner = fair.pair_index(plan, 4)
    assert batch[0]["kind"] == "excluded_interrupted" and batch[0]["partner"]["index"] == partner
    assert "never scored" in batch[0]["outcome_judgment"] and "success" not in json.dumps(batch[0]["folder_snapshot"])
    assert tree_hashes(run)["plan.json"] == protected["plan"]
    assert hashlib.sha256(lease.read_bytes()).hexdigest() == protected["lease"]
    assert tree_hashes(run / "t004") == protected["cell"]
    with pytest.raises(ValueError, match="already audited"):
        fair.audit_interrupted(run, 4, "again", "tester", port_checker=free_ports)

    # 5) resume skips the audited cell (and its not-yet-run partner) and never reruns completed cells
    asyncio.run(fair.execute(run, 100))
    assert calls.count("t004") == 1 and all(calls.count(f"t{i:03}") == 1 for i in range(4))
    skipped = {4, partner} if partner > 4 else {4}
    assert not any(f"t{i:03}" in calls[5:] for i in skipped)
    for i in range(4):
        assert tree_hashes(run / f"t{i:03}") == completed_before[i]
    final = json.loads((run / "plan.json").read_text(encoding="utf-8"))
    assert final["status"] == "completed_with_exclusions"
    assert set(map(int, final["completed"])) | skipped == set(range(len(plan["schedule"])))
    assert json.loads(lease.read_text(encoding="utf-8"))["state"] == "clean"
    assert fair.validate(run)

    # 6) tampering with the audited folder afterwards is detected
    (run / "t004" / "p" / "N1-0.jsonl").write_text("edited\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match="changed after audit"):
        fair.validate(run)


def test_audit_log_is_hash_chained(tmp_path, monkeypatch):
    run = tmp_path / "fair-retry" / "pilot-chain"
    fair.prepare(run, repetitions=2, seed=12)
    async def runner(directory, spec):
        return fake_cell(directory, spec, interrupt=True)
    monkeypatch.setattr(fair, "trial", runner)
    with pytest.raises(RuntimeError):
        asyncio.run(fair.execute(run, 5))
    fair.audit_interrupted(run, 0, "unit", "tester", port_checker=free_ports)
    assert [r["kind"] for r in fair.read_audit(run)] == ["excluded_interrupted", "excluded_partner"]
    log = run / "audit" / "exclusions.jsonl"
    log.write_text(log.read_text(encoding="utf-8").replace("unit", "edit"), encoding="utf-8")
    with pytest.raises(RuntimeError, match="integrity"):
        fair.read_audit(run)


def test_lease_only_acknowledgement(tmp_path, monkeypatch):
    root = tmp_path / "fair-retry"
    run = root / "pilot-lease"
    fair.prepare(run, repetitions=2, seed=13)
    calls = []
    async def runner(directory, spec):
        calls.append(Path(directory).name)
        return fake_cell(directory, spec)
    monkeypatch.setattr(fair, "trial", runner)
    atomic_json(root / ".benchmark-owner.json", dict(state="needs_audit", run_directory=str(run.resolve()), updated_at="x"))
    assert not fair.lease_acknowledged(run, root / ".benchmark-owner.json")
    with pytest.raises(RuntimeError, match="Unclean previous run"):
        asyncio.run(fair.execute(run, 2))
    assert calls == []  # nothing ran while the unclean lease was unacknowledged
    fair.acknowledge_lease(run, "crash after checkpoint", "tester", port_checker=free_ports)
    assert fair.lease_acknowledged(run, root / ".benchmark-owner.json")
    asyncio.run(fair.execute(run, 2))
    assert calls == ["t000", "t001"]
    atomic_json(root / ".benchmark-owner.json", dict(state="needs_audit", run_directory=str(run.resolve()), updated_at="x2"))
    assert not fair.lease_acknowledged(run, root / ".benchmark-owner.json")
    atomic_json(root / ".benchmark-owner.json", dict(state="needs_audit", run_directory=str(run.resolve()), updated_at="y"))
    assert not fair.lease_acknowledged(run, root / ".benchmark-owner.json")  # a NEW unclean state needs a new audit


def test_analysis_excludes_audited_blocks_with_reason(tmp_path, monkeypatch):
    import analyze_fair_retry as analysis
    run = tmp_path / "fair-retry" / "pilot-an"
    plan = fair.prepare(run, repetitions=2, seed=14)
    async def runner(directory, spec):
        return fake_cell(directory, spec, interrupt=Path(directory).name == "t002")
    monkeypatch.setattr(fair, "trial", runner)
    with pytest.raises(RuntimeError):
        asyncio.run(fair.execute(run, 10))
    fair.audit_interrupted(run, 2, "unit", "tester", port_checker=free_ports)
    summary, _ = analysis.analyze(run, tmp_path / "out")
    assert summary["audited_exclusions"] == 2
    reasons = (tmp_path / "out" / "exclusions.csv").read_text(encoding="utf-8")
    assert "audited_excluded_interrupted" in reasons and "audited_excluded_partner" in reasons


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
