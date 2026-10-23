"""Standalone six-process real TCP fault/recovery experiment with raw evidence."""
import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from diagnose_tcp import probe_loopback
from exit_link.communication.client import send_reliably
from exit_link.communication.protocol import ReliableSend
from exit_link.metrics.recording import write_observation
from exit_link.simulation.experiment import fault_and_recovery
from exit_link.simulation.processes import LocalCluster


async def experiment(output):
    cluster = LocalCluster(output / "processes")
    try:
        cluster.start_all()
        await cluster.wait_ready()
        baseline = await send_reliably(cluster.topology, ReliableSend(source="N1", destination="N4", payload="baseline"))
        if not baseline.success:
            raise AssertionError("Real baseline delivery failed")
        fault_report = await fault_and_recovery(cluster)
        write_observation(output / "fault-recovery.json", fault_report)
        if not fault_report["result"]["success"] or fault_report["result"]["retries"] < 1:
            raise AssertionError("In-flight message did not recover via an actual retry")
        if "N2" in fault_report["path_after"]:
            raise AssertionError("ACK path still uses terminated relay")
        cluster.kill("N2")
        await cluster.wait_status("N1", "N2", "down")
        cluster.kill("N3")
        await cluster.wait_status("N1", "N3", "down")
        failure = await send_reliably(cluster.topology, ReliableSend(source="N1", destination="N4", payload="isolated"))
        write_observation(output / "no-route.json", failure.model_dump(mode="json"))
        if failure.success or failure.error.code != "no_route":
            raise AssertionError("Isolated source was incorrectly reported as recovered")
        return {"status": "passed", "baseline": baseline.model_dump(mode="json"),
                "fault_recovery": fault_report, "no_route": failure.model_dump(mode="json")}
    finally:
        await cluster.close()


def main():
    root = Path(__file__).resolve().parents[1]
    output = root / "data/measured" / ("stage3-experiment-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid4().hex[:8])
    output.mkdir(parents=True)
    preflight = probe_loopback()
    report = {"preflight": preflight, "experiment_started": False, "status": "blocked_before_experiment"}
    code = 2
    if preflight["success"]:
        report["experiment_started"] = True
        try:
            report.update(asyncio.run(experiment(output)))
            code = 0
        except Exception as exc:
            report.update(status="failed", error_type=type(exc).__name__, detail=str(exc))
            code = 1
        except KeyboardInterrupt:
            report.update(status="interrupted")
            code = 1
    write_observation(output / "summary.json", report)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"Results: {output}")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
