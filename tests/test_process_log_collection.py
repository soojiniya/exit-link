"""Synchronous replay of mixed process output, without pretending to send TCP."""
import asyncio
import json
import logging
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import HTTPException

from exit_link.api.runtime import Backend


def collector(directory, names=('N2-6.jsonl',)):
    backend = object.__new__(Backend)
    backend.experiment = SimpleNamespace(experiment_id=uuid4())
    backend.log_offsets = {}
    published, archived = [], []
    backend.publish = lambda model, payload, source_key=None: published.append((payload, source_key))
    backend.archive_context = lambda *args: {}
    backend.archive = SimpleNamespace(record=lambda *args: archived.append(args))
    cluster = SimpleNamespace(directory=directory, history=[dict(log=name, pid=21040) for name in names])
    return backend, cluster, published, archived


def event(name='node_stopped'):
    return dict(event=name, node='N2', timestamp='2026-10-21T04:39:45.327061+00:00',
                transport='tcp_loopback', observation_origin='real_process')


def encode(value):
    return json.dumps(value).encode()+b'\n'


def test_native_traceback_does_not_hide_following_events_or_republish_offsets(tmp_path, caplog):
    path=tmp_path/'N2-6.jsonl'
    data=encode(event('shutdown_requested'))+b'Exception in callback BaseProactorEventLoop\nTraceback (most recent call last):\nAssertionError\n'+encode(event())
    path.write_bytes(data)
    backend, cluster, published, _=collector(tmp_path)
    with caplog.at_level(logging.WARNING):
        backend.collect_logs(cluster)
        backend.collect_logs(cluster)
    assert [p.event for p, _ in published]==['shutdown_requested','node_stopped']
    assert len({key for _, key in published})==2
    assert backend.log_offsets[path]==len(data)
    assert len(caplog.records)==3
    assert all(r.diagnostic_code=='process_log_non_event' for r in caplog.records)
    assert path.read_bytes()==data


@pytest.mark.parametrize('bad', [b'\xff\xbc\n', b'[]\n', b'{broken}\n'])
def test_invalid_complete_line_is_reported_and_raw_bytes_preserved(tmp_path, caplog, bad):
    path=tmp_path/'N2-6.jsonl'
    path.write_bytes(bad+encode(event()))
    backend, cluster, published, _=collector(tmp_path)
    with caplog.at_level(logging.WARNING):backend.collect_logs(cluster)
    assert len(published)==1 and published[0][0].event=='node_stopped'
    assert caplog.records[0].byte_offset==0
    assert path.read_bytes()==bad+encode(event())


def test_partial_line_is_retried_only_after_its_newline_arrives(tmp_path):
    path=tmp_path/'N2-6.jsonl'
    initial=encode(event('shutdown_requested'))
    partial=encode(event())
    path.write_bytes(initial+partial[:20])
    backend, cluster, published, _=collector(tmp_path)
    backend.collect_logs(cluster)
    assert backend.log_offsets[path]==len(initial) and len(published)==1
    with path.open('ab') as stream:stream.write(partial[20:])
    backend.collect_logs(cluster)
    assert [p.event for p, _ in published]==['shutdown_requested','node_stopped']


def test_mixed_output_keeps_process_config_archiving(tmp_path):
    path=tmp_path/'N2-6.jsonl'
    path.write_bytes(b'Traceback diagnostic\n'+encode(dict(event='heartbeat_config', interval=.1)))
    backend, cluster, published, archived=collector(tmp_path)
    backend.collect_logs(cluster)
    assert not published and len(archived)==1
    assert archived[0][0]=='process_config'
    assert archived[0][2]['source_key'].endswith(':21')


def test_replays_windows_failure_log_without_parsing_error_or_altering_it(tmp_path, caplog):
    # Regression input reconstructed from the actual N2-6.jsonl failure shape.
    trace=(b'Exception in callback BaseProactorEventLoop._start_serving\n'
           b'  File "asyncio/base_events.py", line 295, in _attach\n'
           b'    assert self._sockets is not None\nAssertionError\n')
    path=tmp_path/'N2-6.jsonl'
    original=encode(event('shutdown_requested'))+encode(event())+trace
    path.write_bytes(original)
    backend, cluster, published, _=collector(tmp_path)
    with caplog.at_level(logging.WARNING):backend.collect_logs(cluster)
    assert len(published)==2 and len(caplog.records)==4
    assert path.read_bytes()==original


def test_async_real_cleanup_failure_still_returns_503():
    async def run():
        backend=object.__new__(Backend)
        backend.control_lock=asyncio.Lock()
        async def fail_close():raise RuntimeError('unit confirmed cleanup failure')
        backend.cluster=SimpleNamespace(close=fail_close)
        changes=[]
        backend.experiment_changed=lambda **kw: changes.append(kw)
        backend.control_intent=lambda *args: {}
        backend.control_completed=lambda *args, **kwargs: None
        backend.reset_network=lambda: None
        with pytest.raises(HTTPException) as error:await backend.stop_experiment()
        assert error.value.status_code==503
        assert error.value.detail['code']=='experiment_cleanup_failed'
        assert changes[-1]['status']=='failed'
        assert 'unit confirmed cleanup failure' in changes[-1]['last_error']
    asyncio.run(run())
