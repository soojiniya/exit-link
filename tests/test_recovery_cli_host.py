"""No actual CIM, sockets, approvals, experiment data or cell execution."""
import copy
import json
from pathlib import Path
import re
import subprocess
from types import SimpleNamespace

import pytest

from scripts import recovery_v3 as recovery


@pytest.fixture
def inventory(monkeypatch):
    venv = r"C:\venv\Scripts\python.exe"
    base = r"C:\Python312\python.exe"
    arguments = subprocess.list2cmdline([str(Path(recovery.__file__).resolve()), "execute", "unit-target", "--max-cells", "1"])
    parent = dict(ProcessId=200, ParentProcessId=20, Name="python.exe", ExecutablePath=venv,
                  CommandLine=f'"{venv}" {arguments}', CreationUtc="2026-10-21T00:00:00+00:00")
    current = dict(ProcessId=100, ParentProcessId=200, Name="python.exe", ExecutablePath=base,
                   CommandLine=f'"{base}" {arguments}', CreationUtc="2026-10-21T00:00:01+00:00")
    monkeypatch.setattr(recovery, "os", SimpleNamespace(name="nt", getpid=lambda:100, getppid=lambda:200))
    monkeypatch.setattr(recovery, "sys", SimpleNamespace(prefix=r"C:\venv", base_prefix=r"C:\Python312", executable=venv, _base_executable=base))
    return dict(status="observed", nodes=[copy.deepcopy(parent)], children=[copy.deepcopy(current)],
                unknown_processes=[], listeners=[], self_identity=[current, parent])


def observe(monkeypatch, inventory, *, bind_error=False):
    calls=[]
    def run(command, **kwargs):
        assert "ProcessId -eq 100" in command[-1] and "ProcessId -eq 200" in command[-1]
        return subprocess.CompletedProcess(command,0,json.dumps(inventory).encode(),b"")
    class Probe:
        def __enter__(self):return self
        def __exit__(self,*args):pass
        def setsockopt(self,*args):pass
        def bind(self,address):
            calls.append(address)
            if bind_error:raise OSError("unit occupied port")
    monkeypatch.setattr(recovery.subprocess,"run",run)
    monkeypatch.setattr(recovery.socket,"socket",Probe)
    return recovery.host_observation([56019,56020]),calls


def test_old_cli_predicate_matches_launcher_but_not_dry_run_or_import(inventory):
    command=inventory["nodes"][0]["CommandLine"]
    predicate=r"recovery_v3\.py\s+execute"
    assert re.search(predicate,command)
    assert not re.search(predicate,command.replace(" execute "," dry-run "))
    assert not re.search(predicate,'python.exe -c "from scripts.recovery_v3 import execution_preflight"')
    assert inventory["nodes"][0]["ProcessId"] != 100
    assert inventory["children"][0]["ProcessId"] == 100


def test_only_proven_current_launcher_is_excluded_and_ports_still_probed(monkeypatch,inventory):
    result,calls=observe(monkeypatch,inventory)
    assert result["ready"] and result["nodes"]==[] and result["children"]==[]
    assert result["verified_launcher"]["parent"]["ProcessId"]==200
    assert result["verified_launcher"]["current"]["ProcessId"]==100
    assert calls==[("127.0.0.1",56019),("127.0.0.1",56020)]


@pytest.mark.parametrize("problem",["missing_identity","different_parent","wrong_executable","different_arguments",
    "different_script","newer_parent","missing_creation","extra_child","peer_runner","unknown_python","listener","bind_failure"])
def test_launcher_proof_never_hides_other_host_blockers(monkeypatch,inventory,problem):
    current,parent=inventory["self_identity"]
    if problem=="missing_identity":inventory["self_identity"]=[]
    elif problem=="different_parent":current["ParentProcessId"]=201
    elif problem=="wrong_executable":parent["ExecutablePath"]=r"C:\other\python.exe"
    elif problem=="different_arguments":parent["CommandLine"]+=" --another-plan"
    elif problem=="different_script":
        for p in (current,parent):p["CommandLine"]=p["CommandLine"].replace(str(Path(recovery.__file__).resolve()),r"C:\other\recovery_v3.py")
    elif problem=="newer_parent":parent["CreationUtc"]="2026-10-21T00:00:02+00:00"
    elif problem=="missing_creation":parent.pop("CreationUtc")
    elif problem=="extra_child":inventory["children"].append(dict(ProcessId=101,ParentProcessId=200))
    elif problem=="peer_runner":inventory["nodes"].append(dict(ProcessId=201,CommandLine="other recovery_v3.py execute"))
    elif problem=="unknown_python":inventory["unknown_processes"].append(dict(ProcessId=999))
    elif problem=="listener":inventory["listeners"].append(dict(OwningProcess=999,LocalPort=56019))
    result,calls=observe(monkeypatch,inventory,bind_error=problem=="bind_failure")
    assert not result["ready"]
    if problem!="bind_failure":assert calls==[]


def test_failed_preflight_exposes_actual_report_without_entering_cli_executor(monkeypatch,inventory):
    host=dict(status="observed",ready=False,nodes=[dict(ProcessId=999)],children=[],listeners=[])
    monkeypatch.setattr(recovery,"check_approval",lambda *a:{})
    monkeypatch.setattr(recovery,"verify",lambda *a: ({},{"completed":{}},dict(owner_state=dict(state="clean"),host=host)))
    with pytest.raises(recovery.HostAuditError) as caught:recovery.execution_preflight(Path("unit"),Path("unit-approval"),1)
    assert caught.value.report==host and '"ProcessId": 999' in str(caught.value)


def test_execute_preflight_only_exits_before_event_loop_or_cell(monkeypatch,capsys):
    monkeypatch.setattr(recovery.sys,"argv",["recovery_v3.py","execute","unit-target","--approval","unit-approval","--max-cells","1","--preflight-only"])
    calls=[]
    def preflight(*args):
        calls.append(args)
        return {},{}, {},dict(host=dict(ready=True,observation_origin="unit_fixture"))
    monkeypatch.setattr(recovery,"execution_preflight",preflight)
    def forbidden(*args,**kwargs):raise AssertionError("preflight-only must not execute or create an event loop")
    monkeypatch.setattr(recovery,"execute",forbidden)
    monkeypatch.setattr(recovery.asyncio,"run",forbidden)
    assert recovery.main()==0 and len(calls)==1
    assert json.loads(capsys.readouterr().out)["status"]=="execute_preflight_only_no_execution"


def test_tool_update_rejects_old_manifest_and_approval_without_resigning(tmp_path,monkeypatch):
    target=tmp_path/"continuation";target.mkdir()
    manifest=dict(schema=recovery.PURPOSE,original_directory=str(tmp_path/"source"),recovery_tool_sha256=recovery.tool_hash())
    m=target/"manifest.json";m.write_text(json.dumps(manifest),encoding="utf-8")
    approval=dict(schema="residual_execution_approval_v1",approved=True,approved_by="unit_fixture_only",
        approved_at="2026-10-21T00:00:00Z",max_cells=1,manifest_sha256=recovery.digest(m.read_bytes()),recovery_tool_sha256=recovery.tool_hash())
    a=target/"approval.json";a.write_text(json.dumps(approval),encoding="utf-8")
    before=(m.read_bytes(),a.read_bytes())
    assert recovery.check_approval(target,a,1)==approval
    monkeypatch.setattr(recovery,"tool_hash",lambda:"0"*64)
    with pytest.raises(PermissionError,match="not bound"):recovery.check_approval(target,a,1)
    with pytest.raises(ValueError,match="Recovery tool changed"):recovery.verify(target)
    assert before==(m.read_bytes(),a.read_bytes())
