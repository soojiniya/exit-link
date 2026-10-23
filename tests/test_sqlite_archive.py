"""Archive transaction/lifecycle tests. Synthetic unit fixtures are not TCP results."""
import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path
from uuid import uuid4

import apsw
import pytest

from exit_link.api.contracts import ExperimentChanged, ExperimentView, ScenarioChanged
from exit_link.evacuation.service import ScenarioSession
from exit_link.storage.archive import Archive, StorageUnavailable, utc
from exit_link.storage.schema import APPLICATION_ID, VERSION, CHECKSUM
from exit_link.topology.loader import load_building, load_communication


def fixture_record(status="running", seq=1, exp_id=None):
    exp_id = exp_id or uuid4()
    view = ExperimentView(enabled=True,experiment_id=exp_id,status=status)
    event = ExperimentChanged(stream_id=uuid4(),sequence=seq,payload=view)
    context = {"experiment_id":str(exp_id),"created_at":event.timestamp.isoformat(),
        "view":view.model_dump(mode="json"),"conditions":{"fixture_origin":"unit_test"},
        "topology":load_communication().model_dump(mode="json")}
    return event.model_dump(mode="json"),context


def test_schema_wal_constraints_and_normal_restart(tmp_path):
    path=tmp_path/'archive.sqlite3'
    async def check():
        archive=Archive(path)
        event,ctx=fixture_record("stopped")
        try:
            await archive.start()
            assert archive.status().state=="ready"
            assert archive.status().journal_mode=="wal"
            assert archive.status().sqlite_version==apsw.sqlitelibversion()
            archive.record("event",event,ctx)
            page=await archive.query("experiments")
            assert len(page.items)==1 and page.items[0].status=="stopped"
        finally:
            await archive.close()
        con=apsw.Connection(str(path))
        try:
            assert con.execute("PRAGMA application_id").fetchone()==(APPLICATION_ID,)
            assert con.execute("PRAGMA user_version").fetchone()==(VERSION,)
            assert con.execute("SELECT checksum FROM schema_migrations").fetchone()==(CHECKSUM,)
            assert con.execute("PRAGMA integrity_check").fetchone()==("ok",)
            assert con.execute("PRAGMA foreign_key_check").fetchall()==[]
            assert con.execute("SELECT end_reason FROM backend_runs").fetchone()==("normal",)
            assert con.execute("SELECT name FROM sqlite_master WHERE type='index' AND name='events_by_experiment'").fetchone()
        finally:
            con.close()
        second=Archive(path)
        try:
            await second.start()
            assert (await second.query("experiments")).items[0].experiment_id==page.items[0].experiment_id
            assert second.run_id != archive.run_id
        finally:
            await second.close()
    asyncio.run(check())


def test_duplicate_events_and_control_intents_are_idempotent(tmp_path):
    async def check():
        archive=Archive(tmp_path/'a.sqlite3')
        event,ctx=fixture_record()
        action={"action_id":str(uuid4()),"action":"kill","node_id":"N2","requested_at":utc(),"completed_at":None,
            "state":"requested","details":{"fault_type":"owned_process_kill"}}
        try:
            archive.record("event",event,ctx)
            archive.record("event",event,ctx)
            archive.record("control",action,ctx)
            archive.record("control",dict(action,state="succeeded",completed_at=utc()),ctx)
            archive.record("control",action,ctx)  # delayed duplicate intent cannot undo completion
            assert len((await archive.query("events",experiment_id=ctx["experiment_id"])).items)==1
            actions=(await archive.query("controls",experiment_id=ctx["experiment_id"])).items
            assert len(actions)==1 and actions[0].state=="succeeded"
        finally:
            await archive.close()
    asyncio.run(check())


def test_content_conflict_rolls_back_and_is_reported(tmp_path):
    async def check():
        archive=Archive(tmp_path/'a.sqlite3')
        event,ctx=fixture_record()
        try:
            archive.record("event",event,ctx)
            changed=json.loads(json.dumps(event))
            changed['payload']['last_error']='conflicting content'
            archive.record("event",changed,ctx)
            events=await archive.query("events",experiment_id=ctx["experiment_id"])
            assert len(events.items)==1 and events.items[0].payload['last_error'] is None
            assert archive.status().state=='degraded' and archive.status().failed==1
            # A read barrier persists the marker even if the failed write was the last event.
            assert not (await archive.query('detail',experiment_id=ctx['experiment_id'])).recording_complete
            assert list(tmp_path.glob('archive-errors-*.jsonl'))
        finally:
            await archive.close()
    asyncio.run(check())


@pytest.mark.parametrize('bad', ['invalid_model','unknown_operation','negative_measurement'])
def test_invalid_data_is_not_silently_stored(tmp_path,bad):
    async def check():
        archive=Archive(tmp_path/'a.sqlite3')
        event,ctx=fixture_record()
        try:
            archive.record('event',event,ctx)
            if bad=='invalid_model':
                archive.record('event',{'type':'guidance.result','payload':{}},ctx)
            elif bad=='unknown_operation':
                archive.record('arbitrary_sql',{'query':'DROP TABLE experiments'},ctx)
            else:
                from exit_link.api.contracts import FaultObserved
                from exit_link.evacuation.dashboard import NetworkEvent
                observation=FaultObserved(stream_id=uuid4(),sequence=2,payload=NetworkEvent(event='neighbor_down',node_id='N1',
                    timestamp=utc(),details={'neighbor':'N2','detection_since_first_failure_ms':-1}))
                archive.record('event',observation.model_dump(mode='json'),ctx)
            assert len((await archive.query('events',experiment_id=ctx['experiment_id'])).items)==1
            assert archive.status().failed==1
        finally:
            await archive.close()
    asyncio.run(check())


def test_same_scenario_revision_can_add_plans_without_hazard_conflict(tmp_path):
    async def check():
        archive=Archive(tmp_path/'a.sqlite3')
        event,ctx=fixture_record()
        session=ScenarioSession(load_building())
        session.plan('F2_E')
        try:
            archive.record('event',event,ctx)
            for i in range(2):
                snapshot=ScenarioChanged(stream_id=uuid4(),sequence=i+1,payload=session.snapshot())
                archive.record('event',snapshot.model_dump(mode='json'),ctx)
                session.plan('F3_W')
            assert len((await archive.query('events',experiment_id=ctx['experiment_id'])).items)==3
            assert archive.status().failed==0
        finally:
            await archive.close()
    asyncio.run(check())


def test_access_failure_is_explicit_not_an_empty_history(tmp_path):
    invalid=tmp_path/'directory'
    invalid.mkdir()
    async def check():
        archive=Archive(invalid)
        try:
            await archive.start()
            assert archive.status().state=='degraded'
            with pytest.raises(StorageUnavailable):
                await archive.query('experiments')
        finally:
            await archive.close()
    asyncio.run(check())


def test_second_backend_cannot_reclassify_a_live_owner_as_interrupted(tmp_path):
    async def check():
        a,b=Archive(tmp_path/'a.sqlite3'),Archive(tmp_path/'a.sqlite3')
        event,ctx=fixture_record()
        try:
            a.record('event',event,ctx)
            await a.query('barrier')
            await b.start()
            assert b.status().state=='degraded'
            assert (await a.query('detail',experiment_id=ctx['experiment_id'])).status=='running'
        finally:
            await b.close()
            await a.close()
    asyncio.run(check())


def test_crashed_process_keeps_committed_records_and_marks_interruption(tmp_path):
    event,ctx=fixture_record()
    payload=tmp_path/'fixture.json'
    payload.write_text(json.dumps([event,ctx]),encoding='utf-8')
    path=tmp_path/'crash.sqlite3'
    code="""import asyncio,json,os,sys
from exit_link.storage.archive import Archive
a=Archive(sys.argv[1])
event,ctx=json.load(open(sys.argv[2],encoding='utf-8'))
a.record('event',event,ctx)
asyncio.run(a.query('barrier'))
os._exit(23)
"""
    env=dict(os.environ)
    executable=sys.executable
    if os.name=='nt' and sys.prefix!=sys.base_prefix:
        executable=sys._base_executable
        env['__PYVENV_LAUNCHER__']=sys.executable
    result=subprocess.run([executable,'-c',code,str(path),str(payload)],env=env,capture_output=True,timeout=20)
    assert result.returncode==23,result.stderr.decode(errors='replace')
    async def check():
        archive=Archive(path)
        try:
            await archive.start()
            record=await archive.query('detail',experiment_id=ctx['experiment_id'])
            assert record.status=='interrupted'
            assert not record.recording_complete
            assert record.ended_at is None and record.interruption_detected_at is not None
            assert len((await archive.query('events',experiment_id=ctx['experiment_id'])).items)==1
        finally:
            await archive.close()
    asyncio.run(check())


def test_wal_reader_snapshot_allows_writer_commit_and_busy_is_visible(tmp_path):
    async def check():
        archive=Archive(tmp_path/'wal.sqlite3')
        first,ctx=fixture_record()
        reader=blocker=None
        try:
            archive.record('event',first,ctx)
            await archive.query('barrier')
            reader=apsw.Connection(str(archive.path))
            reader.execute('BEGIN')
            assert reader.execute('SELECT count(*) FROM event_log').fetchone()==(1,)
            second,_=fixture_record('stopped',exp_id=ctx['experiment_id'])
            archive.record('event',second,ctx)
            assert len((await archive.query('events',experiment_id=ctx['experiment_id'])).items)==2
            assert reader.execute('SELECT count(*) FROM event_log').fetchone()==(1,)
            reader.execute('ROLLBACK')
            assert reader.execute('SELECT count(*) FROM event_log').fetchone()==(2,)
            blocker=apsw.Connection(str(archive.path))
            blocker.execute('BEGIN IMMEDIATE')
            bad,_=fixture_record(exp_id=ctx['experiment_id'])
            archive.record('event',bad,ctx)
            # Do not use a history barrier while deliberately holding the writer lock.
            await asyncio.to_thread(archive.jobs.join)
            assert archive.status().failed==1 and 'BusyError' in archive.status().last_error
            blocker.execute('ROLLBACK')
            detail=await archive.query('detail',experiment_id=ctx['experiment_id'])
            assert not detail.recording_complete
            assert len((await archive.query('events',experiment_id=ctx['experiment_id'])).items)==2
        finally:
            if blocker:
                blocker.close()
            if reader:
                reader.close()
            await archive.close()
    asyncio.run(check())


def test_bounded_queue_overflow_is_counted_and_persisted(tmp_path):
    archive=Archive(tmp_path/'bounded.sqlite3',capacity=1)
    # Hold startup to fill the actual bounded queue deterministically.
    archive._ensure_thread=lambda: None
    first,ctx=fixture_record()
    assert archive.record('event',first,ctx)
    assert not archive.record('event',first,ctx)
    assert archive.status().pending==1 and archive.status().dropped==1
    del archive._ensure_thread
    async def check():
        archive._ensure_thread()
        await asyncio.to_thread(archive.jobs.join)
        try:
            assert not (await archive.query('detail',experiment_id=ctx['experiment_id'])).recording_complete
        finally:
            await archive.close()
    asyncio.run(check())


def test_delivery_idempotence_and_cross_experiment_guidance_conflict(tmp_path):
    from exit_link.evacuation.transport import GuidanceDelivery
    from exit_link.api.contracts import DeliveryObserved
    async def check():
        archive=Archive(tmp_path/'messages.sqlite3')
        event,ctx=fixture_record()
        session=ScenarioSession(load_building())
        guidance=session.guidance('F2_E','N1','N4')
        prepared={'guidance':guidance.model_dump(mode='json'),'scenario':session.snapshot().model_dump(mode='json')}
        # Explicit synthetic fixture: no fabricated TCP timing, ACK or success.
        result=GuidanceDelivery(message_id=guidance.guidance_id,scenario_id=guidance.scenario_id,
            scenario_revision=guidance.scenario_revision,route_version=guidance.route_version,
            audience_id=guidance.audience_id,source_node='N1',destination_node='N4',
            ack_received=False,transport_error='unit_fixture_no_connection')
        try:
            archive.record('event',event,ctx)
            archive.record('guidance',prepared,ctx)
            archive.record('guidance',prepared,ctx)
            for i in range(2):
                observed=DeliveryObserved(stream_id=uuid4(),sequence=i+1,payload=result)
                archive.record('event',observed.model_dump(mode='json'),ctx)
            assert len((await archive.query('deliveries',experiment_id=ctx['experiment_id'])).items)==1
            comparison=(await archive.query('comparison',experiment_ids=[ctx['experiment_id']])).items[0]
            assert comparison.delivery_latency is None and comparison.retries_total is None
            assert archive.status().failed==0
            other,other_ctx=fixture_record()
            archive.record('event',other,other_ctx)
            archive.record('guidance',prepared,other_ctx)
            await archive.query('barrier')
            assert archive.status().failed==1
            assert (await archive.query('deliveries',experiment_id=other_ctx['experiment_id'])).items==[]
        finally:
            await archive.close()
    asyncio.run(check())
