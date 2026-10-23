import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from exit_link.experiments.comparison import trial, arrival_observation
from exit_link.experiments.inference import wilson, paired_interval
from exit_link.experiments.safety import ExecutionLock, atomic_json
from exit_link.experiments.study import prepare, execute


def test_plan_preparation_is_balanced_and_starts_no_processes(tmp_path):
    plan=prepare(tmp_path/'plan')
    assert plan['status']=='prepared_not_executed' and len(plan['schedule'])==480
    assert plan['completed']=={} and not list((tmp_path/'plan').glob('t*'))
    strata={(s['condition'],s['fault_timing']) for s in plan['schedule']}
    assert len(strata)==8
    for condition,timing in strata:
        first=[next(s for s in plan['schedule'] if s['condition']==condition and s['fault_timing']==timing and s['repetition']==r)['method'] for r in range(30)]
        assert first.count('fixed')==first.count('exit_link')==15


def test_readonly_plan_checker_verifies_full_profile_and_json_hashes(tmp_path):
    from scripts.check_main_plan import check
    plan=prepare(tmp_path/'p')
    result=check(tmp_path/'p')
    assert result['status']=='passed' and all(result['checks'].values())
    assert result['planned_cells']==480 and result['planned_messages']==1440
    assert result['completed_cells']==result['existing_cell_directories']==0
    assert all(n==60 for n in result['strata_counts'].values())
    assert any(p.endswith('.json') for p in plan['source_sha256'])
    assert len(plan['topology']['nodes'])==6


def test_readonly_plan_checker_rejects_a_resigned_but_wrong_timeout(tmp_path):
    from scripts.check_main_plan import check
    from exit_link.experiments.study import design_hash
    plan=prepare(tmp_path/'p')
    plan['settings']['client_timeout_seconds']=99
    plan['design_sha256']=design_hash(plan)
    atomic_json(tmp_path/'p/plan.json',plan)
    result=check(tmp_path/'p')
    assert result['checks']['design_hash'] and not result['checks']['profile']
    assert result['status']=='failed'


def test_execution_lock_excludes_another_process_and_releases(tmp_path):
    code="from exit_link.experiments.safety import ExecutionLock; import sys;\ntry:\n with ExecutionLock(sys.argv[1]): pass\nexcept RuntimeError: sys.exit(31)"
    env=dict(os.environ)
    exe=sys.executable
    if os.name=='nt' and sys.prefix!=sys.base_prefix:
        exe=sys._base_executable; env['__PYVENV_LAUNCHER__']=sys.executable
    with ExecutionLock(tmp_path):
        blocked=subprocess.run([exe,'-c',code,str(tmp_path)],env=env,capture_output=True,timeout=10)
        assert blocked.returncode==31,blocked.stderr
    released=subprocess.run([exe,'-c',code,str(tmp_path)],env=env,capture_output=True,timeout=10)
    assert released.returncode==0,released.stderr


def test_committed_checkpoint_survives_abrupt_writer_exit(tmp_path):
    code="from exit_link.experiments.safety import atomic_json; import os,sys; atomic_json(sys.argv[1],{'state':'completed','fixture':'unit'}); os._exit(23)"
    result=subprocess.run([sys.executable,'-c',code,str(tmp_path/'completed.json')],capture_output=True,timeout=10)
    assert result.returncode==23
    assert json.loads((tmp_path/'completed.json').read_text(encoding='utf-8'))['state']=='completed'


def test_wilson_limits_and_degenerate_bootstrap_are_not_certainty():
    assert wilson(0,0) is None
    assert wilson(30,30)['lower']==pytest.approx(.8864866,abs=1e-6)
    assert wilson(0,30)['upper']==pytest.approx(.1135134,abs=1e-6)
    assert wilson(2,2)['lower']<.35
    assert paired_interval([(0,1),(0,1)])['boundary_warning']
    assert paired_interval([(0,1)])['lower'] is None


def test_invalid_serialization_preserves_previous_checkpoint(tmp_path):
    path=tmp_path/'state.json'
    atomic_json(path,dict(committed=1))
    with pytest.raises(ValueError):
        atomic_json(path,dict(committed=float('nan')))
    assert json.loads(path.read_text(encoding='utf-8'))==dict(committed=1)


def test_late_arrival_is_preserved_but_does_not_count_as_on_time_delivery():
    events=[dict(node='N4',event='received',message_id='fixture',benchmark_perf_ns=11)]
    observed=arrival_observation(events,'fixture',cutoff=10)
    assert not observed['delivered_observed'] and observed['received_after_window_count']==1
    assert observed['destination_received_count']==1
    assert arrival_observation(events,'fixture')['delivered_observed']


def test_both_clients_share_one_overall_six_second_response_limit(monkeypatch):
    from exit_link.experiments.comparison import response_with_limit
    seen=[]
    async def fake_wait_for(operation,timeout):
        seen.append(timeout)
        return await operation
    async def fake_response():
        return 'synthetic-response'
    monkeypatch.setattr(asyncio,'wait_for',fake_wait_for)
    assert asyncio.run(response_with_limit(fake_response()))=='synthetic-response'
    assert seen==[6]


def test_modified_prepared_settings_are_refused_without_execution(tmp_path):
    plan=prepare(tmp_path/'p',2)
    plan['settings']['client_timeout_seconds']=99
    atomic_json(tmp_path/'p/plan.json',plan)
    with pytest.raises(ValueError,match='design was modified'):
        asyncio.run(execute(tmp_path/'p',1,tmp_path/'lock'))
    assert not list((tmp_path/'p').glob('t*'))


def test_main_analysis_matches_pairs_and_keeps_failure_denominator(tmp_path):
    import hashlib
    from scripts.analyze_main_study import analyze
    plan=prepare(tmp_path/'plan',2)
    for index,spec in enumerate(plan['schedule'][:2]):
        folder=tmp_path/'plan'/f't{index:03}'
        folder.mkdir()
        success=spec['method']=='exit_link'
        rows=[dict(message_id=str(p),scheduled_perf_ns=p+1,ack_received=success,delivered_observed=success,
            error=None if success else 'no_route',client_elapsed_ms=5) for p in range(3)]
        cell=dict(**spec,experiment_id=f'unit-{index}',status='completed',comparable=True,messages=rows,
                  faults=[],overhead={},detection_observations=[])
        atomic_json(folder/'trial.json',cell)
        plan['completed'][str(index)]=dict(sha256=hashlib.sha256((folder/'trial.json').read_bytes()).hexdigest())
    atomic_json(tmp_path/'plan/plan.json',plan)
    report=analyze(tmp_path/'plan')
    assert len(report['position_statistics'])==3
    for position in report['position_statistics']:
        assert position['methods']['fixed']['delivery']['n']==1
        assert position['methods']['fixed']['delivery']['estimate']==0
        assert position['methods']['exit_link']['delivery']['estimate']==1
        assert position['paired_delivery_difference']['lower'] is None

    # A completed but late cell remains in raw outputs, separate from genuine
    # no_route failures in the other cell; it cannot enter matched-pair estimates.
    path=tmp_path/'plan/t000/trial.json'
    late=json.loads(path.read_text(encoding='utf-8'))
    late.update(comparable=False,error=dict(type='schedule_deviation'))
    atomic_json(path,late)
    plan['completed']['0']['sha256']=hashlib.sha256(path.read_bytes()).hexdigest()
    atomic_json(tmp_path/'plan/plan.json',plan)
    excluded=analyze(tmp_path/'plan')
    assert any(e['reason']=='timing_excluded' for e in excluded['exclusions'])
    assert excluded['position_statistics']==[]
    import csv
    rows=list(csv.DictReader((tmp_path/'plan/main-messages.csv').open(encoding='utf-8-sig')))
    assert len(rows)==6 and any(r['error']=='no_route' for r in rows)
    assert any(r['cell_exclusion_reason']=='timing_excluded' for r in rows)


def test_resume_keeps_completed_cells_and_refuses_unaudited_lease(tmp_path,monkeypatch):
    import exit_link.experiments.study as module
    calls=[]
    async def fake_trial(path,spec,aligned):
        calls.append(str(path))
        path.mkdir()
        cell=dict(experiment_id='synthetic-unit',comparable=True,cleanup=dict(normal_stop_confirmed=True,
                  all_owned_processes_exited=True,ports=[dict(available=True)]))
        atomic_json(path/'trial.json',cell)
        return cell
    monkeypatch.setattr(module,'trial',fake_trial)
    prepare(tmp_path/'p',2)
    first=asyncio.run(execute(tmp_path/'p',1,tmp_path/'locks'))
    checkpoint=(tmp_path/'p/t000/trial.json').read_bytes()
    second=asyncio.run(execute(tmp_path/'p',1,tmp_path/'locks'))
    assert len(first['completed'])==1 and len(second['completed'])==2 and len(calls)==2
    assert (tmp_path/'p/t000/trial.json').read_bytes()==checkpoint
    atomic_json(tmp_path/'locks/.benchmark-owner.json',dict(state='needs_audit'))
    with pytest.raises(RuntimeError,match='Unclean'):
        asyncio.run(execute(tmp_path/'p',1,tmp_path/'locks'))


@pytest.mark.parametrize('method',['fixed','exit_link'])
def test_small_aligned_restart_cell_uses_common_clock_and_cleans_up(tmp_path,method):
    cell=asyncio.run(trial(tmp_path/'v2',dict(condition='restart',fault_timing='inflight',method=method,repetition=0),aligned=True))
    assert cell['status']=='completed' and cell['comparable'],cell.get('error')
    anchor=cell['schedule_anchor_perf_ns']
    assert cell['scheduled_actions'][0]['scheduled_perf_ns']==anchor+1_000_000_000
    followups=sorted(r['scheduled_perf_ns']-anchor for r in cell['messages'] if r['phase']!='inflight_fault')
    assert followups==[800_000_000,2_500_000_000]
    assert len(cell['messages'])==3
    assert cell['cleanup']['all_owned_processes_exited'] and all(p['available'] for p in cell['cleanup']['ports'])
    assert (tmp_path/'v2/message-intents.jsonl').read_text(encoding='utf-8').count('\n')==3
