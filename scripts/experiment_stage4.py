import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from diagnose_tcp import probe_loopback
from exit_link.metrics.recording import write_observation
from exit_link.simulation.evacuation_experiment import run_stage4_experiment


def main():
    output = Path(__file__).resolve().parents[1] / "data/measured" / ("stage4-experiment-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid4().hex[:8])
    output.mkdir(parents=True)
    report = {"preflight": probe_loopback(), "experiment_started": False, "status": "blocked_before_experiment"}
    code = 2
    if report["preflight"]["success"]:
        report["experiment_started"] = True
        try:
            report.update(asyncio.run(run_stage4_experiment(output)))
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
