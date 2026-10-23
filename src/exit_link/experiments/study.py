"""Prepare an aligned main study without starting nodes. Explicit bounded execution."""
import hashlib
import json
import random
import platform
import sys
import importlib.metadata
from pathlib import Path
from uuid import uuid4

from exit_link.experiments.comparison import CONDITIONS, METHODS, now, trial
from exit_link.experiments.safety import ExecutionLock, atomic_json
from exit_link.topology.loader import load_communication


def source_hashes():
    root=Path(__file__).resolve().parents[3]
    files=list((root/'src/exit_link').rglob('*.py'))
    files.extend((root/'src/exit_link/data/simulation').glob('*.json'))
    files.extend(root/'scripts'/name for name in ('prepare_main_study.py','analyze_main_study.py','compare_network.py','check_main_plan.py'))
    files.extend(root/name for name in ('pyproject.toml','requirements.lock.txt'))
    return {str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(files)}


def design_hash(plan):
    keys=('schema_version','purpose','protocol_version','seed','repetitions','schedule','settings','source_sha256','topology')
    return hashlib.sha256(json.dumps({k:plan[k] for k in keys},sort_keys=True,separators=(',',':')).encode()).hexdigest()


def runtime_environment():
    return dict(python=sys.version,platform=platform.platform(),
        dependencies={name:importlib.metadata.version(name) for name in ('networkx','pydantic','pytest')})


def prepare(directory, repetitions=30, seed=20261022):
    if repetitions<2 or repetitions%2 or repetitions>100:
        raise ValueError('Use an even number of paired blocks, 2..100')
    directory=Path(directory)
    directory.mkdir(parents=True,exist_ok=False)
    strata=[(c,t) for c in CONDITIONS for t in (['none'] if c=='normal' else ['before_send'] if c=='no_route' else ['before_send','inflight'])]
    rng=random.Random(seed)
    first={s:rng.randrange(2) for s in strata}
    schedule=[]
    for repetition in range(repetitions):
        order=strata.copy(); rng.shuffle(order)
        for condition,timing in order:
            methods=list(METHODS)
            if (first[condition,timing]+repetition)%2:
                methods.reverse()
            for method in methods:
                schedule.append(dict(condition=condition,fault_timing=timing,method=method,repetition=repetition,
                                     warmup_extra_seconds=(repetition%3)*.033))
    plan=dict(schema_version='2.0',purpose='contest_main_study',run_id=str(uuid4()),prepared_at=now(),
        protocol_version='aligned_v2',status='prepared_not_executed',seed=seed,repetitions=repetitions,
        schedule=schedule,source_sha256=source_hashes(),settings=dict(client_timeout_seconds=6,observation_window_seconds=9,
        secondary_fault_or_restart_seconds=1,send_offsets_seconds=[.05,.8,2.5],inflight_followup_seconds=[.8,2.5],
        scheduling_tolerance_ms=100,payload_bytes=256,ttl=16,relay_delay_seconds=.2,
        fixed_retries=0,exit_link_max_retries=3),completed={})
    plan['environment']=runtime_environment()
    plan['topology']=load_communication().model_dump(mode='json')
    plan['settings'].update(probe_interval_seconds=.1,probe_timeout_seconds=.15,failure_threshold=2,
                            recovery_threshold=2,state_ttl_seconds=3,warmup_seconds=.6,node_hop_timeout_seconds=1.5)
    plan['design_sha256']=design_hash(plan)
    atomic_json(directory/'plan.json',plan)
    return plan


async def execute(directory, max_cells, lock_directory=None):
    """Resume only confirmed cell boundaries. Abandoned cells require human audit."""
    directory=Path(directory).resolve()
    if not 1<=max_cells<=1600:
        raise ValueError('Explicit max_cells must be 1..1600')
    plan=json.loads((directory/'plan.json').read_text(encoding='utf-8'))
    if plan['purpose']!='contest_main_study' or plan['protocol_version']!='aligned_v2':
        raise ValueError('Not an aligned main-study plan')
    if plan['design_sha256']!=design_hash(plan):
        raise ValueError('Prepared design was modified')
    if source_hashes()!=plan['source_sha256']:
        raise ValueError('Source changed after plan preparation; prepare a new run')
    if plan['environment']!=runtime_environment():
        raise ValueError('Runtime changed after plan preparation; prepare a new run')
    lock_root=Path(lock_directory) if lock_directory else directory.parent
    with ExecutionLock(lock_root):
        lease=lock_root/'.benchmark-owner.json'
        if lease.exists() and json.loads(lease.read_text(encoding='utf-8'))['state']!='clean':
            raise RuntimeError('Unclean previous run: inspect owned processes and ports; never terminate disk PIDs automatically')
        # Verify existing checkpoints against the on-disk completed cell, never overwrite it.
        for index,spec in enumerate(plan['schedule']):
            cell_path=directory/f't{index:03}'/'trial.json'
            checkpoint=plan['completed'].get(str(index))
            if checkpoint:
                if not cell_path.exists() or hashlib.sha256(cell_path.read_bytes()).hexdigest()!=checkpoint['sha256']:
                    raise RuntimeError('Completed cell missing or modified')
            elif cell_path.parent.exists():
                raise RuntimeError('Uncheckpointed cell exists: retain it and audit cleanup before preparing replacement')
        atomic_json(lease,dict(state='active',run_directory=str(directory),updated_at=now()))
        executed=0
        clean=True
        try:
            plan['status']='running'
            atomic_json(directory/'plan.json',plan)
            for index,spec in enumerate(plan['schedule']):
                if str(index) in plan['completed']:
                    continue
                cell=await trial(directory/f't{index:03}',spec,aligned=True)
                cleanup=cell['cleanup']
                clean=bool(cleanup.get('normal_stop_confirmed') and cleanup.get('all_owned_processes_exited')
                           and all(p['available'] for p in cleanup.get('ports',[])))
                file=directory/f't{index:03}'/'trial.json'
                plan['completed'][str(index)]=dict(experiment_id=cell['experiment_id'],comparable=cell['comparable'],
                    sha256=hashlib.sha256(file.read_bytes()).hexdigest())
                executed+=1
                plan['status']='paused_at_cell_boundary'
                atomic_json(directory/'plan.json',plan)
                if not cell['comparable'] or not clean or executed>=max_cells:
                    break
            if len(plan['completed'])==len(plan['schedule']):
                plan['status']='completed' if all(c['comparable'] for c in plan['completed'].values()) else 'completed_with_exclusions'
            atomic_json(directory/'plan.json',plan)
        except BaseException:
            clean=False  # Crash/cancel requires an audit even when best-effort cell cleanup ran.
            raise
        finally:
            atomic_json(lease,dict(state='clean' if clean else 'needs_audit',run_directory=str(directory),updated_at=now()))
    return plan
