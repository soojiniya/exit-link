"""Unit fixtures never appear in the contest pilot's measured results."""
import asyncio

import pytest

from exit_link.experiments.comparison import CONDITIONS, distribution, schedule, summarize, trial


def test_schedule_is_seeded_and_counterbalanced():
    cells=schedule(2,20261021)
    assert cells==schedule(2,20261021) and len(cells)==20
    for condition in CONDITIONS:
        by_repeat=[[cell['method'] for cell in cells if cell['condition']==condition and cell['repetition']==r] for r in range(2)]
        assert by_repeat[0]==list(reversed(by_repeat[1]))
        assert set(by_repeat[0])=={'fixed','exit_link'}


def test_empty_metrics_are_unmeasured_not_zero():
    assert distribution([]) is None
    assert distribution([None]) is None


def test_nearest_rank_percentile_and_zero_measurement():
    stats=distribution(list(range(100)))
    assert stats['n']==100 and stats['mean']==49.5 and stats['median']==49.5
    assert stats['p95']==94 and stats['p99']==98 and stats['minimum']==0


def test_failed_messages_stay_in_denominator_and_latency_is_separate():
    def row(ack,delivered,elapsed,error):
        return dict(phase='synthetic',ack_received=ack,delivered_observed=delivered,client_elapsed_ms=elapsed,
                    route_calculation_ms=None,retries=0,error=error)
    cells=[dict(condition='unit_fixture',method='fixed',messages=[row(True,True,10,None),row(False,False,100,'timeout'),
                row(False,True,20,'ack_missing')])]
    stats=summarize(cells)[0]
    assert stats['attempted']==3 and stats['ack_rate']==1/3 and stats['delivery_rate']==2/3
    assert stats['ack_success_latency']['n']==1 and stats['ack_success_latency']['mean']==10
    assert stats['all_response_latency']['n']==3 and stats['route_calculation'] is None
    assert stats['errors']=={'ack_missing':1,'timeout':1}


def test_analysis_rejects_validation_data_instead_of_mixing_samples(tmp_path):
    import json
    from scripts.analyze_comparison import analyze
    (tmp_path/'manifest.json').write_text(json.dumps({'purpose':'regression_validation'}),encoding='utf-8')
    with pytest.raises(ValueError,match='Not a contest pilot'):
        analyze(tmp_path)


def test_analysis_retains_failed_messages_and_separates_incomparable_cells(tmp_path):
    import json
    from scripts.analyze_comparison import analyze
    spec=dict(condition='normal',method='fixed',repetition=0)
    manifest=dict(purpose='contest_comparison_pilot',run_id='unit-fixture',schedule=[spec,dict(spec,repetition=1)])
    (tmp_path/'manifest.json').write_text(json.dumps(manifest),encoding='utf-8')
    folder=tmp_path/'t00'
    folder.mkdir()
    rows=[dict(phase='unit_fixture',message_id=str(i),ack_received=i==0,delivered_observed=i==0,
        error=None if i==0 else 'timeout',client_elapsed_ms=10 if i==0 else 100,retries=0,raw_response=None) for i in range(3)]
    cell=dict(experiment_id='unit-fixture',**spec,comparable=True,status='completed',messages=rows,
        faults=[],detection_observations=[],overhead=dict(framed_bytes_per_second=0,framed_bytes=0,gossip_delta_bytes=0))
    (folder/'trial.json').write_text(json.dumps(cell),encoding='utf-8')
    result=analyze(tmp_path)
    assert len(result['excluded_cells'])==1 and result['excluded_cells'][0]['reason']=='cell_not_recorded'
    measured=result['conditions'][0]
    assert measured['attempted']==3 and measured['ack_rate']==1/3 and measured['ack_latency']['n']==1
    assert measured['ack_latency']['mean']==10
    assert len((tmp_path/'failed-messages.csv').read_text(encoding='utf-8-sig').splitlines())==3


@pytest.mark.parametrize('method',['fixed','exit_link'])
def test_real_pilot_cell_receives_messages_and_cleans_processes_and_ports(tmp_path,method):
    record=asyncio.run(trial(tmp_path/'cell',dict(condition='normal',method=method,repetition=0)))
    assert record['status']=='completed' and record['comparable'],record
    assert len(record['messages'])==3 and all(row['ack_received'] and row['delivered_observed'] for row in record['messages'])
    assert all(row['destination_received_count']==1 for row in record['messages'])
    assert record['cleanup']['all_owned_processes_exited']
    assert all(p['available'] for p in record['cleanup']['ports'])
    if method=='fixed':
        assert record['overhead']['heartbeat_frames']==0
        assert all(row['route_calculation_ms'] is None for row in record['messages'])
    else:
        assert record['overhead']['framed_bytes']>0
        assert 0<record['overhead']['gossip_delta_bytes']<record['overhead']['framed_bytes']
        assert all(row['route_calculation_ms'] is not None for row in record['messages'])
