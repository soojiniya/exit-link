"""Explicit small pilot only; long runs require reviewing pilot evidence first."""
import argparse
import asyncio
import json
from pathlib import Path
from uuid import uuid4

from diagnose_tcp import probe_loopback
from exit_link.experiments.comparison import run
from exit_link.experiments.safety import ExecutionLock, atomic_json


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repetitions',type=int,default=2,choices=range(1,5))
    parser.add_argument('--seed',type=int,default=20261021)
    args=parser.parse_args()
    preflight=probe_loopback()
    if not preflight['success']:
        print(preflight,flush=True)
        print('Pilot NOT executed. Allow localhost TCP and rerun in local PowerShell.',flush=True)
        return 2
    output=Path(__file__).resolve().parents[1]/'data/measured'/('b-'+uuid4().hex[:8])
    print(f'Evidence: {output}',flush=True)
    with ExecutionLock(output.parent):
        lease=output.parent/'.benchmark-owner.json'
        if lease.exists() and json.loads(lease.read_text(encoding='utf-8'))['state']!='clean':
            raise RuntimeError('Unclean study: audit prior process/port cleanup before another benchmark')
        atomic_json(lease,dict(state='active',run_directory=str(output)))
        clean=False
        try:
            summary=asyncio.run(run(output,args.repetitions,args.seed))
            clean=summary['status']=='completed'
        finally:
            atomic_json(lease,dict(state='clean' if clean else 'needs_audit',run_directory=str(output)))
    print(f"Pilot status: {summary['status']}; {summary['trials_recorded']}/{summary['trials_planned']} cells",flush=True)
    return 0 if summary['status']=='completed' else 1


if __name__=='__main__':
    raise SystemExit(main())
