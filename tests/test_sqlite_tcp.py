"""Actual HTTP/TCP/WAL lifecycle and unavailable-DB isolation on Windows."""
import json
import os
import secrets
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx2
import pytest


class Server:
    def __init__(self, directory, database_path=None):
        self.directory=Path(directory)
        self.directory.mkdir(parents=True,exist_ok=True)
        self.database=database_path or self.directory/'history.sqlite3'
        self.token=secrets.token_urlsafe(32)
        self.process=None
        self.handles=[]
        self.start_number=0

    def start(self):
        with socket.socket() as reserve:
            reserve.bind(('127.0.0.1',0))
            port=reserve.getsockname()[1]
        env=dict(os.environ,EXIT_LINK_CONTROL_TOKEN=self.token,EXIT_LINK_ENABLE_EXPERIMENTS='1',
            EXIT_LINK_DATABASE_PATH=str(self.database),EXIT_LINK_STAGE5_ARTIFACT_DIR=str(self.directory/'nodes'),PYTHONUTF8='1')
        executable=sys.executable
        if os.name=='nt' and sys.prefix!=sys.base_prefix:
            executable=sys._base_executable
            env['__PYVENV_LAUNCHER__']=sys.executable
        self.start_number+=1
        path=self.directory/f'server-{self.start_number}.log'
        handle=path.open('w',encoding='utf-8')
        self.handles.append(handle)
        self.process=subprocess.Popen([executable,'-m','uvicorn','exit_link.main:app','--host','127.0.0.1','--port',str(port),
            '--workers','1','--no-proxy-headers'],env=env,cwd=Path(__file__).resolve().parents[1],stdout=handle,stderr=subprocess.STDOUT,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
        self.client=httpx2.Client(base_url=f'http://127.0.0.1:{port}',trust_env=False,timeout=40,headers={'X-Exit-Link-Token':self.token})
        deadline=time.monotonic()+15
        while time.monotonic()<deadline:
            assert self.process.poll() is None,path.read_text(encoding='utf-8')
            try:
                if self.client.get('/health').status_code==200:
                    return self
            except httpx2.TransportError:
                pass
            time.sleep(.04)
        raise TimeoutError('Archive HTTP server readiness timeout')

    def stop(self):
        if self.process and self.process.poll() is None:
            try:
                response=self.client.delete('/api/v1/experiment')
                assert response.status_code==200,response.text
                # Wait until all preceding archive writes commit before terminating Uvicorn.
                self.client.get('/api/v1/history/experiments')
            finally:
                self.process.terminate()
                self.process.wait(timeout=10)
                self.client.close()
        for handle in self.handles:
            handle.close()


@pytest.fixture(scope='module')
def server(tmp_path_factory):
    configured=os.environ.get('EXIT_LINK_SQLITE_ARTIFACT_DIR')
    output=Path(configured) if configured else tmp_path_factory.mktemp('sqlite-tcp')
    service=Server(output).start()
    try:
        yield service
    finally:
        service.stop()


def send(client,sid):
    response=client.post(f'/api/v1/scenarios/{sid}/guidance',json={
        'start_location':'F2_E','source_node':'N1','destination_node':'N4','expected_revision':1})
    assert response.status_code==200,response.text
    result=response.json()
    assert result['ack_received'] and result['transport_result']['success']
    return result


def test_real_fault_deliveries_events_and_metrics_are_persisted(server):
    c=server.client
    started=c.post('/api/v1/experiment')
    assert started.status_code==200,started.text
    eid=started.json()['experiment_id']
    created=c.post('/api/v1/scenarios',json={'starts':['F2_E']})
    assert created.status_code==201
    sid=created.json()['state']['scenario_id']
    before=send(c,sid)
    assert before['transport_result']['ack']['route']==['N1','N2','N4']
    assert before['application_receipt']['disposition']=='applied'
    assert c.post('/api/v1/experiment/nodes/N2/fail').status_code==200
    deadline=time.monotonic()+15
    while time.monotonic()<deadline:
        view=c.post('/api/v1/network/refresh').json()
        n1=next(n for n in view['nodes'] if n['node_id']=='N1')
        if any(n['node_id']=='N2' and n['status']=='down' for n in n1['neighbors']):
            break
    else:
        pytest.fail('Heartbeat did not confirm real N2 failure')
    after=send(c,sid)
    assert after['transport_result']['ack']['route']==['N1','N3','N4']
    assert c.post('/api/v1/experiment/nodes/N2/recover').status_code==200
    stopped=c.delete('/api/v1/experiment')
    assert stopped.status_code==200,stopped.text
    records=c.get(f'/api/v1/history/experiments/{eid}/deliveries').json()['items']
    assert {r['delivery']['message_id'] for r in records}=={before['message_id'],after['message_id']}
    assert all(r['experiment_id']==eid for r in records)
    assert all(not r['delivery']['human_evacuation_verified'] for r in records)
    controls=c.get(f'/api/v1/history/experiments/{eid}/controls').json()['items']
    kill=next(a for a in controls if a['action']=='kill')
    assert kill['node_id']=='N2' and kill['details']['fault']['fault']=='owned_process_kill'
    faults=c.get(f'/api/v1/history/experiments/{eid}/events',params={'event_type':'neighbor_down'}).json()['items']
    assert any(e['payload']['details'].get('neighbor')=='N2' for e in faults)
    routes=c.get(f'/api/v1/history/experiments/{eid}/events',params={'event_type':'route_selected'}).json()['items']
    assert len(routes)>=2
    comparison=c.get('/api/v1/history/comparison',params={'experiment_id':eid}).json()['items'][0]
    assert comparison['recorded_deliveries']==2 and comparison['ack_received']==2
    assert comparison['delivery_latency']['n']==2 and comparison['route_changes']==1
    assert comparison['heartbeat_detection']['n']>=1
    assert comparison['recording_complete']
    assert c.get('/api/v1/history/status').json()['failed']==0
    (server.directory/'recorded-experiment.json').write_text(json.dumps({'experiment_id':eid,'deliveries':records,
        'controls':controls,'faults':faults,'comparison':comparison},ensure_ascii=False,indent=2),encoding='utf-8')


def test_actual_server_restart_retains_history_without_reviving_live_nodes(tmp_path):
    # Own this test's setup: it must run alone and after another test fails.
    # Keep the short artifact root used by the other Windows TCP/WAL tests.
    root=Path(os.environ['EXIT_LINK_SQLITE_ARTIFACT_DIR'])/'restart' if os.environ.get('EXIT_LINK_SQLITE_ARTIFACT_DIR') else tmp_path
    service=Server(root).start()
    try:
        c=service.client
        started=c.post('/api/v1/experiment')
        assert started.status_code==200,started.text
        eid=started.json()['experiment_id']
        scenario=c.post('/api/v1/scenarios',json={'starts':['F2_E']})
        assert scenario.status_code==201,scenario.text
        sid=scenario.json()['state']['scenario_id']
        sent=[send(c,sid),send(c,sid)]
        stopped=c.delete('/api/v1/experiment')
        assert stopped.status_code==200,stopped.text
        expected=c.get(f'/api/v1/history/experiments/{eid}/deliveries').json()['items']
        assert {r['delivery']['message_id'] for r in expected}=={r['message_id'] for r in sent}
        service.stop()
        service.start()
        c=service.client
        record=c.get(f'/api/v1/history/experiments/{eid}').json()
        assert record['status']=='stopped' and record['topology'] is not None
        assert c.get(f'/api/v1/history/experiments/{eid}/deliveries').json()['items']==expected
        assert c.get('/api/v1/scenarios').json()==[]
        assert c.get('/api/v1/experiment').json()['nodes']==[]
        (service.directory/'after-restart.json').write_text(json.dumps(record,ensure_ascii=False,indent=2),encoding='utf-8')
    finally:
        service.stop()


def test_actual_tcp_ack_survives_unavailable_database(tmp_path):
    # Keep artifact paths below the Windows legacy MAX_PATH ceiling. The full-suite
    # pytest temp + test name + experiment UUID exceeded it before any TCP start.
    root=Path(os.environ['EXIT_LINK_SQLITE_ARTIFACT_DIR'])/'db-error' if os.environ.get('EXIT_LINK_SQLITE_ARTIFACT_DIR') else tmp_path
    root.mkdir(parents=True,exist_ok=True)
    unavailable=root/'not-a-database'
    unavailable.mkdir()
    service=Server(root,database_path=unavailable).start()
    try:
        c=service.client
        started=c.post('/api/v1/experiment')
        assert started.status_code==200,started.text
        sid=c.post('/api/v1/scenarios',json={'starts':['F2_E']}).json()['state']['scenario_id']
        result=send(c,sid)
        assert result['application_receipt']['disposition']=='applied'
        assert c.get('/api/v1/history/status').json()['state']=='degraded'
        assert c.get('/api/v1/history/experiments').status_code==503
    finally:
        service.stop()
