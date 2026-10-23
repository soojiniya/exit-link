"""Separate aligned-v2 analysis; never overwrites pilot analysis."""
import argparse
import json
import csv
import hashlib
from collections import defaultdict
from pathlib import Path

from exit_link.experiments.comparison import distribution
from exit_link.experiments.inference import wilson, paired_interval
from exit_link.experiments.safety import atomic_json
from exit_link.experiments.study import design_hash


def analyze(directory, *, expected_protocol='aligned_v2'):
    directory=Path(directory)
    plan=json.loads((directory/'plan.json').read_text(encoding='utf-8'))
    if plan['purpose']!='contest_main_study' or plan['protocol_version']!=expected_protocol:
        raise ValueError('Expected main study '+expected_protocol)
    if plan['design_sha256']!=design_hash(plan):
        raise ValueError('Prepared design modified')
    groups=defaultdict(dict)
    excluded=[]
    raw_messages=[]
    raw_cells=[]
    for index,spec in enumerate(plan['schedule']):
        path=directory/f't{index:03}'/'trial.json'
        if not path.exists():
            excluded.append(dict(index=index,reason='not_executed'))
            continue
        cell=json.loads(path.read_text(encoding='utf-8'))
        if expected_protocol=='aligned_v3' and cell.get('protocol_version')!=expected_protocol:
            raise ValueError('Mixed execution protocols cannot be analyzed together')
        if any(cell[k]!=spec[k] for k in ('condition','method','fault_timing','repetition')):
            raise ValueError('Cell identity mismatch')
        checkpoint=plan['completed'].get(str(index))
        reason=None
        if not checkpoint or checkpoint['sha256']!=hashlib.sha256(path.read_bytes()).hexdigest():
            reason='uncheckpointed_or_modified_cell'
        elif cell['status']!='completed' or len(cell['messages'])!=3:
            reason='incomplete_or_execution_failure'
        elif not cell['comparable']:
            reason='timing_excluded' if cell.get('error',{}).get('type')=='schedule_deviation' else 'cleanup_or_integrity_excluded'
        if expected_protocol=='aligned_v3' and reason is None:
            from exit_link.experiments.journal import inspect_journal
            try:
                if inspect_journal(path.parent/'journal.jsonl')!=checkpoint.get('journal_manifest'):
                    reason='journal_integrity_failure'
            except (OSError, ValueError, KeyError):
                reason='journal_integrity_failure'
        raw_cells.append(cell)
        for m in cell['messages']:
            raw_messages.append({**m,'experiment_id':cell['experiment_id'],'condition':spec['condition'],
                'fault_timing':spec['fault_timing'],'method':spec['method'],'repetition':spec['repetition'],
                'comparable':cell['comparable'],'cell_exclusion_reason':reason})
        if reason:
            excluded.append(dict(index=index,reason=reason))
            continue
        groups[(spec['condition'],spec['fault_timing'],spec['repetition'])][spec['method']]=cell
    strata=defaultdict(list)
    for (condition,timing,repetition),methods in groups.items():
        if set(methods)!= {'fixed','exit_link'}:
            excluded.append(dict(condition=condition,fault_timing=timing,repetition=repetition,reason='unmatched_pair'))
        else:
            strata[condition,timing].append(methods)
    output=[]
    for (condition,timing),blocks in sorted(strata.items()):
        for position in range(3):
            row=dict(condition=condition,fault_timing=timing,message_position=position,independent_pairs=len(blocks),methods={})
            pairs=[]
            for method in ('fixed','exit_link'):
                messages=[sorted(b[method]['messages'],key=lambda r:r['scheduled_perf_ns'])[position] for b in blocks]
                row['methods'][method]=dict(delivery=wilson(sum(m['delivered_observed'] for m in messages),len(messages)),
                    ack=wilson(sum(m['ack_received'] for m in messages),len(messages)),
                    ack_latency=distribution([m['client_elapsed_ms'] for m in messages if m['ack_received']]),
                    errors={e:sum(m['error']==e for m in messages) for e in sorted({m['error'] for m in messages if m['error']})})
            for b in blocks:
                a=sorted(b['fixed']['messages'],key=lambda r:r['scheduled_perf_ns'])[position]
                z=sorted(b['exit_link']['messages'],key=lambda r:r['scheduled_perf_ns'])[position]
                pairs.append((int(a['delivered_observed']),int(z['delivered_observed'])))
            row['paired_delivery_difference']=paired_interval(pairs)
            output.append(row)
    result=dict(run_id=plan['run_id'],protocol_version=expected_protocol,purpose='main_study_analysis',
                planned_cells=len(plan['schedule']),recorded_cells=len(raw_cells),checkpointed_cells=len(plan['completed']),
                position_statistics=output,exclusions=excluded,multiplicity='exploratory_unadjusted_95_percent',
                latency_intervals='not_computed_conditional_on_ack; descriptive_mean_median_p95_only',
                cell_metrics=[dict(experiment_id=c['experiment_id'],condition=c['condition'],fault_timing=c['fault_timing'],
                    method=c['method'],repetition=c['repetition'],comparable=c['comparable'],
                    status=c['status'],error=c.get('error'),timing_valid=c.get('timing_valid'),
                    faults=c['faults'],overhead=c.get('overhead'),detection=c.get('detection_observations'),restart=c.get('restart')) for c in raw_cells])
    atomic_json(directory/'main-analysis.json',result)
    with (directory/'main-messages.csv').open('w',encoding='utf-8-sig',newline='') as stream:
        columns=sorted({k for m in raw_messages for k in m}) or ['experiment_id','message_id','error']
        writer=csv.DictWriter(stream,fieldnames=columns)
        writer.writeheader()
        writer.writerows({k:json.dumps(v) if isinstance(v,(dict,list)) else v for k,v in m.items()} for m in raw_messages)
    return result


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory',type=Path)
    args=parser.parse_args()
    result=analyze(args.directory)
    print('Position strata:',len(result['position_statistics']),'exclusions:',len(result['exclusions']))
