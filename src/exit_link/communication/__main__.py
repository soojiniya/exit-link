"""python -m exit_link.communication {node,send,stop,status}."""
import argparse
import asyncio
import json
import math
from pathlib import Path
from uuid import UUID

from pydantic import ValidationError

from exit_link.communication.client import get_status, send_message, send_reliably, stop_node
from exit_link.communication.node import TCPNode
from exit_link.communication.protocol import DeliveryResult, ErrorResponse, Message, ProtocolError, ReliableSend
from exit_link.fault_detection.state import HeartbeatConfig
from exit_link.topology.loader import load_communication


async def execute(args):
    topology = load_communication(args.topology)
    if not math.isfinite(args.timeout) or args.timeout <= 0:
        raise ValueError("Timeout must be finite and positive")
    if args.command == "node":
        config = HeartbeatConfig(interval=args.heartbeat_interval, timeout=args.heartbeat_timeout,
                                 failure_threshold=args.failure_threshold, recovery_threshold=args.recovery_threshold,
                                 state_ttl=args.state_ttl) if args.resilient else None
        state_path = args.guidance_state or Path("data/measured/guidance") / f"{args.id}.json"
        node = TCPNode(args.id, topology, timeout=args.timeout, heartbeat_config=config,
                       relay_delay=args.relay_delay, guidance_state=state_path)
        try:
            await node.start()
            await node.stop_event.wait()
        finally:
            await node.close()
        return 0
    if args.command == "stop":
        result = await stop_node(topology, args.id, args.timeout)
    elif args.command == "status":
        result = await get_status(topology, args.id, args.timeout)
    else:
        fields = dict(source=args.source, destination=args.destination, payload=args.payload,
                      ttl=args.ttl)
        if args.message_id:
            fields["message_id"] = args.message_id
        if args.auto_route:
            request = ReliableSend(**fields, max_retries=args.max_retries,
                                   initial_route=args.route.split(",") if args.route else None)
            result = await send_reliably(topology, request, args.timeout * (args.max_retries + 1) + 2)
        else:
            if not args.route:
                raise ValueError("Explicit mode requires --route; use --auto-route for stage 3")
            result = await send_message(topology, Message(**fields, route=args.route.split(",")), args.timeout)
    print(result.model_dump_json(), flush=True)
    return 1 if isinstance(result, ErrorResponse) or isinstance(result, DeliveryResult) and not result.success else 0


def main():
    parser = argparse.ArgumentParser(description="EXIT-LINK localhost explicit and resilient TCP nodes")
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command in ("node", "send", "stop", "status"):
        child = subparsers.add_parser(command)
        child.add_argument("--topology", type=Path, default=None)
        child.add_argument("--timeout", type=float, default=5)
        if command in ("node", "stop", "status"):
            child.add_argument("--id", required=True)
            if command == "node":
                child.add_argument("--resilient", action="store_true")
                child.add_argument("--heartbeat-interval", type=float, default=0.5)
                child.add_argument("--heartbeat-timeout", type=float, default=0.4)
                child.add_argument("--failure-threshold", type=int, default=3)
                child.add_argument("--recovery-threshold", type=int, default=2)
                child.add_argument("--state-ttl", type=float, default=6)
                child.add_argument("--relay-delay", type=float, default=0,
                                   help="Configured processing delay in seconds for controlled fault experiments")
                child.add_argument("--guidance-state", type=Path,
                                   help="Persistent latest guidance versions (default: data/measured/guidance/<node>.json)")
        else:
            child.add_argument("--source", required=True)
            child.add_argument("--destination", required=True)
            child.add_argument("--route", help="Explicit route, or preferred first route with --auto-route")
            child.add_argument("--auto-route", action="store_true")
            child.add_argument("--max-retries", type=int, default=3)
            child.add_argument("--payload", required=True)
            child.add_argument("--ttl", type=int, default=16)
            child.add_argument("--message-id", type=UUID)
    args = parser.parse_args()
    try:
        return asyncio.run(execute(args))
    except KeyboardInterrupt:
        return 0
    except (OSError, ValueError, ValidationError, ProtocolError, TimeoutError) as exc:
        print(json.dumps({"event": "command_failed", "command": args.command,
                          "reason": type(exc).__name__, "detail": str(exc),
                          "errno": getattr(exc, "errno", None), "winerror": getattr(exc, "winerror", None)}, ensure_ascii=False), flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
