# aligned_v3 시간표·내구성 개선 및 검증 보고

2026-10-21. **480셀 본 실험은 실행하지 않았다. 실제 TCP 시간표 개선은 아직 미검증이다.**

## 기존 자료 보존

`data/measured/m-8ce4fd46`은 aligned_v2 자료로만 유지했다. 작업 시작 전과 완료 시점에 하위 파일 **1,083개 전체**를 SHA-256으로 비교했으며 추가·삭제·변경이 없다. 96셀·288메시지·계획·체크포인트·기존 분석 파일을 갱신하지 않았다.

증거는 별도 검증 디렉터리 `data/measured/v3-validation-20261021T042743Z`의 `legacy-before.json`, `legacy-preservation.json`, `summary.json`에 있다. 새 소스 때문에 과거 계획의 소스 해시와 현재 소스는 더 이상 일치하지 않는다. 과거 계획을 수동으로 재서명하거나 새 결과와 합치지 않는다.

## 변경 파일

| 파일 | 역할 |
| --- | --- |
| `src/exit_link/experiments/aligned_v3.py` | 새 실행 프로토콜, 독립 예약, 실험 전용 TCP 시각 계측 |
| `src/exit_link/experiments/journal.py` | 단일 기록 스레드, bounded 제출, fsync, 해시 체인 검증 |
| `src/exit_link/experiments/study_v3.py` | 새 계획·체크포인트 검증·재개, 기존 v2 쓰기 거부 |
| `scripts/prepare_study_v3.py` | 기본값 준비 전용, 읽기 전용 검사, 명시적 셀 수로만 실행 |
| `scripts/analyze_study_v3.py` | v3 결과만 분석 |
| `scripts/analyze_main_study.py` | 기존 기본값 v2 유지, 명시적 v3 분석 지원·저널 검증 추가 |
| `tests/test_study_v3.py` | 신규 31개 검증 |
| `README.md`, 본 문서 | 진입점 및 검증/로컬 재현 안내 |

기존 `comparison.py`, `processes.py`, `safety.py`, TCP 엔진·Heartbeat·API·WebSocket·SQLite·프론트엔드 소스는 수정하지 않았다. 기존 테스트도 삭제하거나 검증 조건을 완화하지 않았다.

## 동작 원리

1. 노드 시작과 준비 확인은 기존 로직을 사용하되 제어 전용 작업 스레드에서 수행한다.
2. 세 메시지의 ID와 완전한 요청, 실험 조건을 **측정 시작 전에 하나의 prepared-intents 기록으로 fsync**한다. 동일 정책을 두 방식에 적용한다. 메시지 timestamp는 이 요청 준비 시점이다.
3. 메시지·후속 장애/재시작·관측 종료 태스크를 최초 장애 전에 생성한다. 태스크들은 기준 시각 Future를 기다린다.
4. 최초 장애는 제어 스레드에서 수행한다. 종료 확인 시각 F를 받으면 파일 기록 완료를 기다리지 않고 기준 시각을 전달한다. 장애 기록은 별도 기록 스레드에 제출한다.
5. 전송, F+1초 후속 작업, F+9초 관측 종료는 각각 독립 태스크다. 관측 종료를 메시지 응답 gather 이후에 예약하지 않는다. inflight 조건은 기존처럼 실제 N2 relay_wait 사건을 최초 장애의 트리거로 사용한다.
6. 측정 구간에는 실행기 이벤트 루프에서 파일 열기·쓰기·flush·fsync·체크포인트 교체를 수행하지 않는다. 노드 프로세스 자체의 기존 계측 로그 비용은 계속 존재한다.
7. 관측 및 통신 종료 후 기록 큐를 완전히 drain하고, 저널을 검증하고, 최종 trial.json을 원자적으로 저장한 뒤 부모 계획에 완료 셀 해시를 커밋한다.

전송 전 fsync를 제거한 대신 **이미 확정된 전송 의도**를 사용한다. 측정 중 dispatch/result 이벤트는 비동기로 저장되므로 강제 종료 시 실제 전송 여부가 미확정일 수 있다. 이 경우 자동 재전송하지 않고 미체크포인트 셀을 보존·차단하는 정책으로 중복 실행을 방지한다. 늦은 기록을 정시 기록으로 바꾸거나 오차에서 빼지 않는다.

## 시각 및 판단 기준

프로세스 간 실험 시각은 `perf_counter_ns`이며 차이는 ms로 산출한다.

| 필드 | 의미 |
| --- | --- |
| `scheduled_perf_ns` | 사전에 정한 메시지/작업 시각 |
| `task_started_perf_ns` / `started_perf_ns` | 메시지 태스크가 예약 대기를 마치고 시작한 시각 |
| `intent_recording_completed_perf_ns` | 측정 전 prepared-intents의 fsync 완료 시각 |
| `tcp_request_start_perf_ns` | 실제 open_connection을 시작하는 코루틴 진입 시각 |
| `dispatch_perf_ns` | 위 TCP 요청 시작 시각의 호환 필드 |
| `tcp_frame_sent_perf_ns` | 해당 요청 프레임 drain 완료 시각 |
| `result_recording_completed_perf_ns` | 결과 이벤트의 실제 저널 fsync 완료 시각 |
| `completed_perf_ns` | 실행기가 응답 또는 오류를 받은 시각 |
| `faults[].scheduled_perf_ns / issued_perf_ns / confirmed_perf_ns` | 장애 목표·실제 제어 시작·종료 확인 |
| `restart.requested_perf_ns` | 제어 스레드가 재시작 요청을 실제 실행한 시각 |
| `restart.node_ready_perf_ns` | 새 프로세스의 node_started 로그 시각(리스닝 시작 이후) |
| `restart.worker_completed_perf_ns / observed_ready_perf_ns` | 준비 확인 작업 종료 / 이벤트 루프 관측 |
| `scheduled_observation_end_perf_ns / observation_ended_perf_ns` | 관측 종료 목표 / 실제 타이머 실행 |

`scheduling_lateness_ms`는 실제 TCP 시작과 예정 시각의 차이다. `task_lateness_ms`는 태스크 시작 오차다. 파일 준비 시간, TCP 시간, 기록 완료 시간을 혼동하지 않는다. `node_ready_perf_ns`도 외부의 TCP 준비 확인 왕복 시각은 아니며 기존 노드 로그 기준이다.

허용 오차는 **100ms 그대로**다. v3는 실제 메시지 시작, 장애 실행, 재시작 요청, 예약 작업 및 관측 종료의 오차를 검사하며 100ms를 넘으면 schedule_deviation으로 보존한다. 조기 실행도 절댓값 100ms를 넘으면 허용하지 않으며 타이머는 목표 이전에 일어나면 다시 대기한다. ACK가 있어도 시간표를 위반하면 비교 가능으로 처리하지 않는다. 두 클라이언트의 전체 응답 제한은 동일한 6초다.

## 내구성 및 중단 안전성

- 기록 전용 ThreadPoolExecutor 한 개가 제출된 이벤트의 불변 복사본을 순서대로 저장한다. pending 상한은 64다. 큐 초과는 명시적 실패이며 이벤트를 버리지 않는다.
- 각 줄은 sequence, previous_sha256, record, sha256을 가진다. 줄 기록 후 flush·fsync를 완료하고 실제 완료 시각을 반환한다.
- 디스크 오류는 완료 셀 체크포인트 커밋을 막는다. 일부분만 기록된 셀은 성공으로 처리하지 않는다.
- 정상 종료에서는 모든 기록과 제어 스레드 작업을 기다린다. 취소 중에도 이미 시작된 소유 프로세스 제어가 끝나기 전에 정리와 경쟁하지 않도록 shield한다.
- 완료 셀은 trial.json SHA-256과 저널 전체 SHA-256·줄 수를 모두 검증한 뒤 건너뛴다. 손상되거나 미체크포인트 폴더가 있으면 자동 재실행·수정·잘라내기를 하지 않는다.
- 기존 전역 OS 실행 잠금과 active/clean/needs_audit 소유 상태 정책을 사용한다. 프로세스가 강제 종료되면 사람의 프로세스·포트 감사 없이 새 실행으로 넘어가지 않는다. 디스크에 남은 PID를 근거로 임의 프로세스를 종료하지 않는다.
- fsync/원자 교체의 보장은 로컬 파일시스템과 OS·저장장치의 정상 동작 범위다. 전원 손실·장치 고장 시 무손실까지 검증하거나 보장한 것은 아니다. 잠금은 동일 호스트의 협조적인 실행기 사이에서 작동한다.

## 비교 공정성과 버전 분리

기존 8개 실험 층, 30반복이면 480셀·1,440메시지인 구조, 쌍의 인접성, 동일 warmup, 층별 15/15 선행 방식 균형을 유지한다. v3 검사기는 설정을 재서명했더라도 응답 제한·정책·쌍 구조가 달라지면 거부한다.

v3 실행·분석 진입점은 v2 디렉터리를 쓰기 전에 거부한다. v3 분석은 프로토콜 혼합 및 저널 손상을 검사한다. 유효한 양쪽 셀이 있는 쌍만 통계에 포함하고, 시간표 제외 셀의 상대편은 unmatched_pair로 통계에서 제외하되 원시 결과는 보존한다. 실패 메시지도 성공률 분모에서 누락하지 않는다.

## 실제 실행 결과

| 항목 | 이번 환경 결과 |
| --- | --- |
| 전체 pytest 수집 | 272개: 기존 241개 + 신규 31개 |
| 실행 가능한 선택 회귀 | **145 passed**, 21 deselected, 5.12초 |
| 신규 테스트 | **23 passed**, asyncio/TCP 필요 8개 미검증 |
| 저장 스레드가 fsync에서 대기하는 동안 호출 스레드 진행 | 실제 스레드/이벤트로 통과 |
| 강제 os._exit 이후 fsync된 저널 유지 | 통과 |
| 손상·부분 줄 탐지, 완료 셀 trial/저널 무결성, 쌍 분석 | 통과 |
| 전체 검증기 | WinError 10013으로 `blocked_before_pytest` |
| 느린 디스크 중 asyncio 타이머/전체 시간표, 취소·비동기 재개 | 테스트 추가, 이 환경에서 미검증 |
| 실제 TCP 2셀 예행 | 사전 검사에서 차단, 완료 0셀, 노드 시작 0개 |
| 실제 시간표 오차 감소 | **미검증**, 성능 수치 생성 안 함 |

이번에 확인한 145개 이외의 127개는 수정 후 이 환경에서 미검증이다. 선택 실행에서 deselected 21개와 전체 미검증 127개는 범위가 다르다.

Windows asyncio 초기화의 소켓 쌍 생성도 제한되어 `asyncio.run(asyncio.sleep(0))`가 대기하는 현상을 확인했다. 해당 진단 자식 프로세스만 제한 시간 후 종료했다. 테스트용 가짜 루프를 사용해 통과했다고 보고하지 않는다.

증거:

- `data/measured/v3-validation-20261021T042743Z/final-source.xml`
- `data/measured/v3-validation-20261021T042743Z/pure-final.xml`
- `data/measured/v3-validation-20261021T042743Z/final-rehearsal-attempt.json`
- `data/measured/stage5-tests-20261021T043524Z-ab3da1bd/summary.json`

## 일반 Windows PowerShell 재검증 및 2셀 예행

프로젝트 루트 `outputs/exit-link`에서 다른 실험과 백엔드 소유 노드를 정상 종료한 뒤 실행한다. 본 실험 실행 명령은 포함하지 않는다.

```powershell
$env:PYTHONUTF8 = '1'
.\.venv\Scripts\python.exe scripts\diagnose_tcp.py
if ($LASTEXITCODE -ne 0) { throw 'localhost 사전 검사 실패' }

$validationId = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
.\.venv\Scripts\python.exe -m pytest tests/test_study_v3.py -v --basetemp "data/measured/v3-local-tests-$validationId" --junitxml="data/measured/v3-local-tests-$validationId.xml"
if ($LASTEXITCODE -ne 0) { throw 'v3 검증 실패' }

.\.venv\Scripts\python.exe scripts\verify_stage5.py
if ($LASTEXITCODE -ne 0) { throw '전체 검증 실패: 출력된 summary.json 확인' }

.\.venv\Scripts\python.exe scripts\prepare_study_v3.py --check data/measured/v3-874398cd
if ($LASTEXITCODE -ne 0) { throw '예행 계획 불일치: 해시를 수정하지 말고 새 준비 계획 생성 필요' }

.\.venv\Scripts\python.exe scripts\prepare_study_v3.py --execute data/measured/v3-874398cd --max-cells 2
if ($LASTEXITCODE -ne 0) { throw '예행 실패/제외: 기존 셀을 덮어쓰거나 재실행하지 말고 원인 확인' }

.\.venv\Scripts\python.exe scripts\analyze_study_v3.py data/measured/v3-874398cd
```

현재 유효한 예행 준비 계획은 `data/measured/v3-874398cd`다. 2반복 전체 표는 32셀이지만 실행 bound는 **2셀**로 지정한다. 첫 비교 쌍은 restart/before_send의 exit_link와 fixed다. 현재 완료 셀은 0개다. 무결성 오류·시간표 제외·정리 실패 시 2셀 이전에도 중단할 수 있다.

초기에 준비한 `v3-59354c35`는 마지막 소스 보완 이전 계획이므로 사용하지 않는다. 소스가 바뀌면 어떤 준비 계획도 다시 서명하지 말고 `scripts/prepare_study_v3.py --repetitions 2 --seed 12`로 별도 새 계획을 준비한다. 이 명령 자체는 노드를 실행하지 않는다.

전체 통과와 2셀 예행의 실제 오차·ACK·정리 검증이 끝난 후에만 새 본 실험 계획을 확정한다. 480셀 본 실험의 장시간 실행은 별도 사용자 승인 이후다. 현재 기존 v2 96셀은 새 결과와 합산하지 않는다.
