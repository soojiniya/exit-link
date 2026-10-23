"""Cancellation fixtures are not measured contest cells; actual TCP is explicit."""
import asyncio
import json
import signal
import subprocess
import sys
import threading
import time

import pytest

from exit_link.experiments import aligned_v3 as engine
from exit_link.experiments import study_v3 as study
from exit_link.experiments.journal import DurableJournal, inspect_journal
from exit_link.topology.loader import load_communication

SPEC = dict(condition='normal', fault_timing='none', method='exit_link', repetition=0)


class OwnedFixture:
    def __init__(self): self.dead=False
    def poll(self): return 0 if self.dead else None
    def kill(self): self.dead=True
    def wait(self, timeout=5): assert self.dead; return 0


def install_cluster(monkeypatch, *, pause_start=False, readiness=None, close_error=None):
    entered, release=threading.Event(),threading.Event()
    instances=[]
    class FixtureCluster:
        def __init__(self, directory, method):
            self.topology=load_communication()
            self.processes={}
            self.history=[]
            self.timeline=[]
            instances.append(self)
        def start_all(self):
            for i in range(6):
                if i==4 and pause_start:
                    entered.set()
                    assert release.wait(4)
                self.processes[f'N{i+1}']=OwnedFixture()
                self.timeline.append(f'start-{i+1}')
            self.timeline.append('startup-done')
        async def wait_ready(self):
            if readiness is not None:await readiness()
        async def close(self):
            self.timeline.append('close-begin')
            if close_error is not None:raise close_error
            for process in self.processes.values():
                await asyncio.sleep(.005)
                process.dead=True
        def records(self, *args):return []
    monkeypatch.setattr(engine,'BenchmarkCluster',FixtureCluster)
    monkeypatch.setattr(engine,'all_events',lambda cluster: [])
    monkeypatch.setattr(engine,'check_ports',lambda topology: [dict(available=True)])
    return instances,entered,release


def test_missing_journal_stays_an_integrity_error_for_resume(tmp_path):
    with pytest.raises(FileNotFoundError):inspect_journal(tmp_path/'journal.jsonl')
    assert not (tmp_path/'journal.jsonl').exists()


def test_abrupt_exit_preserves_active_lease_and_blocks_uncheckpointed_cell(tmp_path):
    study.prepare(tmp_path/'p',2)
    code=('from pathlib import Path; from exit_link.experiments.safety import atomic_json; import os,sys; '
          'root=Path(sys.argv[1]); atomic_json(root/"lease.json",{"state":"active"}); '
          '(root/"p/t000").mkdir(); atomic_json(root/"p/t000/trial.json",{"status":"starting"}); os._exit(23)')
    result=subprocess.run([sys.executable,'-c',code,str(tmp_path)],capture_output=True,timeout=10)
    assert result.returncode==23,result.stderr
    assert json.loads((tmp_path/'lease.json').read_bytes())['state']=='active'
    saved=(tmp_path/'p/t000/trial.json').read_bytes()
    with pytest.raises(RuntimeError,match='Uncheckpointed'):study.validate(tmp_path/'p')
    assert (tmp_path/'p/t000/trial.json').read_bytes()==saved


@pytest.mark.parametrize('repeated',[False,True])
def test_async_cancel_during_start_waits_for_late_nodes_before_cleanup(tmp_path, monkeypatch, repeated):
    clusters,entered,release=install_cluster(monkeypatch,pause_start=True)
    async def run():
        task=asyncio.create_task(engine.trial(tmp_path/'cell',SPEC))
        assert await asyncio.to_thread(entered.wait,3)
        task.cancel()
        await asyncio.sleep(.02)
        if repeated:task.cancel()
        release.set()
        with pytest.raises(asyncio.CancelledError):await task
    try:asyncio.run(run())
    finally:release.set()
    cluster=clusters[0]
    assert len(cluster.processes)==6 and all(p.poll() is not None for p in cluster.processes.values())
    assert cluster.timeline.index('startup-done') < cluster.timeline.index('close-begin')
    record=json.loads((tmp_path/'cell/trial.json').read_bytes())
    assert record['status']=='interrupted' and not record['comparable']
    assert record['journal_state']=='not_created' and record['journal_manifest'] is None
    assert not (tmp_path/'cell/journal.jsonl').exists()


@pytest.mark.parametrize('cause',['cancelled','keyboard','disk'])
def test_async_pre_journal_interrupt_or_write_failure_still_reaps_all_nodes(tmp_path, monkeypatch, cause):
    async def not_ready():
        if cause=='cancelled':raise asyncio.CancelledError
        if cause=='keyboard':raise KeyboardInterrupt
    clusters,_,_=install_cluster(monkeypatch,readiness=not_ready)
    if cause=='disk':
        def fail(self, record):raise OSError('unit fsync unavailable')
        monkeypatch.setattr(DurableJournal,'_append',fail)
    async def run():
        if cause in ('cancelled','keyboard'):
            with pytest.raises(asyncio.CancelledError):await engine.trial(tmp_path/'cell',SPEC)
        else:
            record=await engine.trial(tmp_path/'cell',SPEC)
            assert record['status']=='failed' and record['recording_errors']
    asyncio.run(run())
    assert all(p.poll() is not None for p in clusters[0].processes.values())
    record=json.loads((tmp_path/'cell/trial.json').read_bytes())
    assert not record['comparable'] and record['journal_manifest'] is None
    assert not record['messages']


def test_async_cleanup_repeated_parent_cancellation_finishes_every_node(tmp_path, monkeypatch):
    async def not_ready():raise asyncio.CancelledError
    clusters,_,_=install_cluster(monkeypatch,readiness=not_ready)
    async def run():
        task=asyncio.create_task(engine.trial(tmp_path/'cell',SPEC))
        while not clusters or 'close-begin' not in clusters[0].timeline:await asyncio.sleep(.001)
        for _ in range(3):
            task.cancel()
            await asyncio.sleep(.002)
        with pytest.raises(asyncio.CancelledError):await task
    asyncio.run(run())
    assert all(p.poll() is not None for p in clusters[0].processes.values())
    record=json.loads((tmp_path/'cell/trial.json').read_bytes())
    assert not record['comparable'] and record['cleanup']['all_owned_processes_exited']


@pytest.mark.parametrize('cleanup_error',[RuntimeError('unit close failure'),asyncio.CancelledError()])
def test_async_cleanup_error_uses_owned_handles_and_never_claims_normal_stop(tmp_path,monkeypatch,cleanup_error):
    async def not_ready():raise ValueError('unit readiness failed')
    clusters,_,_=install_cluster(monkeypatch,readiness=not_ready,close_error=cleanup_error)
    async def run():
        if isinstance(cleanup_error,asyncio.CancelledError):
            with pytest.raises(asyncio.CancelledError):await engine.trial(tmp_path/'cell',SPEC)
        else:await engine.trial(tmp_path/'cell',SPEC)
    asyncio.run(run())
    assert all(p.poll() is not None for p in clusters[0].processes.values())
    record=json.loads((tmp_path/'cell/trial.json').read_bytes())
    assert not record['comparable'] and not record['cleanup']['normal_stop_confirmed']
    assert record['cleanup']['all_owned_processes_exited']


def test_async_final_disk_failure_does_not_skip_node_cleanup(tmp_path,monkeypatch):
    async def not_ready():raise ValueError('unit stop before intents')
    clusters,_,_=install_cluster(monkeypatch,readiness=not_ready)
    def fail(*args):raise OSError('unit final snapshot unavailable')
    monkeypatch.setattr(engine,'atomic_json',fail)
    async def run():
        with pytest.raises(OSError,match='final snapshot'):await engine.trial(tmp_path/'cell',SPEC)
    asyncio.run(run())
    assert all(p.poll() is not None for p in clusters[0].processes.values())


def test_async_recording_failure_after_precommitted_intents_stops_and_cleans(tmp_path,monkeypatch):
    clusters,_,_=install_cluster(monkeypatch)
    original=DurableJournal._append
    def fail_after_prepare(self,record):
        if record.get('kind')!='prepared_intents':raise OSError('unit disk failed during measurement')
        return original(self,record)
    monkeypatch.setattr(DurableJournal,'_append',fail_after_prepare)
    async def exchange(config,request,row):
        row['tcp_request_start_perf_ns']=time.perf_counter_ns()
        row['dispatch_perf_ns']=row['tcp_request_start_perf_ns']
        row['scheduling_lateness_ms']=(row['dispatch_perf_ns']-row['scheduled_perf_ns'])/1e6
        await asyncio.sleep(.02)
        raise OSError('unit synthetic transport')
    monkeypatch.setattr(engine,'exchange_measured',exchange)
    record=asyncio.run(engine.trial(tmp_path/'cell',SPEC))
    assert record['status']=='failed' and not record['comparable']
    assert record['recording_errors'] and record['journal_manifest'] is None
    assert inspect_journal(tmp_path/'cell/journal.jsonl')['entries']==1
    assert all(p.poll() is not None for p in clusters[0].processes.values())


@pytest.mark.parametrize('kind',['incomplete','cancelled','write_failure'])
def test_async_incomplete_cell_never_commits_or_clears_lease(tmp_path,monkeypatch,kind):
    study.prepare(tmp_path/'p',2)
    async def partial(folder,spec):
        folder.mkdir()
        (folder/'trial.json').write_text('{"status":"starting"}',encoding='utf-8')
        if kind=='cancelled':raise asyncio.CancelledError
        if kind=='write_failure':raise OSError('unit write failure')
        return dict(status='failed',comparable=False,journal_manifest=None,cleanup={})
    monkeypatch.setattr(study,'trial',partial)
    async def run():
        with pytest.raises((RuntimeError,OSError,asyncio.CancelledError)):
            await study.execute(tmp_path/'p',1,tmp_path/'locks')
    asyncio.run(run())
    assert json.loads((tmp_path/'locks/.benchmark-owner.json').read_bytes())['state']=='needs_audit'
    assert json.loads((tmp_path/'p/plan.json').read_bytes())['completed']=={}
    assert (tmp_path/'p/t000/trial.json').read_bytes()==b'{"status":"starting"}'
    with pytest.raises(RuntimeError,match='Uncheckpointed'):study.validate(tmp_path/'p')


def test_async_console_sigint_handler_requests_once_and_restores_handler():
    from scripts.prepare_study_v3 import interruptible
    previous=signal.getsignal(signal.SIGINT)
    done=[]
    async def operation():
        try:await asyncio.Event().wait()
        finally:
            await asyncio.sleep(.03)
            done.append(True)
    async def run():
        loop=asyncio.get_running_loop()
        def press():signal.getsignal(signal.SIGINT)(signal.SIGINT,None)
        loop.call_later(.01,press)
        loop.call_later(.02,press)
        with pytest.raises(asyncio.CancelledError):await interruptible(operation())
    asyncio.run(run())
    assert done==[True] and signal.getsignal(signal.SIGINT)==previous


def test_real_tcp_cancelled_startup_leaves_no_owned_nodes(tmp_path,monkeypatch):
    """Actual independent TCP processes; no historical PIDs are touched."""
    original=engine.BenchmarkCluster
    entered,release=threading.Event(),threading.Event()
    clusters=[]
    class PausedCluster(original):
        def __init__(self,*args):super().__init__(*args);clusters.append(self)
        def start_all(self):
            for i,node in enumerate(self.topology.nodes):
                self.start(node.id)
                if i==1:
                    entered.set()
                    if not release.wait(5):raise TimeoutError('unit gate not released')
    monkeypatch.setattr(engine,'BenchmarkCluster',PausedCluster)
    async def run():
        task=asyncio.create_task(engine.trial(tmp_path/'real',SPEC))
        try:
            assert await asyncio.to_thread(entered.wait,12)
            task.cancel()
        finally:release.set()
        with pytest.raises(asyncio.CancelledError):await task
    asyncio.run(run())
    assert all(p.poll() is not None for p in clusters[0].processes.values())
    record=json.loads((tmp_path/'real/trial.json').read_bytes())
    assert record['status']=='interrupted' and not record['comparable']
    assert record['cleanup']['normal_stop_confirmed'] and record['cleanup']['all_owned_processes_exited']
    assert all(p['available'] for p in record['cleanup']['ports'])
