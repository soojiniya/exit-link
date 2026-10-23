"""Read-only main-plan audit. Does not call execute or start a TCP node."""
import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path

from exit_link.experiments.study import design_hash, source_hashes, runtime_environment
from exit_link.experiments.safety import atomic_json


def check(directory):
    directory=Path(directory)
    plan=json.loads((directory/'plan.json').read_text(encoding='utf-8'))
    expected={('normal','none'),('no_route','before_send'),
        *((c,t) for c in ('single_failure','sequential_failures','restart') for t in ('before_send','inflight'))}
    repetitions=plan['repetitions']
    cells=plan['schedule']
    identities=Counter((s['condition'],s['fault_timing'],s['repetition'],s['method']) for s in cells)
    pairs=defaultdict(list)
    for cell in cells:
        pairs[cell['condition'],cell['fault_timing'],cell['repetition']].append(cell)
    first=Counter((key[0],key[1],group[0]['method']) for key,group in pairs.items())
    profile=dict(client_timeout_seconds=6,observation_window_seconds=9,secondary_fault_or_restart_seconds=1,
        send_offsets_seconds=[.05,.8,2.5],inflight_followup_seconds=[.8,2.5],scheduling_tolerance_ms=100,
        payload_bytes=256,ttl=16,relay_delay_seconds=.2,fixed_retries=0,exit_link_max_retries=3,
        probe_interval_seconds=.1,probe_timeout_seconds=.15,failure_threshold=2,recovery_threshold=2,
        state_ttl_seconds=3,warmup_seconds=.6,node_hop_timeout_seconds=1.5)
    checks=dict(purpose=plan['purpose']=='contest_main_study' and plan['protocol_version']=='aligned_v2',
        design_hash=plan['design_sha256']==design_hash(plan),source_hash=plan['source_sha256']==source_hashes(),
        environment=plan['environment']==runtime_environment(),
        repetitions=2<=repetitions<=100 and repetitions%2==0,
        strata={(s['condition'],s['fault_timing']) for s in cells}==expected,
        count=len(cells)==8*repetitions*2,
        identities=identities==Counter({(c,t,r,m):1 for c,t in expected for r in range(repetitions) for m in ('fixed','exit_link')}),
        adjacent_pairs=all((cells[i]['condition'],cells[i]['fault_timing'],cells[i]['repetition'])==
            (cells[i+1]['condition'],cells[i+1]['fault_timing'],cells[i+1]['repetition']) for i in range(0,len(cells)-1,2)),
        counterbalance=all(first[c,t,m]==repetitions//2 for c,t in expected for m in ('fixed','exit_link')),
        shared_warmup=all(len({s['warmup_extra_seconds'] for s in group})==1 for group in pairs.values()),
        profile=plan['settings']==profile)
    return dict(status='passed' if all(checks.values()) else 'failed',run_id=plan['run_id'],checks=checks,
        planned_cells=len(cells),planned_messages=3*len(cells),completed_cells=len(plan['completed']),
        existing_cell_directories=len(list(directory.glob('t[0-9][0-9][0-9]'))),
        strata_counts={f'{c}/{t}':sum(s['condition']==c and s['fault_timing']==t for s in cells) for c,t in sorted(expected)})


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory',type=Path)
    parser.add_argument('--output',type=Path)
    args=parser.parse_args()
    result=check(args.directory)
    if args.output:
        atomic_json(args.output,result)
    print(json.dumps(result,ensure_ascii=False,indent=2))
    raise SystemExit(0 if result['status']=='passed' else 1)
