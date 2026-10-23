"""Real Windows/loopback restart stress evidence. Does not change socket options."""
import argparse
import asyncio
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from exit_link.api.contracts import GuidanceSend, ScenarioCreate
from exit_link.api.runtime import Backend
from exit_link.api.security import ApiSettings
from exit_link.simulation.diagnostics import port_evidence


async def run(output, cycles):
    backend = Backend(ApiSettings(control_token="diagnostic-" + uuid4().hex, experiments_enabled=True,
        poll_seconds=0.1, observation_timeout=0.15, artifact_directory=output / "clusters"))
    report = {"platform": sys.platform, "transport": "real_tcp_loopback", "cycles_requested": cycles,
              "cycles": [], "status": "running"}
    try:
        await backend.start()
        await backend.start_experiment()
        scenario = backend.create_scenario(ScenarioCreate(starts=["F2_E"]))
        request = GuidanceSend(start_location="F2_E", source_node="N1", destination_node="N4", expected_revision=1)
        sid = scenario.state.scenario_id
        for index in range(cycles):
            delivery = await backend.deliver(sid, request)
            old = backend.cluster.processes["N2"]
            port = next(n.port for n in backend.topology.nodes if n.id == "N2")
            await backend.control_node("N2")
            cycle = {"cycle": index + 1, "old_pid": old.pid, "old_exit_code": old.poll(), "port": port,
                     "ack_before_fault": delivery.ack_received, "started_ns": time.monotonic_ns()}
            report["cycles"].append(cycle)
            try:
                await backend.control_node("N2", recover=True)
                cycle.update(status="restarted", new_pid=backend.cluster.processes["N2"].pid)
            except Exception as exc:
                cycle.update(status="failed", error=str(exc), port_evidence=port_evidence("127.0.0.1", port))
                report["status"] = "failed"
                break
            await backend.cluster.wait_ready()
            cycle["ack_after_recovery"] = (await backend.deliver(sid, request)).ack_received
            print(f"Cycle {index + 1}: restarted and ACK={cycle['ack_after_recovery']}", flush=True)
        else:
            report["status"] = "passed" if all(c["ack_before_fault"] and c["ack_after_recovery"] for c in report["cycles"]) else "failed"
    except Exception as exc:
        report.update(status="failed", error=str(exc))
    finally:
        try:
            await backend.close()
        except Exception as exc:
            report["cleanup_error"] = str(exc)
            report["status"] = "failed"
        (output / "summary.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cycles", type=int, default=20)
    args = parser.parse_args()
    if not 1 <= args.cycles <= 100:
        parser.error("cycles must be 1..100")
    root = Path(__file__).resolve().parents[1]
    output = root / "data/measured" / ("restart-diagnostic-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid4().hex[:8])
    output.mkdir(parents=True)
    print(f"Evidence: {output}", flush=True)
    report = asyncio.run(run(output, args.cycles))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
