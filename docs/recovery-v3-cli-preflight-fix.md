# aligned_v3 CLI 사전 검사 오분류 감사 및 수정

2026-10-21. 원본 및 기존 후속 자료를 보존했다. 실제 execute/승인/해제 명령, TCP 후속 셀, 새 후속 계획 생성은 수행하지 않았다.

## 1. 확인된 결함과 증거의 한계

Windows 가상환경의 `.venv/Scripts/python.exe`는 이 환경에서 부모 런처로 남고, 설치된 Python312/python.exe가 실제 Python 코드를 실행한다. 안전한 stdin 진단에서 Windows의 프로세스 조회 API로 다음을 직접 확인했다.

| 항목 | 실제 Python 프로세스 | 부모 런처 |
| --- | --- | --- |
| 조회 당시 PID | 36532 | 32276 |
| 실행 파일 | Python312/python.exe | 프로젝트 .venv/Scripts/python.exe |
| 명령 인자 | `-` | `-` |

이 PID는 과거 관찰 기록이며 종료할 대상으로 사용하지 않는다. 증거는 `data/measured/host-audit-20261021T142556Z-7053d0/native-launcher.json`이다. 실제 실험 노드를 시작하지 않았다.

기존 `host_observation`은 현재 `os.getpid()`만 nodes에서 제외했다. 부모 런처는 별도 PID이므로 남는다. 부모의 명령줄이 `recovery_v3.py execute ...`이면 기존 `recovery_v3\.py\s+execute` 조건에 맞는다. 이어 children 조회가 부모의 자식인 현재 실제 Python까지 반환한다. nodes/children 중 하나라도 있으면 bind probe 전에 ready=false가 된다. 따라서 당시 포트가 비어 있어도 실패할 수 있다.

반면 dry-run 명령에는 execute 패턴이 없고, `python -c`의 직접 import 호출에도 해당 실행 명령이 없다. 같은 함수라도 OS에 보이는 명령줄과 런처 분류가 달라진다. `__package__`에 따른 interruptible import 분기는 main의 사전 검사 **뒤**에 있으므로 보고된 실패 위치의 원인이 아니다.

모의 프로세스 자료를 **실제 PowerShell 분류 코드**에 넣고 socket을 모의 처리한 재현 결과:

| 분류 정책 | nodes | children | ready |
| --- | --- | --- | --- |
| 기존 현재 PID만 제외 | 런처 200 | 현재 100 | false |
| 수정 후 입증된 자기 런처 제외 | 없음 | 없음 | true |
| 수정 후 다른 실행기 300도 존재 | 다른 실행기 300 | 없음 | false |

`powershell-fixture.json`은 unit_fixture_with_native_powershell 자료이며 실제 실험 측정값이 아니다. 이 재현과 실제 런처 구조 관찰로 **자기 부모 런처 오분류 결함은 확인**했다.

그러나 사용자의 실패 당시 host 보고서가 저장되지 않았고, 이번 Codex 환경에서는 CIM 조회가 접근 제한으로 실패했다. 따라서 사용자 당시 실패에 **다른 실행기/리스너/알 수 없는 Python/bind 실패도 동반됐는지**는 확정할 수 없다. 모든 실패를 이 한 원인으로 단정하지 않는다. 수정 후 승인된 새 계획에서 preflight-only 보고서로 확인해야 한다.

## 2. 최소 수정 및 유지한 검사

`scripts/recovery_v3.py`:

- 88행 `identify_current_launcher`: 현재 실제 프로세스와 직계 부모의 CIM 신원을 추가 검증한다.
- 128행 `host_observation`: 현재/부모 PID, 실제 실행 파일, 명령줄, UTC 생성 시각을 같은 CIM 스냅샷에서 수집한다. 기존 후보 분류와 포트 조회를 유지한다.
- 376행 `HostAuditError`, 382행 `execution_preflight`: 기존 RuntimeError의 하위 타입으로 실제 host JSON과 report 속성을 제공한다. CLI traceback과 직접 호출 모두 차단 근거를 확인할 수 있다.
- 514행 및 545행 이후: execute에 `--preflight-only`를 추가했다. 같은 승인/manifest/owner/host 검사를 통과한 경우에도 이벤트 루프, OS 실행 잠금, 파일 기록, 노드 실행 전에 보고서를 출력하고 종료한다. 기본 실행 경로는 이 옵션이 없으면 그대로다.

자기 런처에서만 다음 증거가 **전부** 맞아야 제외한다.

1. 현재 PID의 직계 부모가 관찰한 부모 PID와 일치한다.
2. 현재 물리 실행 파일은 `sys._base_executable`, 부모는 `sys.executable`과 일치하며 가상환경이다.
3. 실행 파일 토큰을 제외한 인자가 정확히 같고, 실제 이 recovery_v3.py의 execute CLI다.
4. 생성 시각에 UTC 정보가 있으며 부모가 자식보다 늦게 생성되지 않았다.
5. 부모의 관찰된 자식이 현재 프로세스 하나뿐이다.

검증한 부모·현재 신원과 사유는 `host.verified_launcher`에 남긴다. 증거 누락/불일치는 기존대로 차단한다. 다른 실행기, 추가 자식, 리스너, 명령줄을 알 수 없는 Python 및 독점 bind 실패는 제외하지 않는다. PID 범위를 통째로 허용하거나 모든 부모 Python을 무시하지 않는다. 모듈 자체가 현재 PID를 제외하던 기존 정책에 정확한 자기 런처 식별만 추가했다.

`tests/test_recovery_cli_host.py`에 모의 호스트 테스트 17개를 추가했다. `tests/test_recovery_v3.py`는 기존 모의 os에 getppid만 추가했으며 기존 assertion, 테스트 27개, 스킵 정책을 변경하지 않았다. 기존 프로토콜 src, 시간표·100ms 기준, 저널·체크포인트 코드, 전역 owner 정책은 변경하지 않았다.

## 3. 테스트 결과

- 신규 호스트/CLI/승인 무효화 테스트: **17 passed**, 0.68초, 종료 코드 0.
- 기존 동기 회귀와 신규 테스트 선택 집합: **197 passed, 41 deselected**, 84.96초, 종료 코드 0. 이는 전체 통과가 아니다. 선택하지 않은 파일도 있다.
- 전체 수집: **344개**. 그중 이번 실행에서 검증하지 못한 테스트는 147개다.
- 실제 PowerShell + 모의 CIM/모의 socket 조합의 3가지 분류 재현도 확인했다. 실제 호스트 감사 성공이나 TCP 실험 성공으로 해석하지 않는다.
- 전체 `scripts/verify_stage5.py`는 재실행했지만 **WinError 10013**으로 localhost 사전 검사에서 차단됐다. pytest_started=false이며 전체 pytest 결과는 없다. 증거: `data/measured/stage5-tests-20261021T142902Z-a516b2cf/summary.json`.
- 사용자가 완료한 이전 전체 검증은 원시 로그에서도 **327 passed, 268.86초**로 확인했다. 이것을 수정 후 344개 통과로 보고하지 않는다.

증거와 JUnit XML은 `data/measured/host-audit-20261021T142556Z-7053d0`에 저장했다. 실제 후속 execute는 호출하지 않았다. CLI preflight-only 분기는 임시 argv와 모의 preflight로 검사했고 execute/asyncio.run에 진입하면 실패하도록 검증했다.

## 4. 원본·승인서 보존과 유효성

감사 전후 파일 목록과 내용 SHA-256을 비교했다.

- 원본 `v3-6d329cd9`: 전체 동일. 398개 완료, t398 미완료 체크포인트, t122 제외 유지.
- 기존 `v3-tail-6d329cd9-20261021`: manifest, snapshot, audit, progress, 승인서, 공식 해제 증거를 포함해 전체 동일. 후속 완료 0개.
- owner 바이트 동일, **clean 유지**. 직접 수정하거나 재해제하지 않았다.
- 원본 계획의 기존 엔진 소스 맵과 현재 소스 맵 일치. 원본 프로토콜 변경 없음.

복구 도구 자체 해시는 변경됐다.

| 항목 | SHA-256 |
| --- | --- |
| 수정 전 도구 / 기존 manifest / 기존 approval의 도구 해시 | `3f7315bcf8726b016cb426c1c308dfddc6a1d3cab0daa2fcfda25c01cc076660` |
| 수정 후 도구 | `8d624c62d372e2927d04ae790612df310a74ae60ee966c1c87e46648db6d86d1` |
| 기존 manifest 파일 | `f508cefb8e7285c09b6e2d9e5d6651a1a1b808c48af7eb346e84ae1b4110e5dd` |
| 기존 approval 파일 | `04fc52f02ba4bb50afd60501ea09b6a95c728879c61c784fa8cd7ca53c7066c2` |

이전 승인서는 이전 도구에만 결합되어 있다. **수정 도구에서는 유효하지 않다.** 실제 읽기 전용 검사에서 check_approval은 `Approval is not bound to this manifest/tool`, verify는 `Recovery tool changed; do not resign an existing manifest`로 차단됨을 확인했다. 기존 파일의 해시를 고치거나 기존 승인서를 복사해 새 승인을 만들지 않았다.

새 계획과 새 승인이 필요하다. 이번에는 생성하지 않았다. owner는 이미 공식 감사로 clean이므로 이를 다시 해제하거나 새 계획을 위해 직접 수정할 필요가 없다. 현재 호스트 검사는 여전히 별도로 통과해야 한다.

## 5. 중복 실행 없는 전환 절차

1. 사용자 확인 후 로컬 344개 전체 검증을 수행한다. 통과 전 실제 셀 실행을 승인하지 않는다.
2. 기존 후속 progress가 계속 비어 있고 cells 폴더가 없으며 원본/owner 해시가 보존됐는지 다시 확인한다. 달라졌으면 새 계획 생성 전에 감사한다.
3. 원본을 기준으로 **새 고유 디렉터리**에 prepare한다. 원래 t399~t479만 포함하는지 dry-run으로 확인한다.
4. 새 디렉터리에 별도 transition 기록을 남긴다. 이전/새 manifest SHA, 이전 progress/승인 SHA, 원본 run_id, 새 도구 SHA, 이전 완료 0개, 교체 사유를 연결한다. 기존 디렉터리는 건드리지 않는다. 이 전환과 실행 승인 대상은 새 계획 하나로 한정한다.
5. 새 manifest와 수정 도구 해시에 결합한 **새 승인서**를 사용자 검토 후 발급한다. 우선 max_cells=1, release_approved=false로 둔다. 과거 승인·계획·백업 도구를 실행 경로로 사용하지 않는다. 기존 자료는 provenance로만 보존한다.
6. 새 승인이 있는 상태에서 **execute --preflight-only**로 실제 CLI 문맥의 host JSON을 확인한다. ready, verified_launcher, 남은 후보/자식/리스너/unknown/bind_probes를 검토한다. 실패하면 새 보고서를 보존하고 중단한다.
7. 이 결과를 사용자에게 다시 보고한다. 실제 t399 실행은 별도 실행 승인 후에만 1셀로 제한한다. 이번 작업에서는 실행하지 않는다.

기존 엔진 해시가 같아도 다른 드라이버 수정본 및 세션의 결과를 자동 병합하지 않는다. 기존 t122와 t398의 제외 및 대응 비교 제한은 그대로 유지한다.

## 6. PowerShell 명령

프로젝트 루트에서 실행한다. 아래 첫 절은 검증만 한다.

```powershell
$env:PYTHONUTF8 = '1'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
.\.venv\Scripts\python.exe -m pytest tests/test_recovery_cli_host.py tests/test_recovery_v3.py tests/test_stage5_runner_paths.py -v --basetemp "data/measured/h-$stamp"
.\.venv\Scripts\python.exe scripts/verify_stage5.py
```

**새 계획 준비에 대한 사용자 확인 이후에만** 다음을 실행한다. 노드는 시작하지 않는다. 기존 계획을 인수로 재사용하지 않는다.

```powershell
$next = "data/measured/v3-tail-cli-$stamp"
.\.venv\Scripts\python.exe scripts/recovery_v3.py prepare data/measured/v3-6d329cd9 $next
.\.venv\Scripts\python.exe scripts/recovery_v3.py dry-run $next
Get-FileHash "$next/manifest.json" -Algorithm SHA256
Get-FileHash scripts/recovery_v3.py -Algorithm SHA256
```

전환 증거는 새 계획 안에 별도 파일로 작성하며 원래 manifest/progress/승인서의 내용을 복사·수정해 서명하지 않는다. 새 승인서 스키마는 residual_execution_approval_v1이며 approved_by, 승인 UTC 시각, max_cells=1, 새 manifest_sha256 및 recovery_tool_sha256을 검토해 발급한다. 문서 작성 전에는 approved=false다. 아래 approval.json은 **그 새 사용자 승인서**를 가리킨다.

```powershell
# 새 사용자 승인서 발급 후에도 이 명령은 검사만 하고 종료
.\.venv\Scripts\python.exe scripts/recovery_v3.py execute $next --approval "$next/approval.json" --max-cells 1 --preflight-only
```

오류 시 exception 문자열에 host JSON이 포함된다. preflight-only는 승인 검사를 건너뛰지 않는다. 성공하더라도 실제 셀은 시작하지 않고 사용자 확인을 기다린다. 실제 실행을 위한 `--preflight-only` 제거는 이번 절차에서 하지 않는다.
