"""Native command diagnostics cannot mask the authoritative bind evidence."""
import socket
import subprocess
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from exit_link.simulation import diagnostics


@pytest.fixture
def probe(monkeypatch):
    sock = MagicMock()
    sock.__enter__.return_value = sock
    monkeypatch.setattr(diagnostics.socket, "socket", MagicMock(return_value=sock))
    monkeypatch.setattr(diagnostics, "os", SimpleNamespace(name="nt"))
    return sock


def command(monkeypatch, stdout, stderr=b"", returncode=0):
    def run(args, **kwargs):
        assert args == ["netstat", "-ano", "-p", "tcp"]
        assert kwargs == {"capture_output": True, "text": False, "timeout": 3}
        return subprocess.CompletedProcess(args, returncode, stdout, stderr)
    monkeypatch.setattr(diagnostics.subprocess, "run", run)


@pytest.mark.parametrize("output", [
    b"\xbc\xad\xba\xf1\xbd\xba\n TCP 127.0.0.1:9102 0.0.0.0:0 LISTENING 6588\n",
    b"\xff\x81\n TCP 127.0.0.1:9102 0.0.0.0:0 LISTENING 6588\n",
    "TCP 127.0.0.1:9102 0.0.0.0:0 LISTENING 6588\n",
])
def test_native_or_damaged_output_preserves_pid_and_bind_failure(monkeypatch, probe, output):
    conflict = OSError(10048, "address already in use")
    conflict.winerror = 10048
    probe.bind.side_effect = conflict
    command(monkeypatch, output)
    result = diagnostics.port_evidence("127.0.0.1", 9102)
    assert result["bind"]["available"] is False
    assert result["bind"]["winerror"] == 10048
    assert result["connections"][0]["pid"] == "6588"
    assert result["owner_visibility"] == "observed"


@pytest.mark.parametrize("returncode,stderr", [(0, None), (1, None), (1, b"\xbc\xff")])
def test_missing_output_remains_visible_without_masking_bind(monkeypatch, probe, returncode, stderr):
    command(monkeypatch, None, stderr, returncode)
    result = diagnostics.port_evidence("127.0.0.1", 9102)
    assert result["bind"] == {"available": True}
    assert result["connections"] == []
    assert result["owner_visibility"] == "not_observed"
    assert "output unavailable" in result["inspection_error"]
    if returncode and stderr is None:
        assert "netstat exit 1" in result["inspection_error"]


@pytest.mark.parametrize("error", [
    UnicodeDecodeError("utf-8", b"\xbc", 0, 1, "invalid start byte"),
    subprocess.TimeoutExpired("netstat", 3),
    OSError("netstat unavailable"),
])
def test_command_failure_is_diagnostic_only(monkeypatch, probe, error):
    def fail(*args, **kwargs):
        raise error
    monkeypatch.setattr(diagnostics.subprocess, "run", fail)
    result = diagnostics.port_evidence("127.0.0.1", 9102)
    assert result["bind"] == {"available": True}
    assert result["inspection_error"] == str(error)
    assert result["connections"] == []


def test_only_exact_local_endpoint_is_selected(monkeypatch, probe):
    command(monkeypatch, b"TCP 127.0.0.1:19102 0.0.0.0:0 LISTENING 1\n"
            b"TCP 127.0.0.1:1234 127.0.0.1:9102 ESTABLISHED 2\n"
            b"TCP [::1]:9102 [::]:0 LISTENING 3\n")
    result = diagnostics.port_evidence("127.0.0.1", 9102)
    assert [row["pid"] for row in result["connections"]] == ["3"]


def test_real_windows_bind_conflict_survives_native_inspection():
    if diagnostics.os.name != "nt":
        pytest.skip("Windows native command verification")
    with socket.socket() as occupied:
        occupied.bind(("127.0.0.1", 0))
        occupied.listen()
        result = diagnostics.port_evidence("127.0.0.1", occupied.getsockname()[1])
    assert result["bind"]["available"] is False
    assert result["bind"]["winerror"] == 10048
    assert result["bind"]["errno"] == 10048
    assert result["bind"]["error"]
    # Some Windows sandboxes expose bind failures but hide netstat's socket
    # table. No owner must be invented from missing rows; PID parsing is tested
    # independently above, including native/damaged command output.
    assert result["owner_visibility"] == ("observed" if result["connections"] else "not_observed")
