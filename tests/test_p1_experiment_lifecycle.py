"""P1 regression tests for owned-experiment start/stop lifecycle.

All tests use a fake cluster and fake processes: no TCP node process is started,
no fault is injected and no experiment data is produced.
"""
import asyncio
import threading
from pathlib import Path

import pytest
from fastapi import HTTPException

import exit_link.api.runtime as runtime
from exit_link.api.runtime import Backend
from exit_link.api.security import ApiSettings
from exit_link.topology.loader import load_communication

TOKEN = "p1-lifecycle-token-" + "x" * 32
NODES = ("N1", "N2", "N3", "N4", "N5", "N6")


class FakeProcess:
    _pid = 41000

    def __init__(self):
        FakeProcess._pid += 1
        self.pid, self.alive, self.returncode = FakeProcess._pid, True, None

    def poll(self):
        return None if self.alive else self.returncode

    def stop(self):
        self.alive, self.returncode = False, 0


class FakeCluster:
    """Mimics LocalCluster's ownership surface. start_all can be held in its worker thread."""
    instances = []
    hold_start = False
    hold_ready = False
    close_error = None
    hold_close = None

    def __init__(self, directory, relay_delay=0):
        self.directory, self.relay_delay = Path(directory), relay_delay
        self.topology = load_communication()
        self.processes, self.history = {}, []
        self.started, self.release, self.finished = threading.Event(), threading.Event(), threading.Event()
        self.ready_entered = asyncio.Event()
        self.close_calls, self.close_saw_finished_start = 0, []
        FakeCluster.instances.append(self)

    def start_all(self):
        self.started.set()
        if FakeCluster.hold_start:
            assert self.release.wait(5), "test did not release start_all"
        for node in NODES:
            self.processes[node] = FakeProcess()
        self.finished.set()

    async def wait_ready(self):
        self.ready_entered.set()
        if FakeCluster.hold_ready:
            await asyncio.sleep(60)

    async def close(self):
        self.close_calls += 1
        self.close_saw_finished_start.append(self.finished.is_set())
        if FakeCluster.hold_close is not None:
            await FakeCluster.hold_close.wait()
        if FakeCluster.close_error is not None:
            raise FakeCluster.close_error
        for process in self.processes.values():
            process.stop()


@pytest.fixture
def backend(tmp_path, monkeypatch):
    FakeCluster.instances, FakeCluster.hold_start, FakeCluster.hold_ready, FakeCluster.close_error = [], False, False, None
    FakeCluster.hold_close = None
    monkeypatch.setattr(runtime, "LocalCluster", FakeCluster)
    value = Backend(ApiSettings(control_token=TOKEN, experiments_enabled=True, monitor_enabled=False,
                                persistence_enabled=False, artifact_directory=tmp_path))

    async def no_observation():
        return value.network
    value.refresh_network = no_observation
    value.collect_logs = lambda cluster: None
    return value


async def until(predicate, timeout=3):
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        assert asyncio.get_running_loop().time() < deadline, "condition not reached"
        await asyncio.sleep(0.01)


def all_stopped(cluster):
    return all(process.poll() is not None for process in cluster.processes.values())


# ---------------------------------------------------------------- P1-1 -----

def test_cancel_during_threaded_start_joins_thread_then_cleans_up(backend):
    async def run():
        FakeCluster.hold_start = True
        task = asyncio.create_task(backend.start_experiment())
        await until(lambda: FakeCluster.instances and FakeCluster.instances[0].started.is_set())
        cluster = FakeCluster.instances[0]
        task.cancel()
        await asyncio.sleep(0.1)
        # The worker thread is still starting processes: cleanup must not race it.
        assert not task.done()
        assert cluster.close_calls == 0
        assert backend.control_lock.locked()
        cluster.release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert cluster.close_calls == 1 and cluster.close_saw_finished_start == [True]
        assert all_stopped(cluster) and len(cluster.processes) == 6
        assert backend.cluster is None
        assert backend.experiment.status == "failed"
        assert "cancel" in backend.experiment.last_error.lower()
        assert not backend.control_lock.locked()
    asyncio.run(run())


def test_cancel_during_readiness_cleans_up_and_releases_lock(backend):
    async def run():
        FakeCluster.hold_ready = True
        task = asyncio.create_task(backend.start_experiment())
        await until(lambda: FakeCluster.instances and FakeCluster.instances[0].ready_entered.is_set())
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        cluster = FakeCluster.instances[0]
        assert cluster.close_calls == 1 and all_stopped(cluster)
        assert backend.cluster is None and backend.experiment.status == "failed"
        assert not backend.control_lock.locked()
        # A fresh start is possible afterwards.
        FakeCluster.hold_ready = False
        view = await backend.start_experiment()
        assert view.status == "running" and len(FakeCluster.instances) == 2
    asyncio.run(run())


def test_repeated_cancellation_cannot_abandon_cleanup(backend):
    async def run():
        FakeCluster.hold_start = True
        task = asyncio.create_task(backend.start_experiment())
        await until(lambda: FakeCluster.instances and FakeCluster.instances[0].started.is_set())
        cluster = FakeCluster.instances[0]
        for _ in range(3):
            task.cancel()
            await asyncio.sleep(0.03)
        assert not task.done() and cluster.close_calls == 0
        cluster.release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert cluster.close_calls == 1 and all_stopped(cluster) and backend.cluster is None
        assert not backend.control_lock.locked()
    asyncio.run(run())


def test_duplicate_start_and_stop_during_start_are_serialized(backend):
    async def run():
        FakeCluster.hold_start = True
        first = asyncio.create_task(backend.start_experiment())
        await until(lambda: FakeCluster.instances and FakeCluster.instances[0].started.is_set())
        second = asyncio.create_task(backend.start_experiment())
        stop = asyncio.create_task(backend.stop_experiment())
        await asyncio.sleep(0.05)
        assert not second.done() and not stop.done()
        cluster = FakeCluster.instances[0]
        cluster.release.set()
        assert (await first).status == "running"
        with pytest.raises(HTTPException) as duplicate:
            await second
        assert duplicate.value.status_code == 409 and duplicate.value.detail["code"] == "experiment_exists"
        assert (await stop).status == "stopped"
        assert len(FakeCluster.instances) == 1
        assert cluster.close_calls == 1 and cluster.close_saw_finished_start == [True] and all_stopped(cluster)
    asyncio.run(run())


def test_cancelled_stop_still_finishes_cleanup_before_releasing_ownership(backend):
    async def run():
        await backend.start_experiment()
        cluster = FakeCluster.instances[0]
        FakeCluster.hold_close = asyncio.Event()
        stop = asyncio.create_task(backend.stop_experiment())
        await until(lambda: cluster.close_calls == 1)
        stop.cancel()
        await asyncio.sleep(0.05)
        assert not stop.done() and backend.cluster is cluster  # still owned while closing
        FakeCluster.hold_close.set()
        with pytest.raises(asyncio.CancelledError):
            await stop
        assert all_stopped(cluster) and backend.cluster is None and backend.experiment.status == "stopped"
        assert not backend.control_lock.locked()
    asyncio.run(run())


# ---------------------------------------------------------------- P1-2 -----

class SilentTimeout(TimeoutError):
    """An exception whose str() is empty, like a bare TimeoutError()."""


def test_cleanup_exception_with_empty_message_is_still_a_failure(backend):
    async def run():
        await backend.start_experiment()
        FakeCluster.close_error = TimeoutError()
        with pytest.raises(HTTPException) as error:
            await backend.stop_experiment()
        assert error.value.status_code == 503 and error.value.detail["code"] == "experiment_cleanup_failed"
        assert backend.experiment.status == "failed"
        assert backend.experiment.last_error  # never an empty string
        assert "TimeoutError" in error.value.detail["message"]
    asyncio.run(run())


def test_failed_cleanup_keeps_ownership_blocks_new_start_and_can_be_retried(backend):
    async def run():
        await backend.start_experiment()
        cluster = FakeCluster.instances[0]
        FakeCluster.close_error = RuntimeError("Cluster cleanup failed: N2 still alive")
        with pytest.raises(HTTPException):
            await backend.stop_experiment()
        assert backend.cluster is cluster and not all_stopped(cluster)
        assert {node.node_id for node in backend.experiment_view().nodes} == set(NODES)
        with pytest.raises(HTTPException) as blocked:
            await backend.start_experiment()
        assert blocked.value.status_code == 409 and blocked.value.detail["code"] == "experiment_exists"
        assert len(FakeCluster.instances) == 1
        FakeCluster.close_error = None
        view = await backend.stop_experiment()  # retry on the preserved owner
        assert view.status == "stopped" and backend.cluster is None and all_stopped(cluster)
        assert cluster.close_calls == 2
        assert (await backend.start_experiment()).status == "running"
    asyncio.run(run())


def test_start_failure_with_failed_cleanup_keeps_owner_until_retry(backend):
    async def run():
        FakeCluster.hold_ready = False
        async def broken_ready():
            raise SilentTimeout()
        FakeCluster.close_error = RuntimeError("Cluster cleanup failed")
        original = FakeCluster.wait_ready
        FakeCluster.wait_ready = lambda self: broken_ready()
        try:
            with pytest.raises(HTTPException) as error:
                await backend.start_experiment()
        finally:
            FakeCluster.wait_ready = original
        assert error.value.detail["code"] == "experiment_start_failed"
        assert "SilentTimeout" in error.value.detail["message"] and "cleanup" in error.value.detail["message"]
        cluster = FakeCluster.instances[0]
        assert backend.cluster is cluster and backend.experiment.status == "failed"
        with pytest.raises(HTTPException) as blocked:
            await backend.start_experiment()
        assert blocked.value.detail["code"] == "experiment_exists"
        FakeCluster.close_error = None
        assert (await backend.stop_experiment()).status == "stopped" and all_stopped(cluster)
    asyncio.run(run())


class Proc:
    def __init__(self, pid, alive=True, returncode=None, kill_fails=False):
        self.pid, self.alive, self.returncode, self.kill_fails = pid, alive, returncode, kill_fails

    def poll(self):
        return None if self.alive else self.returncode

    def wait(self, timeout=None):
        import subprocess
        if self.alive:
            raise subprocess.TimeoutExpired("node", timeout)
        return self.returncode

    def kill(self):
        if not self.kill_fails:
            self.alive, self.returncode = False, -9


def fake_local_cluster(tmp_path, monkeypatch, processes):
    from exit_link.simulation import processes as module
    cluster = object.__new__(module.LocalCluster)
    cluster.directory, cluster.topology = tmp_path, load_communication()
    cluster.processes, cluster.handles, cluster.history, cluster.faults = processes, [], [], []

    async def stop_node(topology, node_id, timeout=3):
        raise ConnectionRefusedError()  # empty message on purpose
    monkeypatch.setattr(module, "stop_node", stop_node)
    cluster.records = lambda node_id, event=None, message_id=None: []
    return cluster


def test_local_cluster_close_continues_after_unconfirmed_kill_and_retry_succeeds(tmp_path, monkeypatch):
    stuck = Proc(1, kill_fails=True)
    other = Proc(2)
    cluster = fake_local_cluster(tmp_path, monkeypatch, {"N1": stuck, "N2": other})
    with pytest.raises(RuntimeError) as first:
        asyncio.run(cluster.close())
    # The stuck N1 must not stop cleanup of N2.
    assert other.poll() is not None
    assert "ConnectionRefusedError" in str(first.value) and "N1" in str(first.value)
    assert stuck.poll() is None
    stuck.kill_fails = False
    # Retry: N2 was already released, N1 is now reaped; nothing alive remains.
    with pytest.raises(RuntimeError):
        asyncio.run(cluster.close())  # N1 still needed a forced kill: reported again
    assert stuck.poll() is not None
    asyncio.run(cluster.close())      # nothing left to clean: succeeds
    assert (tmp_path / "evidence.json").exists()
    assert sorted(p.name for p in tmp_path.glob("evidence-retry-*.json")) == ["evidence-retry-1.json", "evidence-retry-2.json"]
