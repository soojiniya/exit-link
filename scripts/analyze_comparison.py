"""Analyze an explicitly selected pilot folder; never scan prior validation data."""
import argparse
import csv
import hashlib
import json
from collections import defaultdict
from pathlib import Path

from exit_link.experiments.comparison import ROUTE, distribution
from exit_link.metrics.recording import write_observation


def analyze(directory):
    directory=Path(directory)
    manifest=json.loads((directory/'manifest.json').read_text(encoding='utf-8'))
    if manifest['purpose']!='contest_comparison_pilot':
        raise ValueError('Not a contest pilot manifest')
    groups=defaultdict(list)
    failures=[]
    excluded=[]
    trial_rows=[]
    for index,spec in enumerate(manifest['schedule']):
        file=directory/f't{index:02}'/'trial.json'
        if not file.exists():
            excluded.append(dict(index=index,reason='cell_not_recorded',**spec))
            continue
        cell=json.loads(file.read_text(encoding='utf-8'))
        if any(cell[key]!=spec[key] for key in ('condition','method','repetition')):
            raise ValueError('Manifest/cell mismatch')
        for row in cell['messages']:
            if not row['ack_received'] or not row.get('delivered_observed'):
                failures.append(dict(experiment_id=cell['experiment_id'],condition=cell['condition'],method=cell['method'],
                    repetition=cell['repetition'],phase=row['phase'],message_id=row['message_id'],error=row['error'],
                    ack_received=row['ack_received'],delivered_observed=row.get('delivered_observed'),comparable=cell['comparable']))
        if not cell['comparable'] or cell['status']!='completed' or len(cell['messages'])!=3:
            excluded.append(dict(index=index,reason='cell_incomplete_or_incomparable',experiment_id=cell['experiment_id'],**spec))
            continue
        groups[(cell['condition'],cell['method'])].append(cell)
        ack=[row for row in cell['messages'] if row['ack_received']]
        trial_rows.append(dict(experiment_id=cell['experiment_id'],**spec,attempted=len(cell['messages']),
            delivered=sum(row['delivered_observed'] for row in cell['messages']),ack_received=len(ack),
            ack_latency_mean_ms=distribution([row['client_elapsed_ms'] for row in ack])['mean'] if ack else None,
            retries_total=sum(row['retries'] for row in cell['messages'] if row['retries'] is not None),
            control_bytes_per_second=cell['overhead']['framed_bytes_per_second'],
            control_bytes=cell['overhead']['framed_bytes'],gossip_delta_bytes=cell['overhead']['gossip_delta_bytes']))
    result=[]
    for (condition,method),cells in sorted(groups.items()):
        messages=[row for cell in cells for row in cell['messages']]
        ack=[row for row in messages if row['ack_received']]
        alternates=[a['route_calculation_ms'] for row in messages for a in (row.get('raw_response') or {}).get('attempts',[])
                    if a['route']!=ROUTE]
        result.append(dict(condition=condition,method=method,independent_cells=len(cells),attempted=len(messages),
            delivered=sum(row['delivered_observed'] for row in messages),ack_received=len(ack),
            delivery_rate=sum(row['delivered_observed'] for row in messages)/len(messages),ack_rate=len(ack)/len(messages),
            ack_latency=distribution([row['client_elapsed_ms'] for row in ack]),
            alternate_route_calculation=distribution(alternates),
            source_n2_detection=distribution([o['detection_ms'] for cell in cells for o in cell['detection_observations']
                                             if o['observer']=='N1' and o['target']=='N2']),
            n2_fault_to_first_ack=distribution([f['first_ack_after_fault_ms'] for cell in cells for f in cell['faults'] if f['node']=='N2']),
            n2_no_ack_episodes=sum(f['first_ack_after_fault_ms'] is None for cell in cells for f in cell['faults'] if f['node']=='N2'),
            retries_total=sum(row['retries'] for row in messages if row['retries'] is not None),
            control_bytes_per_second=distribution([cell['overhead']['framed_bytes_per_second'] for cell in cells],'bytes/s'),
            errors={error:sum(row['error']==error for row in messages) for error in sorted({row['error'] for row in messages if row['error']})}))
    analysis=dict(run_id=manifest['run_id'],purpose=manifest['purpose'],excluded_cells=excluded,conditions=result,
                  analyzer_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
    write_observation(directory/'analysis.json',analysis)
    for name,rows in (('trial-summary.csv',trial_rows),('failed-messages.csv',failures)):
        # Headers exist even if there were no failures.
        fields=list(rows[0]) if rows else ['experiment_id','condition','method','message_id','error']
        with (directory/name).open('w',encoding='utf-8-sig',newline='') as stream:
            writer=csv.DictWriter(stream,fieldnames=fields)
            writer.writeheader()
            writer.writerows(rows)
    lines=['| 조건 | 방식 | 독립 셀 | 전달/시도 | ACK/시도 | 성공 ACK 지연 평균 ms | 중앙값 ms | p95 ms | 재전송 |',
           '|---|---|---:|---:|---:|---:|---:|---:|---:|']
    for row in result:
        stats=row['ack_latency']
        values=[f"{stats[key]:.3f}" if stats else '미측정' for key in ('mean','median','p95')]
        lines.append(f"| {row['condition']} | {row['method']} | {row['independent_cells']} | {row['delivered']}/{row['attempted']} | {row['ack_received']}/{row['attempted']} | {' | '.join(values)} | {row['retries_total']} |")
    (directory/'results-table.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
    return analysis


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory',type=Path)
    args=parser.parse_args()
    result=analyze(args.directory)
    print(f"Analyzed {len(result['conditions'])} condition/method groups; excluded cells: {len(result['excluded_cells'])}")
