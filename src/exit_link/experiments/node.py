"""Experimental process instrumentation only; never imported by the normal server.

Count drained outgoing heartbeat frames once, with exact application framing bytes.
The JSONL telemetry costs are part of this instrumented pilot, not packet capture.
"""
import json
import os
import sys
import time


def main(fixed=False):
    from exit_link.communication import protocol

    node_id = sys.argv[sys.argv.index("--id") + 1]

    def emit(event, **fields):
        print(json.dumps(dict(event=event, node=node_id, pid=os.getpid(),
                              benchmark_perf_ns=time.perf_counter_ns(), **fields)), flush=True)

    original_write, original_exchange = protocol.write_frame, protocol.exchange

    async def measured_write(writer, value, timeout):
        await original_write(writer, value, timeout)
        if isinstance(value, (protocol.Heartbeat, protocol.HeartbeatReply)):
            total = len(protocol.encode_frame(value))
            empty = len(protocol.encode_frame(value.model_copy(update={"advertisements": []})))
            emit("benchmark_control_frame", frame_type=value.type, bytes=total,
                 gossip_delta_bytes=total-empty, advertisements=len(value.advertisements))

    async def measured_exchange(host, port, request, *args, **kwargs):
        if isinstance(request, protocol.Heartbeat):
            emit("benchmark_probe_attempt", destination=request.destination)
        return await original_exchange(host, port, request, *args, **kwargs)

    # Patch before the node/heartbeat modules import these names. No production
    # process uses this launcher or these instrumented functions.
    protocol.write_frame, protocol.exchange = measured_write, measured_exchange
    from exit_link.communication.node import TCPNode
    original_log = TCPNode.log

    def measured_log(self, event, message=None, **fields):
        original_log(self, event, message, benchmark_perf_ns=time.perf_counter_ns(), **fields)

    TCPNode.log = measured_log
    if fixed:
        sys.argv.remove("--resilient")
    from exit_link.communication.__main__ import main as node_main
    return node_main()


if __name__ == "__main__":
    raise SystemExit(main())
