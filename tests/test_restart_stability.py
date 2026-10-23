"""Actual port conflicts and owned-process lifecycle, without relaxing old tests."""
import asyncio
import socket

import pytest

from exit_link.simulation.processes import LocalCluster
from exit_link.api.runtime import Backend
from exit_link.api.security import ApiSettings
from fastapi import HTTPException


def test_failed_recovery_preserves_owned_handle_and_recovery_after_port_release(tmp_path):
    cluster = LocalCluster(tmp_path / "conflicting-port", relay_delay=0)
    try:
        cluster.start_all()
        asyncio.run(cluster.wait_ready())
        old = cluster.processes["N2"]
        cluster.kill("N2")
        assert old.poll() is not None
        port = next(n.port for n in cluster.topology.nodes if n.id == "N2")
        try:
            with socket.socket() as occupied:
                occupied.bind(("127.0.0.1", port))
                occupied.listen()
                with pytest.raises(RuntimeError):
                    cluster.start("N2")
                assert cluster.processes["N2"] is old
        finally:
            # Release only our deliberately created listener; never terminate a stranger.
            cluster.start("N2")
            asyncio.run(cluster.wait_ready())
        assert cluster.processes["N2"].poll() is None
    finally:
        asyncio.run(cluster.close())


def test_api_keeps_occupied_port_failure_visible_without_retrying(tmp_path):
    async def check():
        backend = Backend(ApiSettings(control_token="unit-restart-" + "x" * 32,
            experiments_enabled=True, monitor_enabled=False, artifact_directory=tmp_path))
        try:
            await backend.start_experiment()
            await backend.control_node("N2")
            old = backend.cluster.processes["N2"]
            port = next(n.port for n in backend.topology.nodes if n.id == "N2")
            history = len(backend.cluster.history)
            with socket.socket() as occupied:
                occupied.bind(("127.0.0.1", port))
                occupied.listen()
                with pytest.raises(HTTPException) as error:
                    await backend.control_node("N2", recover=True)
                assert error.value.status_code == 503
                assert error.value.detail["code"] == "node_control_failed"
                assert len(backend.cluster.history) == history + 1
                record = backend.cluster.history[-1]
                assert record["failure"]["port_evidence"]["bind"]["available"] is False
                assert backend.cluster.processes["N2"] is old
                assert old.poll() is not None
            await backend.control_node("N2", recover=True)
            await backend.cluster.wait_ready()
        finally:
            await backend.close()
    asyncio.run(check())


def test_api_retries_only_when_real_failed_bind_has_become_available(tmp_path, monkeypatch):
    import exit_link.simulation.processes as processes
    original_probe = processes.port_evidence

    async def check():
        backend = Backend(ApiSettings(control_token="unit-restart-" + "x" * 32,
            experiments_enabled=True, monitor_enabled=False, artifact_directory=tmp_path))
        try:
            await backend.start_experiment()
            await backend.control_node("N2")
            port = next(n.port for n in backend.topology.nodes if n.id == "N2")
            history = len(backend.cluster.history)
            with socket.socket() as occupied:
                occupied.bind(("127.0.0.1", port))
                occupied.listen()

                def release_after_actual_child_failure(host, failed_port):
                    # Deterministically release our actual conflicting socket at the
                    # diagnostic boundary. The bind failure and subsequent bind are real.
                    occupied.close()
                    return original_probe(host, failed_port)

                monkeypatch.setattr(processes, "port_evidence", release_after_actual_child_failure)
                await backend.control_node("N2", recover=True)
            await backend.cluster.wait_ready()
            attempts = backend.cluster.history[history:]
            assert len(attempts) == 2
            assert attempts[0]["startup_status"] == "failed"
            assert attempts[0]["retry_reason"] == "address_conflict_cleared_before_retry"
            assert attempts[1]["startup_status"] == "started"
        finally:
            await backend.close()
    asyncio.run(check())
