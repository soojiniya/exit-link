"""Read-only endpoint evidence; never terminates a process or changes socket reuse."""
import os
import locale
import socket
import subprocess


def _command_text(output):
    """Decode native console output without subprocess reader-thread failures."""
    if output is None:
        return "", "netstat output unavailable"
    if isinstance(output, str):
        return output, None
    # Native Windows utilities need not use Python's UTF-8 mode. Endpoint/PID
    # fields are ASCII; replacement preserves those fields even for damaged text.
    encoding = "oem" if os.name == "nt" else locale.getencoding()
    try:
        return output.decode(encoding), None
    except LookupError:
        encoding = locale.getencoding()
    except UnicodeError:
        return output.decode(encoding, errors="replace"), "netstat output contained undecodable bytes"
    return output.decode(encoding, errors="replace"), "netstat console codec unavailable; used locale codec"


def port_evidence(host, port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        try:
            probe.bind((host, port))
            binding = {"available": True}
        except OSError as exc:
            binding = {"available": False, "errno": exc.errno, "winerror": getattr(exc, "winerror", None), "error": str(exc)}
    rows = []
    error = None
    if os.name == "nt":
        try:
            result = subprocess.run(["netstat", "-ano", "-p", "tcp"], capture_output=True, text=False, timeout=3)
            stdout, error = _command_text(result.stdout)
            if result.returncode:
                stderr, _ = _command_text(result.stderr)
                error = "; ".join(filter(None, (error, stderr.strip() or f"netstat exit {result.returncode}")))
            for line in stdout.splitlines():
                parts = line.split()
                if len(parts) == 5 and parts[0] == "TCP" and parts[1].endswith(":" + str(port)):
                    rows.append(dict(zip(("protocol", "local", "remote", "state", "pid"), parts)))
        except (OSError, subprocess.TimeoutExpired, UnicodeError) as exc:
            error = str(exc)
    return {"bind": binding, "connections": rows, "inspection_error": error,
            "owner_visibility": "observed" if rows else "not_observed"}
