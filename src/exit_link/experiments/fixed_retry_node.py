"""Experiment launcher: same instrumented TCPNode as v3, heartbeat off, Fixed + Retry policy.

``communication/node.py`` binds ``deliver_reliably`` by name at import time. This
launcher replaces the attribute on ``communication.reliable`` BEFORE ``node.py`` is
imported (``experiments.node.main`` imports it lazily, after its own telemetry
patches), so only this child process answers ``ReliableSend`` with the fixed-route
retry policy. No source file is modified and normal servers never import this.
"""
import sys

from exit_link.experiments.fixed_retry import deliver_fixed_retry


def install():
    if "exit_link.communication.node" in sys.modules:
        raise RuntimeError("communication.node already imported; fixed retry policy would not bind")
    from exit_link.communication import reliable
    reliable.deliver_reliably = deliver_fixed_retry


def main():
    install()
    from exit_link.experiments.node import main as instrumented_main
    return instrumented_main(fixed=True)  # removes --resilient: no heartbeat


if __name__ == "__main__":
    raise SystemExit(main())
