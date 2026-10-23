# aligned_v3 t017 중단 감사·수정 보고

2026-10-21. 읽기 전용 감사를 먼저 수행한 뒤 코드와 테스트를 수정했다. 기존 실험 자료와 실행 소유 상태 파일은 변경하지 않았다. 실제 TCP 수정 후 검증은 이 환경의 WinError 10013 때문에 미완료다.

## 1. 읽기 전용 감사 결과

대상: `data/measured/v3-70c9f1ea/t017`, 부모 `plan.json`, `data/measured/.benchmark-owner.json`.

- 부모 계획은 32셀 중 17개 완료 체크포인트를 보유하며 `paused_at_cell_boundary`다.
- t017은 sequential_failures/inflight/exit_link, 반복 1이다. trial.json은 최초 starting 스냅샷(873B), 메시지·장애·정리 기록이 비어 있다.
- journal.jsonl은 없다. 기존 실행 순서는 시작 스냅샷 → 6개 노드 시작·준비 확인 → prepared_intents fsync다. 따라서 노드 시작 중 중단되면 저널이 없는 것이 가능하다. 메시지 측정 시작이나 전송을 입증하는 기록은 없다.
- N1~N4의 정상 종료 로그는 05:05:54.502598~05:05:54.627416 UTC다.
- N5(PID 21360)의 node_started는 05:05:54.876171 UTC, N6(PID 34160)는 05:05:55.511477 UTC다. **정리한 뒤 뒤늦게 노드가 시작된 순서가 확정된다.**
- 당시 evidence.json은 N1~N4의 종료와 시작 미확정 N5만 포함하며 N6는 없다. cleanup_failures가 빈 배열이어도 전체 시작 작업이 종료된 증거가 아니다.
- 소유 상태는 needs_audit이며 그대로 유지했다. N5·N6의 사용자 종료 보고와 별개로 이번에는 과거 PID를 근거로 어떤 프로세스도 종료하지 않았다. FastAPI/Uvicorn도 중지하지 않았다.

원인: 기존 `control()`의 취소 대기는 단일 취소 경로만 고려했고, 최종화는 진행 중인 시작 제어 스레드가 완전히 끝났다는 장벽 없이 `cluster.close()`부터 호출했다. 실행기 스레드 shutdown은 그 뒤였다. Windows KeyboardInterrupt/추가 취소가 이 경계를 통과하면 시작과 정리가 경쟁할 수 있다. 이어서 최종화가 무조건 inspect_journal()을 호출해, 저널 생성 이전의 중단에 FileNotFoundError를 추가했다. 최종 trial.json 저장이 그 예외 뒤에 있어 starting 스냅샷만 남았다.

정확한 Ctrl+C 횟수·신호 전달 경로는 원시 노드 로그만으로 확정하지 못한다. 시작/정리 경합과 저널 부재 처리 결함은 코드 및 시각 기록으로 확인했다.

## 2. 수정 범위

| 파일 | 변경 및 코드 위치 |
| --- | --- |
| `src/exit_link/experiments/journal.py` | `settle()`: 소유 제어·정리 작업은 반복 취소에도 끝까지 기다리고 취소 사실을 호출자에게 반환 |
| `src/exit_link/experiments/aligned_v3.py` | `control()`, `finalize()`: 제어 완료 장벽 → 노드 정리 → 기록 최종화 순서. asyncio future 취소 여부와 별개로 실제 단일 제어 executor 큐에 장벽을 통과시킴 |
| 같은 파일 | 정리 자체가 실패하면 현재 호출에서 가진 Popen 핸들로만 잔여 소유 프로세스를 수거. 강제 수거는 normal_stop_confirmed로 처리하지 않음 |
| 같은 파일 | 저널 미생성은 journal_state=not_created, journal_manifest=null. 오류 시 unverified, 빈 저널도 정상 완료로 거부. 가짜 빈 저널 생성 없음 |
| 같은 파일 | 오류·중단 스냅샷은 실패한 저널의 신규 제출에 의존하지 않고 독립 atomic_json으로 저장. 이 저장도 실패하면 오류를 전파하며 정상 커밋하지 않음 |
| `src/exit_link/experiments/study_v3.py` | 완료 상태·검증된 저널·기록 오류 유무를 확인한 후에만 완료 체크포인트 커밋. 미완료/취소/저장 실패는 needs_audit 유지. 소유 상태 최종 쓰기도 취소 보호 |
| `scripts/prepare_study_v3.py` | 실행 중 SIGINT를 한 번의 task.cancel 요청으로 변환. 정리가 진행되는 동안 추가 Ctrl+C는 지연하고 핸들러를 복원. 중단 종료 코드 130 |
| `tests/test_study_v3_interruptions.py` | 17개 신규 검증: 실제 TCP는 이름으로 구분 |
| `tests/test_study_v3.py` | 합성 재개 fixture가 완료 셀의 필수 status를 명시하도록 보완. 기존 검증 조건은 유지 |

전송 스케줄, 두 방식의 정책, 6초 응답 제한, 100ms 오차 기준, 저널 해시 체인, 완료 셀 중복 실행 금지, 기존 프로토콜 자료 분리는 완화하지 않았다. TCP 응답을 늦게 성공 처리하려고 settle()을 사용하지 않는다.

## 3. 함께 유지한 앞선 SQLite/TCP 수정

이 작업 직전 요청에서 진단·수정하던 사항도 보존했다.

- 기존 Windows 결과 `stage5-tests-20261021T043832Z-7dff8791`은 270 passed / 2 failed였다. 수정 후 결과로 재사용하지 않는다.
- 노드 정리는 실제 정상 종료했고 cleanup_failures도 비어 있었다. 재시작 N2 로그의 일반 텍스트 asyncio traceback을 Backend.collect_logs가 JSON으로 파싱하다 실패했다.
- 원본 DB/WAL은 수정하지 않고 별도 진단 폴더에 복사해 확인했다. 저장된 stop 오류는 `Expecting value: line 1 column 1 (char 0)`이며 실험 status=failed였다. SQLite 저장 실패가 아닌 백엔드 로그 수집 결함이다.
- `api/runtime.py`는 비 JSON/잘못된 인코딩/비 객체 줄을 원본 파일에 유지하고, 경로·바이트 오프셋이 있는 process_log_non_event 경고를 기록한다. 이후 정상 이벤트는 계속 수집한다. 실제 cluster.close 실패의 503은 유지한다.
- `tests/test_sqlite_tcp.py`의 재시작 검증은 앞선 테스트가 끝나야 생기는 server.experiment_id 속성에 의존하지 않고 자체 실험과 전달 2건을 생성해 재시작 전후를 검증한다. DELETE 200 기대는 유지하며 실패 본문을 출력한다.
- `tests/test_process_log_collection.py`에 8개 검증을 추가했다. 일반 텍스트 traceback을 만든 Windows Proactor 내부 콜백 경합 자체를 수정하거나 숨긴 것은 아니다. 원시 traceback과 경고는 남는다.

## 4. 이번 실행 결과

| 항목 | 결과 |
| --- | --- |
| 전체 수집 | 297개: 앞선 272개 + 로그 수집 8개 + 중단 처리 17개 |
| 실행 가능한 선택 회귀 | **154 passed**, 37 deselected, 5.57초 |
| 신규 로그 수집 검증 | 7개 통과, 비동기 503 보존 검증 1개 미검증 |
| 신규 중단 검증 | 순수 검증 2개 통과, 비동기/실제 TCP 15개 미검증 |
| 강제 os._exit 후 미체크포인트 거부 | 실제 자식 프로세스로 통과; active 상태를 clean으로 바꾸지 않음 |
| 전체 검증기 | localhost connect에서 WinError 10013, pytest_started=false |
| 실제 TCP 중단·재시작 및 SQLite 2건 재검증 | 수정 후 미검증 |
| 480셀 본 실험 | 실행하지 않음 |

전체 297개 중 이번 환경에서 통과 확인한 것은 154개이며 나머지 143개는 미검증이다. 선택된 파일의 deselected 37개와 전체 미검증 수는 범위가 다르다. 동작 검증이 필요한 비동기 테스트를 삭제하거나 skip으로 바꾸지 않았다.

증거는 `data/measured/interruption-fix-20261021T081430Z/final.xml`, `preservation.json`과 `data/measured/stage5-tests-20261021T082252Z-340338bd/summary.json`에 있다.

## 5. 기존 자료와 소유 상태 보존

작업 전후 전체 파일 SHA-256 대조:

| 디렉터리 | 파일 수 | 결과 |
| --- | ---: | --- |
| m-8ce4fd46 | 1,083 | 추가·삭제·내용 변경 없음 |
| v3-70c9f1ea | 186 | t017 포함 추가·삭제·내용 변경 없음 |
| v3-874398cd | 1 | 변경 없음 |

`.benchmark-owner.json`도 바이트 단위로 동일하고 **needs_audit**다. 잠금 상태를 수동 수정하거나 과거 PID를 재사용하지 않았다. 과거 계획을 재서명하지 않았다. 새 계획과 과거 결과를 합치지 않았다.

## 6. 일반 Windows PowerShell 검증

프로젝트 루트 `outputs/exit-link`에서 실행한다. 현재 운영 중인 FastAPI/Uvicorn을 중지하는 명령은 없다. 테스트는 자신이 생성한 별도 포트·프로세스만 사용한다.

```powershell
$env:PYTHONUTF8 = '1'
.\.venv\Scripts\python.exe scripts\diagnose_tcp.py
if ($LASTEXITCODE -ne 0) { throw 'localhost 사전 검사 실패' }

$validationId = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
.\.venv\Scripts\python.exe -m pytest tests/test_study_v3_interruptions.py tests/test_process_log_collection.py -v --basetemp "data/measured/interrupt-local-$validationId" --junitxml="data/measured/interrupt-local-$validationId.xml"
if ($LASTEXITCODE -ne 0) { throw '중단·정리 검증 실패' }

# 이전 SQLite/TCP 두 실패를 포함하는 파일을 통째로 재검증한다.
.\.venv\Scripts\python.exe -m pytest tests/test_sqlite_tcp.py -v --basetemp "data/measured/sqlite-local-$validationId" --junitxml="data/measured/sqlite-local-$validationId.xml"
if ($LASTEXITCODE -ne 0) { throw 'SQLite/TCP 검증 실패' }

.\.venv\Scripts\python.exe scripts\verify_stage5.py
if ($LASTEXITCODE -ne 0) { throw '전체 검증 실패: summary.json 및 원시 노드 로그 확인' }
```

실제 TCP 최소 검증만 별도로 실행하려면 다음 명령을 사용할 수 있다. 기존 예행 계획을 실행하는 명령이 아니며 pytest의 새 임시 디렉터리를 사용한다.

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_study_v3_interruptions.py::test_real_tcp_cancelled_startup_leaves_no_owned_nodes tests/test_study_v3.py::test_real_v3_restart_rehearsal_uses_actual_tcp_and_cleans_up -v --basetemp "data/measured/tcp-interrupt-$validationId"
```

## 7. 새 예행 계획과 실행 제한

현재 소스로 새 예행 계획 **`data/measured/v3-a5d805da`**를 준비하고 v3 전용 읽기 전용 검사 통과를 확인했다. 2반복=32셀, 완료 0셀, 셀 디렉터리 0개다. 첫 쌍은 restart/before_send의 exit_link와 fixed다.

```powershell
.\.venv\Scripts\python.exe scripts\prepare_study_v3.py --check data/measured/v3-a5d805da
```

`check_main_plan.py`는 v2용이므로 v3의 purpose/source_hash/profile 실패는 검사기 불일치다. 새 검사기가 소스 변경을 보고하면 기존 해시를 고치지 말고 별도 계획을 생성한다.

```powershell
.\.venv\Scripts\python.exe scripts\prepare_study_v3.py --repetitions 2 --seed 12
# 출력된 새 경로를 --check에 전달한다. 이 명령 자체는 노드를 실행하지 않는다.
```

**현재 전역 소유 상태가 needs_audit이므로 계획 검사 통과만으로 새 예행을 실행하면 안 된다.** 새 실행기도 이를 거부한다. 별도 잠금 디렉터리를 지정해 우회하거나 파일을 clean으로 고치지 않는다. 과거 PID 종료 보고만으로 상태를 자동 해제하지 않는다. 별도의 소유 프로세스·포트 감사와 승인된 복구 절차가 필요하며, 이번 수정에는 잠금 해제 기능을 추가하지 않았다.

향후 승인된 감사 절차로 호스트가 실행 가능한 상태가 된 뒤에만 다음 최대 2셀 명령을 사용한다. 현재 상태에서는 아래 가드가 중단한다.

```powershell
$owner = Get-Content data/measured/.benchmark-owner.json -Raw | ConvertFrom-Json
if ($owner.state -ne 'clean') { throw 'needs_audit 유지: 별도 감사 완료 전 실행 금지' }
.\.venv\Scripts\python.exe scripts\prepare_study_v3.py --check data/measured/v3-a5d805da
if ($LASTEXITCODE -ne 0) { throw '계획 검사 실패' }
.\.venv\Scripts\python.exe scripts\prepare_study_v3.py --execute data/measured/v3-a5d805da --max-cells 2
```

## 8. 남은 한계

- 이번 환경에서는 신규 비동기·실제 TCP 회귀를 확인하지 못했다. Windows 로컬 전체 통과 전 정상 정리를 검증 완료했다고 판단하지 않는다.
- Ctrl+C는 소유 제어 작업과 정리가 끝날 때까지 지연된다. 기존 시작/종료 제한 시간만큼 기다릴 수 있다. OS 강제 종료, 창 강제 닫기, TerminateProcess, 전원 손실은 정리 코드를 실행할 수 없으므로 active/needs_audit와 미완료 셀 보존이 안전장치다.
- 디스크가 최종 오류 스냅샷까지 거부하면 마지막 starting 스냅샷만 남을 수 있다. 이 경우도 정상 완료나 재실행 허용으로 처리하지 않는다.
- 소유 프로세스 수거 실패나 포트 점유가 있으면 normal_stop_confirmed/clean을 주장하지 않는다. 다른 프로그램의 프로세스나 포트 점유자는 종료하지 않는다.
