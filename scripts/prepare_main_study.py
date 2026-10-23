"""Defaults to preparation ONLY. No long study is launched by preparation."""
import argparse
import asyncio
from pathlib import Path
from uuid import uuid4

from exit_link.experiments.study import prepare, execute


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repetitions',type=int,default=30)
    parser.add_argument('--seed',type=int,default=20261022)
    parser.add_argument('--execute',type=Path,help='An explicitly chosen prepared directory')
    parser.add_argument('--max-cells',type=int,help='Mandatory execution bound; completed cells are skipped')
    args=parser.parse_args()
    if args.execute:
        if args.max_cells is None:
            parser.error('--execute requires --max-cells')
        from diagnose_tcp import probe_loopback
        preflight=probe_loopback()
        if not preflight['success']:
            print(preflight)
            print('No cells executed: localhost preflight blocked')
            return 2
        result=asyncio.run(execute(args.execute,args.max_cells))
        print(result['status'],len(result['completed']),len(result['schedule']))
        return 0 if all(c['comparable'] for c in result['completed'].values()) else 1
    if args.max_cells is not None:
        parser.error('--max-cells requires --execute')
    output=Path(__file__).resolve().parents[1]/'data/measured'/('m-'+uuid4().hex[:8])
    result=prepare(output,args.repetitions,args.seed)
    print(f"PREPARED ONLY: {output}; {len(result['schedule'])} cells, {3*len(result['schedule'])} messages; no nodes started")
    return 0


if __name__=='__main__':
    raise SystemExit(main())
