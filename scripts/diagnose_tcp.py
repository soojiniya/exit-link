"""Read-only diagnostics: temporary loopback sockets, no firewall changes."""
import argparse
import json
import platform
import socket
import sys
from datetime import datetime, timezone


def error_info(exc):
    return {"error": type(exc).__name__, "errno": exc.errno,
            "winerror": getattr(exc, "winerror", None), "detail": str(exc)}


def probe_loopback():
    result = {"host": "127.0.0.1", "success": False, "stage": "bind"}
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            listener.settimeout(2)
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
            result["port"] = port
            listener.listen(1)
            result["stage"] = "connect"
            with socket.create_connection(("127.0.0.1", port), timeout=2) as client:
                result["stage"] = "accept"
                peer, _ = listener.accept()
                with peer:
                    peer.settimeout(2)
                    result["stage"] = "transfer"
                    client.sendall(b"EXIT-LINK")
                    received = b""
                    while len(received) < 9:
                        chunk = peer.recv(9 - len(received))
                        if not chunk:
                            raise ConnectionError("Unexpected EOF")
                        received += chunk
                    peer.sendall(received)
                    echoed = b""
                    while len(echoed) < 9:
                        chunk = client.recv(9 - len(echoed))
                        if not chunk:
                            raise ConnectionError("Unexpected EOF")
                        echoed += chunk
                    result["success"] = echoed == b"EXIT-LINK"
                    result["stage"] = "complete"
    except OSError as exc:
        result.update(error_info(exc))
    return result


def probe_port(port):
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            sock.bind(("127.0.0.1", port))
        return {"port": port, "bind_available": True}
    except OSError as exc:
        return {"port": port, "bind_available": False, **error_info(exc)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ports", nargs="*", type=int, default=list(range(9101, 9107)))
    args = parser.parse_args()
    loopback = probe_loopback()
    print(json.dumps({"timestamp": datetime.now(timezone.utc).isoformat(),
                      "python": sys.executable, "platform": platform.platform(),
                      "loopback": loopback, "port_bind_checks": [probe_port(port) for port in args.ports]},
                     ensure_ascii=False, indent=2))
    return 0 if loopback["success"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
