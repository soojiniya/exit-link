"""All parent histories, approvals, hosts and runner results here are unit fixtures."""
import asyncio
import json
import shutil
import subprocess
from types import SimpleNamespace
from pathlib import Path

import pytest

from scripts import recovery_v3 as recovery
from exit_link.experiments.journal import DurableJournal, inspect_journal
from exit_link.experiments.safety import atomic_json
from exit_link.experiments.study_v3 import prepare as prepare_original


def host(_ports):
    return dict(status='observed', ready=True, nodes=[], listeners=[], observation_origin='unit_fixture')


def fake_cell(folder, spec, index, *, status='completed', comparable=True, normal=True):
    folder.mkdir(parents=True)
    writer=DurableJournal(folder)
    try:writer._append(dict(kind='unit_fixture', index=index))
    finally:writer.executor.shutdown()
    manifest=inspect_journal(folder/'journal.jsonl')
    cell=dict(**spec, protocol_version='aligned_v3', status=status, comparable=comparable,
        experiment_id=f'unit-{index}', journal_manifest=manifest, journal_state='verified',
        messages=[dict(message_id=f'unit-{index}-{j}') for j in range(3)],
        topology=dict(nodes=[dict(port=p) for p in range(56019,56025)]),
        cleanup=dict(normal_stop_confirmed=normal, all_owned_processes_exited=True, ports=[dict(available=True)]))
    if not comparable:cell['error']=dict(type='schedule_deviation')
    atomic_json(folder/'trial.json',cell)
    return cell


@pytest.fixture(scope='module')
def parent(tmp_path_factory):
    root=tmp_path_factory.mktemp('recovery-parent')/'source'
    plan=prepare_original(root)
    for i in range(399):
        cell=fake_cell(root/f't{i:03}', plan['schedule'][i], i, status='failed' if i==398 else 'completed',
                       comparable=i not in (122,398), normal=i!=398)
        if i<398:
            plan['completed'][str(i)]=dict(sha256=recovery.digest((root/f't{i:03}/trial.json').read_bytes()),
                journal_manifest=cell['journal_manifest'], comparable=cell['comparable'])
    plan['status']='paused_at_cell_boundary'
    atomic_json(root/'plan.json',plan)
    atomic_json(root.parent/'.benchmark-owner.json',dict(state='needs_audit',run_directory=str(root)))
    return root


@pytest.fixture
def target(parent,tmp_path):
    folder=tmp_path/'continuation'
    recovery.prepare(parent,folder,host)
    return folder


def approval(target, *, maximum=2):
    path=target/'unit-approval.json'
    atomic_json(path,dict(schema='residual_execution_approval_v1',approved=True,approved_by='unit_fixture_only',
        approved_at='2026-10-21T00:00:00+00:00',manifest_sha256=recovery.digest((target/'manifest.json').read_bytes()),
        recovery_tool_sha256=recovery.tool_hash(),max_cells=maximum))
    return path


def resign_unit_manifest(target, manifest):
    atomic_json(target/'manifest.json',manifest)
    progress=recovery.load(target/'progress.json')
    progress['manifest_sha256']=recovery.digest((target/'manifest.json').read_bytes())
    atomic_json(target/'progress.json',progress)


def test_parent_audit_preserves_every_checkpoint_failed_cell_and_exclusion(parent):
    before=recovery.tree_hashes(parent)
    audit=recovery.audit(parent,host)
    assert audit['data_integrity'] and audit['source_matches']
    assert audit['completed_cells']==398 and audit['comparable_cells']==397
    assert audit['pair_summary']['valid_pairs']==198
    assert [x['original_index'] for x in audit['exclusions']]==[122,398]
    assert before==recovery.tree_hashes(parent)


def test_exact_81_cell_plan_retains_seed_order_methods_and_repetition(parent,target):
    manifest,progress,report=recovery.verify(target,host)
    original=recovery.load(parent/'plan.json')
    assert [c['original_index'] for c in manifest['cells']]==list(range(399,480))
    assert [c['specification'] for c in manifest['cells']]==original['schedule'][399:480]
    for key in ('seed','repetitions','settings','source_sha256','environment'):
        assert manifest[key]==original[key]
    assert not manifest['automatic_merge'] and progress['completed']=={}
    assert report['owner_state']['state']=='needs_audit'
    assert not (target/'cells').exists()


def test_output_cannot_enter_original_tree(parent):
    before=recovery.tree_hashes(parent)
    with pytest.raises(ValueError,match='separate'):recovery.prepare(parent,parent/'forbidden',host)
    with pytest.raises(ValueError,match='separate'):recovery.separate(parent,parent/'plan.json')
    assert before==recovery.tree_hashes(parent)


@pytest.mark.parametrize('mutation',['include_398','reverse','method','seed','merge','exclusion'])
def test_resigned_invalid_residual_schedule_or_policy_is_refused(target,mutation):
    manifest=recovery.load(target/'manifest.json')
    if mutation=='include_398':manifest['cells'][0]['original_index']=398
    elif mutation=='reverse':manifest['cells'].reverse()
    elif mutation=='method':manifest['cells'][0]['specification']['method']='wrong'
    elif mutation=='seed':manifest['seed']+=1
    elif mutation=='merge':manifest['automatic_merge']=True
    else:manifest['exclusions'].pop()
    resign_unit_manifest(target,manifest)
    with pytest.raises(ValueError):recovery.verify(target,host)


def test_changed_source_blocks_prepare_without_resigning_parent(parent,tmp_path,monkeypatch):
    original=recovery.source_hashes
    monkeypatch.setattr(recovery,'source_hashes',lambda: dict(original(),changed_fixture='bad'))
    audit=recovery.audit(parent,host)
    assert not audit['source_matches'] and not audit['automatic_merge']
    with pytest.raises(ValueError,match='source'):recovery.prepare(parent,tmp_path/'never-created',host)
    assert not (tmp_path/'never-created').exists()


def test_failed_cell_journal_damage_prevents_any_preparation(parent,tmp_path):
    clone=tmp_path/'clone'
    shutil.copytree(parent,clone)
    (clone/'t398/journal.jsonl').unlink()
    assert not recovery.audit(clone,host)['data_integrity']
    with pytest.raises(ValueError):recovery.prepare(clone,tmp_path/'new',host)


def test_checkpoint_or_t122_change_is_detected(parent,tmp_path):
    clone=tmp_path/'clone'
    shutil.copytree(parent,clone)
    c=recovery.load(clone/'t122/trial.json');c['comparable']=True
    atomic_json(clone/'t122/trial.json',c)
    errors=recovery.audit(clone,host)['errors']
    assert 't122:checkpoint_mismatch' in errors and 't122:exclusion_changed' in errors


def test_uncheckpointed_followup_is_preserved_and_never_replayed(target):
    folder=target/'cells/t399';folder.mkdir(parents=True)
    path=folder/'trial.json';path.write_bytes(b'{"status":"starting"}')
    with pytest.raises(RuntimeError,match='no automatic replay'):recovery.verify(target,host)
    assert path.read_bytes()==b'{"status":"starting"}'


def test_fake_completion_of_398_is_rejected(target):
    progress=recovery.load(target/'progress.json');progress['completed']['398']={}
    atomic_json(target/'progress.json',progress)
    with pytest.raises(ValueError,match='forbidden'):recovery.verify(target,host)


def test_provenance_audit_and_escaped_outputs_cannot_be_used(parent,target):
    with pytest.raises(ValueError,match='escaped'):
        recovery.output_path(target,target.parent/'escaped-output',parent)
    (target/'audit.json').write_text('{}',encoding='utf-8')
    with pytest.raises(ValueError,match='audit report changed'):
        recovery.verify(target,host)


def test_missing_or_unbound_approval_never_starts(target):
    with pytest.raises(FileNotFoundError):recovery.check_approval(target,target/'absent.json',1)
    p=approval(target);value=recovery.load(p);value['approved']=False;atomic_json(p,value)
    with pytest.raises(PermissionError):recovery.check_approval(target,p,1)
    p=approval(target,maximum=1)
    with pytest.raises(PermissionError):recovery.check_approval(target,p,2)


def test_even_approved_request_cannot_release_needs_audit(parent,target):
    owner=parent.parent/'.benchmark-owner.json'
    atomic_json(owner,dict(state='needs_audit',run_directory=str(parent)))
    before=owner.read_bytes()
    with pytest.raises(RuntimeError,match='not clean'):
        recovery.execution_preflight(target,approval(target),1,host)
    assert owner.read_bytes()==before and not (target/'cells').exists()


@pytest.mark.parametrize('reason',['approval','host','owner_hash'])
def test_release_denies_missing_authorization_or_unproven_host(parent,target,reason):
    owner=parent.parent/'.benchmark-owner.json'
    atomic_json(owner,dict(state='needs_audit',run_directory=str(parent)))
    before=owner.read_bytes();p=approval(target);a=recovery.load(p)
    a.update(release_approved=reason!='approval',owner_file_sha256=recovery.digest(before))
    if reason=='owner_hash':a['owner_file_sha256']='wrong'
    atomic_json(p,a)
    observer=(lambda _:dict(status='unavailable',ready=False)) if reason=='host' else host
    with pytest.raises((PermissionError,RuntimeError)):
        recovery.release_after_audit(target,p,observer)
    assert owner.read_bytes()==before and not (target/'release-audits').exists()


def test_formal_unit_audit_release_writes_provenance_without_adopting_failed_cell(parent,target):
    owner=parent.parent/'.benchmark-owner.json';prior=owner.read_bytes()
    source_before=recovery.tree_hashes(parent)
    try:
        atomic_json(owner,dict(state='needs_audit',run_directory=str(parent)))
        p=approval(target);a=recovery.load(p)
        a.update(release_approved=True,owner_file_sha256=recovery.digest(owner.read_bytes()))
        atomic_json(p,a)
        record_path=recovery.release_after_audit(target,p,host)
        record=recovery.load(record_path)
        assert recovery.load(owner)['state']=='clean'
        assert record['adopted_or_reexecuted_cells']==[] and record['parent_failure_retained']
        assert recovery.load(target/'progress.json')['completed']=={}
        assert source_before==recovery.tree_hashes(parent)
    finally:owner.write_bytes(prior)


def test_unavailable_host_is_not_empty_or_safe(parent,target):
    owner=parent.parent/'.benchmark-owner.json'
    prior=owner.read_bytes()
    try:
        atomic_json(owner,dict(state='clean')) # Synthetic test lease only.
        with pytest.raises(RuntimeError,match='not confirmed'):
            recovery.execution_preflight(target,approval(target),1,lambda _:dict(status='unavailable',ready=False))
    finally:owner.write_bytes(prior)


def test_unknown_process_visibility_is_not_a_clean_host(monkeypatch):
    value=dict(status='observed',nodes=[],listeners=[],children=[],unknown_processes=[dict(ProcessId=999)])
    monkeypatch.setattr(recovery,'os',SimpleNamespace(name='nt',getpid=lambda:1,getppid=lambda:0))
    def observe(command,**kwargs):
        assert command[-1].startswith("$ErrorActionPreference='Stop'")
        assert 'Get-CimInstance Win32_Process' in command[-1]
        assert 'Get-NetTCPConnection -State Listen' in command[-1]
        return subprocess.CompletedProcess([],0,json.dumps(value).encode(),b'')
    monkeypatch.setattr(recovery.subprocess,'run',observe)
    result=recovery.host_observation([56019])
    assert not result['ready'] and result['bind_probes']==[]


@pytest.mark.parametrize('failure',['cancel','cleanup'])
def test_async_followup_failure_retains_attempt_and_needs_audit(parent,target,failure):
    owner=parent.parent/'.benchmark-owner.json';prior=owner.read_bytes()
    original_hashes=recovery.tree_hashes(parent)
    async def runner(folder,spec):
        if failure=='cancel':
            folder.mkdir(parents=True);(folder/'trial.json').write_text('{"status":"starting"}')
            raise asyncio.CancelledError
        return await asyncio.to_thread(fake_cell,folder,spec,399,status='failed',comparable=False,normal=False)
    try:
        atomic_json(owner,dict(state='clean'))
        async def run():
            with pytest.raises((RuntimeError,asyncio.CancelledError)):
                await recovery.execute(target,approval(target),1,observer=host,runner=runner)
        asyncio.run(run())
        assert recovery.load(owner)['state']=='needs_audit'
        assert recovery.load(target/'progress.json')['completed']=={}
        with pytest.raises(RuntimeError,match='Uncheckpointed'):recovery.verify(target,host)
        assert recovery.tree_hashes(parent)==original_hashes
    finally:owner.write_bytes(prior)


def test_async_resume_runs_only_next_original_index_and_preserves_completed_bytes(parent,target):
    owner=parent.parent/'.benchmark-owner.json';prior=owner.read_bytes();calls=[]
    async def runner(folder,spec):
        calls.append(int(folder.name[1:]))
        return await asyncio.to_thread(fake_cell,folder,spec,calls[-1])
    try:
        atomic_json(owner,dict(state='clean'))
        p=approval(target)
        asyncio.run(recovery.execute(target,p,1,observer=host,runner=runner))
        saved=(target/'cells/t399/trial.json').read_bytes()
        progress=asyncio.run(recovery.execute(target,p,1,observer=host,runner=runner))
        assert calls==[399,400] and set(progress['completed'])=={'399','400'}
        assert saved==(target/'cells/t399/trial.json').read_bytes()
        assert not (target/'cells/t398').exists()
    finally:owner.write_bytes(prior)


def test_async_time_exclusion_is_preserved_without_advancing_or_replay(parent,target):
    owner=parent.parent/'.benchmark-owner.json';prior=owner.read_bytes()
    async def runner(folder,spec):return await asyncio.to_thread(fake_cell,folder,spec,399,comparable=False)
    try:
        atomic_json(owner,dict(state='clean'))
        p=approval(target)
        progress=asyncio.run(recovery.execute(target,p,2,observer=host,runner=runner))
        assert list(progress['completed'])==['399'] and not progress['completed']['399']['comparable']
        with pytest.raises(RuntimeError,match='Excluded'):recovery.execution_preflight(target,p,1,host)
    finally:owner.write_bytes(prior)
