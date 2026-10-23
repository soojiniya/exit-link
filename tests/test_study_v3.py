"""v3 unit validation artifacts are never contest measurements."""
import asyncio
import hashlib
import json
import os
import subprocess
import sys
import threading
import time
from collections import Counter, defaultdict
from types import SimpleNamespace

import pytest

from exit_link.experiments import aligned_v3 as engine
from exit_link.experiments import study_v3 as study
from exit_link.experiments.journal import DurableJournal, inspect_journal
from exit_link.experiments.safety import atomic_json


def test_v3_plan_balances_every_stratum_and_preserves_tolerance(tmp_path):
    plan = study.prepare(tmp_path/'plan')
    assert plan['protocol_version'] == 'aligned_v3'
    assert len(plan['schedule']) == 480 and plan['completed'] == {}
    pairs = defaultdict(list)
    for s in plan['schedule']:
        pairs[s['condition'], s['fault_timing'], s['repetition']].append(s)
    assert len(pairs) == 240
    assert len({k[:2] for k in pairs}) == 8
    starts = Counter()
    for key, specs in pairs.items():
        assert {s['method'] for s in specs} == {'fixed', 'exit_link'}
        assert len({s['warmup_extra_seconds'] for s in specs}) == 1
        starts[key[:2], specs[0]['method']] += 1
    assert set(starts.values()) == {15}
    assert study.validate(tmp_path/'plan')['settings']['scheduling_tolerance_ms'] == 100
    assert not list((tmp_path/'plan').glob('t[0-9]*'))


def test_v3_rejects_legacy_without_creating_any_files(tmp_path):
    from exit_link.experiments.study import prepare
    prepare(tmp_path/'legacy', 2)
    before = {str(p): p.read_bytes() for p in (tmp_path/'legacy').rglob('*') if p.is_file()}
    with pytest.raises(ValueError, match='legacy'):
        study.validate(tmp_path/'legacy')
    after = {str(p): p.read_bytes() for p in (tmp_path/'legacy').rglob('*') if p.is_file()}
    assert before == after


def test_v3_rejects_resigned_changed_response_limit(tmp_path):
    from exit_link.experiments.study import design_hash
    p = study.prepare(tmp_path/'p', 2)
    p['settings']['client_timeout_seconds'] = 99
    p['design_sha256'] = design_hash(p)
    atomic_json(tmp_path/'p/plan.json', p)
    with pytest.raises(ValueError, match='policy'):
        study.validate(tmp_path/'p')


@pytest.mark.parametrize('mutation', ['duplicate', 'nonadjacent', 'unequal_warmup'])
def test_v3_rejects_resigned_unfair_schedule(tmp_path, mutation):
    from exit_link.experiments.study import design_hash
    p = study.prepare(tmp_path/'p', 2)
    if mutation == 'duplicate':
        p['schedule'][1] = dict(p['schedule'][0])
    elif mutation == 'nonadjacent':
        p['schedule'][1], p['schedule'][2] = p['schedule'][2], p['schedule'][1]
    else:
        p['schedule'][1]['warmup_extra_seconds'] += .1
    p['design_sha256'] = design_hash(p)
    atomic_json(tmp_path/'p/plan.json', p)
    with pytest.raises(ValueError, match='schedule'):
        study.validate(tmp_path/'p')


def test_v3_incomplete_cell_blocks_replay(tmp_path):
    study.prepare(tmp_path/'p', 2)
    (tmp_path/'p/t000').mkdir()
    (tmp_path/'p/t000/journal.jsonl').write_bytes(b'{"partial":')
    with pytest.raises(RuntimeError, match='Uncheckpointed'):
        study.validate(tmp_path/'p')
    assert (tmp_path/'p/t000/journal.jsonl').read_bytes() == b'{"partial":'


def write_fixture_cell(folder):
    folder.mkdir()
    writer = DurableJournal(folder)
    try:
        writer._append(dict(kind='unit_fixture', id='fixed-unit-id'))
    finally:
        writer.executor.shutdown()
    return inspect_journal(folder/'journal.jsonl')


@pytest.mark.parametrize('mutation', ['tail', 'content', 'sequence'])
def test_journal_detects_damage_without_repair(tmp_path, mutation):
    write_fixture_cell(tmp_path/'cell')
    p = tmp_path/'cell/journal.jsonl'
    if mutation == 'tail':
        damaged = p.read_bytes()[:-1]
    else:
        e = json.loads(p.read_bytes())
        if mutation == 'content':
            e['record']['id'] = 'changed'
        else:
            e['sequence'] = 7
        damaged = json.dumps(e).encode()+b'\n'
    p.write_bytes(damaged)
    with pytest.raises(ValueError):
        inspect_journal(p)
    assert p.read_bytes() == damaged


def test_journal_fsync_survives_abrupt_process_exit(tmp_path):
    code = ('from exit_link.experiments.journal import DurableJournal; import os,sys; '
            'w=DurableJournal(sys.argv[1]); w._append({"kind":"unit_crash_fixture"}); os._exit(23)')
    result = subprocess.run([sys.executable, '-c', code, str(tmp_path)], capture_output=True, timeout=10)
    assert result.returncode == 23, result.stderr
    assert inspect_journal(tmp_path/'journal.jsonl')['entries'] == 1


def test_committed_journal_and_trial_hashes_both_guard_resume(tmp_path):
    p = study.prepare(tmp_path/'p', 2)
    folder = tmp_path/'p/t000'
    manifest = write_fixture_cell(folder)
    atomic_json(folder/'trial.json', dict(unit_fixture=True))
    p['completed']['0'] = dict(sha256=hashlib.sha256((folder/'trial.json').read_bytes()).hexdigest(), journal_manifest=manifest)
    atomic_json(tmp_path/'p/plan.json', p)
    assert len(study.validate(tmp_path/'p')['completed']) == 1
    with (folder/'journal.jsonl').open('ab') as stream:
        stream.write(b'{')
    with pytest.raises(ValueError, match='Torn'):
        study.validate(tmp_path/'p')


def test_worker_disk_wait_does_not_occupy_calling_thread(tmp_path, monkeypatch):
    writer = DurableJournal(tmp_path)
    entered, release = threading.Event(), threading.Event()
    main_thread = threading.get_ident()
    def slow_fsync(fd):
        assert threading.get_ident() != main_thread
        entered.set()
        assert release.wait(3)
    monkeypatch.setattr(os, 'fsync', slow_fsync)
    try:
        future = writer.executor.submit(writer._append, dict(kind='unit_slow_disk'))
        assert entered.wait(2)
        assert not future.done()
        # Main thread keeps running while the fsync worker is deliberately held.
        release.set()
        assert future.result(timeout=2)['sequence'] == 0
    finally:
        release.set()
        writer.executor.shutdown()
    assert inspect_journal(writer.path)['entries'] == 1


def test_v3_analysis_cannot_write_a_legacy_directory(tmp_path):
    from exit_link.experiments.study import prepare
    from scripts.analyze_main_study import analyze
    prepare(tmp_path/'legacy', 2)
    with pytest.raises(ValueError, match='aligned_v3'):
        analyze(tmp_path/'legacy', expected_protocol='aligned_v3')
    assert not (tmp_path/'legacy/main-analysis.json').exists()


@pytest.mark.parametrize('damage', ['timing', 'journal'])
def test_v3_analysis_keeps_raw_failures_and_excludes_both_sides_of_invalid_pairs(tmp_path, damage):
    from scripts.analyze_main_study import analyze
    p = study.prepare(tmp_path/'p', 2)
    for i, spec in enumerate(p['schedule'][:2]):
        folder = tmp_path/'p'/f't{i:03}'
        manifest = write_fixture_cell(folder)
        success = spec['method'] == 'exit_link'
        cell = dict(**spec, protocol_version='aligned_v3', experiment_id=f'unit-{i}', status='completed', comparable=True,
                    messages=[dict(scheduled_perf_ns=j, message_id=f'unit-{i}-{j}', ack_received=success,
                        delivered_observed=success, client_elapsed_ms=1, error=None if success else 'no_route') for j in range(3)],
                    faults=[], detection_observations=[], overhead={})
        atomic_json(folder/'trial.json', cell)
        p['completed'][str(i)] = dict(sha256=hashlib.sha256((folder/'trial.json').read_bytes()).hexdigest(), journal_manifest=manifest)
    atomic_json(tmp_path/'p/plan.json', p)
    valid = analyze(tmp_path/'p', expected_protocol='aligned_v3')
    assert valid['protocol_version'] == 'aligned_v3'
    for pos in valid['position_statistics']:
        assert pos['independent_pairs'] == 1
        assert pos['methods']['fixed']['delivery']['successes'] == 0
        assert pos['methods']['fixed']['delivery']['n'] == 1
        assert pos['methods']['exit_link']['delivery']['successes'] == 1
    if damage == 'timing':
        cell_path = tmp_path/'p/t000/trial.json'
        late = json.loads(cell_path.read_bytes())
        late.update(comparable=False, error=dict(type='schedule_deviation'))
        atomic_json(cell_path, late)
        p['completed']['0']['sha256'] = hashlib.sha256(cell_path.read_bytes()).hexdigest()
        atomic_json(tmp_path/'p/plan.json', p)
    else:
        with (tmp_path/'p/t000/journal.jsonl').open('ab') as f:
            f.write(b'{')
    excluded = analyze(tmp_path/'p', expected_protocol='aligned_v3')
    assert excluded['position_statistics'] == []
    assert any(e['reason'] == 'unmatched_pair' for e in excluded['exclusions'])
    assert len((tmp_path/'p/main-messages.csv').read_text(encoding='utf-8-sig').splitlines()) == 7


@pytest.mark.parametrize('lateness', [100.001, -100.001])
def test_v3_never_accepts_out_of_tolerance_inputs(lateness):
    r = dict(messages=[dict(scheduling_lateness_ms=lateness)], scheduled_actions=[], faults=[], observation_end_lateness_ms=0)
    assert not engine.timing_valid(r)


@pytest.mark.parametrize('invalid', ['id', 'route', 'source', 'type'])
def test_experiment_client_still_rejects_uncorrelated_ack(invalid):
    request = engine.protocol.Message(source='N1', destination='N4', payload='unit', route=engine.ROUTE)
    fields = dict(message_id=request.message_id, source='N4', destination='N1', route=engine.ROUTE)
    if invalid == 'id':
        from uuid import uuid4
        fields['message_id'] = uuid4()
    elif invalid == 'route':
        fields['route'] = ['N1', 'N3', 'N4']
    elif invalid == 'source':
        fields['source'] = 'N2'
    response = engine.protocol.StatusResponse(node='N1', enabled=False) if invalid == 'type' else engine.protocol.Ack(**fields)
    with pytest.raises(engine.protocol.ProtocolError):
        engine.validate_response(request, response)


def test_experiment_client_distinguishes_ack_and_genuine_delivery_failure():
    request = engine.protocol.Message(source='N1', destination='N4', payload='unit', route=engine.ROUTE)
    ack = engine.protocol.Ack(message_id=request.message_id, source='N4', destination='N1', route=engine.ROUTE)
    assert engine.validate_response(request, ack) is ack
    error = engine.protocol.ErrorResponse(message_id=request.message_id, node='N1', code='connection_failed', detail='unit')
    assert engine.validate_response(request, error) is None


def test_async_slow_journal_keeps_timer_responsive_and_records_real_completion(tmp_path, monkeypatch):
    original = DurableJournal._append
    def slow(self, record):
        time.sleep(.4)
        return original(self, record)
    monkeypatch.setattr(DurableJournal, '_append', slow)
    async def run():
        writer = DurableJournal(tmp_path)
        try:
            payload = dict(kind='unit_only', value=1)
            began = time.perf_counter_ns()
            future = writer.submit(payload)
            payload['value'] = 9
            await engine.at(began + 50_000_000)
            assert (time.perf_counter_ns()-began)/1e6 < 150
            assert not future.done()
            receipt = await future
            assert receipt['recording_completed_perf_ns']-began >= 400_000_000
        finally:
            await writer.close()
    asyncio.run(run())
    assert json.loads((tmp_path/'journal.jsonl').read_bytes())['record']['value'] == 1


def test_async_queue_overflow_and_storage_failure_are_not_success(tmp_path, monkeypatch):
    async def run():
        writer = DurableJournal(tmp_path, capacity=1)
        entered, release = threading.Event(), threading.Event()
        def fail(record):
            entered.set()
            release.wait(2)
            raise OSError('unit disk full')
        monkeypatch.setattr(writer, '_append', fail)
        future = writer.submit(dict(kind='unit'))
        try:
            with pytest.raises(RuntimeError, match='capacity'):
                writer.submit(dict(kind='never_dropped_silently'))
            release.set()
            with pytest.raises(OSError, match='disk full'):
                await future
            await asyncio.sleep(0)
            with pytest.raises(RuntimeError, match='recording failed'):
                writer.check()
        finally:
            release.set()
            with pytest.raises((RuntimeError, OSError)):
                await writer.close()
    asyncio.run(run())


def test_async_cancelled_commit_finishes_before_shutdown(tmp_path, monkeypatch):
    original = DurableJournal._append
    def slow(self, record):
        time.sleep(.2)
        return original(self, record)
    monkeypatch.setattr(DurableJournal, '_append', slow)
    async def run():
        writer = DurableJournal(tmp_path)
        task = asyncio.create_task(writer.commit(dict(kind='cancelled_unit_fixture')))
        await asyncio.sleep(.05)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await writer.close()
    asyncio.run(run())
    assert inspect_journal(tmp_path/'journal.jsonl')['entries'] == 1


def test_async_resume_preserves_completed_cell_and_blocks_unsafe_lease(tmp_path, monkeypatch):
    calls = []
    async def fixture_trial(folder, spec):
        calls.append(folder.name)
        manifest = await asyncio.to_thread(write_fixture_cell, folder)
        cell = dict(experiment_id='unit-'+folder.name, status='completed', comparable=True, journal_manifest=manifest,
                    cleanup=dict(normal_stop_confirmed=True, all_owned_processes_exited=True, ports=[dict(available=True)]))
        await asyncio.to_thread(atomic_json, folder/'trial.json', cell)
        return cell
    monkeypatch.setattr(study, 'trial', fixture_trial)
    study.prepare(tmp_path/'p', 2)
    asyncio.run(study.execute(tmp_path/'p', 1, tmp_path/'locks'))
    saved = (tmp_path/'p/t000/trial.json').read_bytes()
    p = asyncio.run(study.execute(tmp_path/'p', 1, tmp_path/'locks'))
    assert len(p['completed']) == 2 and calls == ['t000', 't001']
    assert (tmp_path/'p/t000/trial.json').read_bytes() == saved
    atomic_json(tmp_path/'locks/.benchmark-owner.json', dict(state='needs_audit'))
    with pytest.raises(RuntimeError, match='Unclean'):
        asyncio.run(study.execute(tmp_path/'p', 1, tmp_path/'locks'))


@pytest.mark.parametrize('method', ['fixed', 'exit_link'])
def test_async_full_timetable_survives_slow_fault_recording(tmp_path, monkeypatch, method):
    """Synthetic transport fixture, not actual TCP performance evidence."""
    from exit_link.topology.loader import load_communication
    events = []
    original = DurableJournal._append
    def slow(self, record):
        if record.get('kind') == 'fault':
            time.sleep(1.2)
        return original(self, record)
    class FixtureCluster:
        def __init__(self, *args):
            self.topology = load_communication()
            self.processes = {}
            self.history = []
        def start_all(self): pass
        async def wait_ready(self): pass
        def kill(self, node): return dict(unit_fixture=True)
        def start(self, node):
            events.append(dict(node=node, event='node_started', benchmark_perf_ns=time.perf_counter_ns()))
        def records(self, node, event=None, message_id=None):
            return [e for e in events if e['node'] == node and e['event'] == event]
        async def close(self): pass
    async def status(*args): return SimpleNamespace(enabled=False)
    async def exchange(config, request, row):
        row['tcp_request_start_perf_ns'] = time.perf_counter_ns()
        row['dispatch_perf_ns'] = row['tcp_request_start_perf_ns']
        row['scheduling_lateness_ms'] = (row['dispatch_perf_ns']-row['scheduled_perf_ns'])/1e6
        error = engine.protocol.ErrorResponse(message_id=request.message_id, node='N1', code='unit_fixture_failure', detail='synthetic')
        if method == 'fixed': return error
        return engine.protocol.DeliveryResult(message_id=request.message_id, source='N1', destination='N4', success=False,
            error=error, attempts=[], retries=0, ttl_remaining=16, elapsed_ms=0, route_calculation_ms=0)
    monkeypatch.setattr(DurableJournal, '_append', slow)
    monkeypatch.setattr(engine, 'BenchmarkCluster', FixtureCluster)
    monkeypatch.setattr(engine, 'get_status', status)
    monkeypatch.setattr(engine, 'exchange_measured', exchange)
    monkeypatch.setattr(engine, 'check_ports', lambda t: [dict(available=True)])
    monkeypatch.setattr(engine, 'all_events', lambda cluster: events)
    cell = asyncio.run(engine.trial(tmp_path/'cell', dict(condition='restart', fault_timing='before_send', method=method, repetition=0)))
    assert cell['status'] == 'completed' and cell['comparable'], cell
    assert len(cell['messages']) == 3 and all(not m['ack_received'] for m in cell['messages'])
    assert cell['scheduled_actions'][0]['lateness_ms'] < 100
    assert cell['observation_end_lateness_ms'] < 100
    for m in cell['messages']:
        assert m['intent_recording_completed_perf_ns'] < cell['window_start_perf_ns']
        assert m['scheduling_lateness_ms'] < 100
    assert inspect_journal(tmp_path/'cell/journal.jsonl') == cell['journal_manifest']


@pytest.mark.parametrize('method', ['fixed', 'exit_link'])
def test_real_v3_restart_rehearsal_uses_actual_tcp_and_cleans_up(tmp_path, method):
    cell = asyncio.run(engine.trial(tmp_path/'real', dict(condition='restart', fault_timing='before_send', method=method, repetition=0)))
    assert cell['status'] == 'completed' and cell['comparable'], cell
    assert len(cell['messages']) == 3
    assert next(m for m in cell['messages'] if m['position'] == 2)['ack_received']
    assert cell['restart']['node_ready_perf_ns'] <= cell['restart']['observed_ready_perf_ns']
    assert cell['cleanup']['normal_stop_confirmed'] and cell['cleanup']['all_owned_processes_exited']
    assert all(p['available'] for p in cell['cleanup']['ports'])
    assert inspect_journal(tmp_path/'real/journal.jsonl') == cell['journal_manifest']
