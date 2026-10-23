"""Explicit routing launcher with heartbeat disabled, using the same TCPNode."""
from exit_link.experiments.node import main

if __name__ == "__main__":
    raise SystemExit(main(fixed=True))
