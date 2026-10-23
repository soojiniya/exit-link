from uuid import uuid4

from fastapi.testclient import TestClient

from exit_link.api.security import ApiSettings
from exit_link.main import create_app


def client_for(path,**options):
    app=create_app(ApiSettings(monitor_enabled=False,artifact_directory=path,**options))
    return TestClient(app,base_url='http://127.0.0.1',client=('127.0.0.1',50000))


def test_empty_history_and_missing_experiment(tmp_path):
    with client_for(tmp_path) as client:
        assert client.get('/api/v1/history/status').json()['state']=='ready'
        assert client.get('/api/v1/history/experiments').json()=={'items':[],'next_cursor':None}
        eid=str(uuid4())
        assert client.get(f'/api/v1/history/experiments/{eid}').status_code==404
        assert client.get(f'/api/v1/history/experiments/{eid}/events').json()['items']==[]
        assert client.get(f'/api/v1/history/experiments/{eid}/deliveries').json()['items']==[]
        assert client.get('/api/v1/history/comparison',params={'experiment_id':eid}).json()=={'items':[]}


def test_history_security_and_query_validation(tmp_path):
    with client_for(tmp_path) as client:
        assert client.get('/api/v1/history/experiments',headers={'Origin':'https://evil.example'}).status_code==403
        for query in ('?limit=0','?limit=101','?cursor=-1'):
            assert client.get('/api/v1/history/experiments'+query).status_code==422
        assert client.get('/api/v1/history/comparison').status_code==422
        assert client.get('/api/v1/history/comparison?experiment_id=invalid').status_code==422


def test_disabled_and_unavailable_storage_preserve_health(tmp_path):
    for kwargs in ({'persistence_enabled':False},{'database_path':tmp_path}):
        with client_for(tmp_path,**kwargs) as client:
            assert client.get('/health').status_code==200
            result=client.get('/api/v1/history/experiments')
            assert result.status_code==503
            assert result.json()['detail']['code']=='storage_unavailable'


def test_memory_scenario_survives_db_error_without_being_reported_as_archived(tmp_path):
    token='unit-storage-token-'+'x'*32
    with client_for(tmp_path,database_path=tmp_path,control_token=token) as client:
        response=client.post('/api/v1/scenarios',headers={'X-Exit-Link-Token':token},json={'starts':['F2_E']})
        assert response.status_code==201
        sid=response.json()['state']['scenario_id']
        assert client.get(f'/api/v1/scenarios/{sid}').json()['plans'][0]['status']=='route_found'
        assert client.get('/api/v1/history/status').json()['state']=='degraded'


def test_history_pagination_filters_and_unmeasured_comparison(tmp_path):
    from exit_link.api.contracts import ExperimentChanged, ExperimentView
    with client_for(tmp_path) as client:
        backend=client.app.state.backend
        ids=[]
        for _ in range(3):
            eid=uuid4()
            ids.append(str(eid))
            view=ExperimentView(enabled=True,experiment_id=eid,status='stopped')
            context={'experiment_id':str(eid),'created_at':'2026-10-21T00:00:00Z',
                'view':view.model_dump(mode='json'),'conditions':{'origin':'synthetic_unit_fixture'}}
            for seq in range(1,4):
                event=ExperimentChanged(stream_id=uuid4(),sequence=seq,payload=view)
                backend.archive.record('event',event.model_dump(mode='json'),context)
        first=client.get('/api/v1/history/experiments?limit=2').json()
        assert [x['experiment_id'] for x in first['items']]==list(reversed(ids[1:]))
        second=client.get('/api/v1/history/experiments',params={'cursor':first['next_cursor'],'limit':2}).json()
        assert [x['experiment_id'] for x in second['items']]==ids[:1] and second['next_cursor'] is None
        base=f'/api/v1/history/experiments/{ids[0]}/events'
        page=client.get(base,params={'limit':2,'event_type':'experiment.changed'}).json()
        tail=client.get(base,params={'after':page['next_after'],'limit':2}).json()
        assert len(page['items'])==2 and len(tail['items'])==1 and tail['next_after'] is None
        assert client.get(base,params={'event_type':'neighbor_down'}).json()['items']==[]
        comparison=client.get('/api/v1/history/comparison',params=[('experiment_id',eid) for eid in ids]).json()
        assert len(comparison['items'])==3
        assert all(x['ack_rate'] is None and x['delivery_latency'] is None and x['heartbeat_detection'] is None
            and x['recorded_deliveries']==0 for x in comparison['items'])
