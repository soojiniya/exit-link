# 2단계 로컬 검증 실패 수정 보고

작성일: 2026-10-20 (Asia/Seoul)

**수정 전 실제 결과는 62 passed / 2 failed입니다. 수정 후 64개 전체 통과는 아직 미확인입니다.**
두 실패 원인을 확인하고 수정했으며, PID 수정은 실제 별도 프로세스를 실행해 검증했습니다.
현재 Codex 실행 문맥에서는 localhost connect가 10013으로 거부되어 TCP 회귀 검증을 완료할 수 없었습니다.
일반 PowerShell에서 10013이 재현되지 않았다는 사용자 결과와 구분합니다.

## 확인한 원본 자료

`data/measured/stage2-20261020T123530Z-ebab83bc/`의 실제 파일을 읽었습니다.

- `pytest-results.txt`: 62개 통과, 요청에 명시한 2개 실패
- `tcp-processes/evidence.json`: 런처 PID와 실제 이벤트 PID, 정리 실패 없음
- `tcp-processes/N1-0.jsonl`: PID 10780, 종료된 N2로 send_attempt 후 timeout, 해당 요청 sent/ACK 없음
- `tcp-processes/N2-1.jsonl`: 실패 요청 이전에 N2의 node_stopped 확인

해당 과거 결과 파일은 수정하지 않았습니다.
이 실행에서 1:1, 다중 홉, ACK, TTL, 중복, 동시 요청 등 62개가 실제 통과한 사실도 확인했습니다.
이것은 수정 전 버전의 결과이며 현재 버전의 전체 통과로 대체하지 않습니다.

## 1. PID 불일치

로그의 `os.getpid()`가 잘못된 것이 아니라, 테스트의 Popen이 Windows venv 런처를 관리하고 있었습니다.
`.venv/Scripts/python.exe` 런처가 실제 Python 자식 프로세스를 생성하므로 Popen.pid와 노드 PID가 달랐습니다.
원본 로그에서는 N1의 런처 6588, 실제 노드 10780으로 확인됩니다.

네트워크 없이 실제 자식 Python을 실행해 재현했습니다.

| 실행 방식 | Popen PID | 실제 os.getpid | 결과 |
|---|---:|---:|---|
| 기존 venv 런처 | 21588 | 22484 | 불일치, 실제 부모 PID는 21588 |
| 실제 인터프리터 직접 실행 | 5100 | 5100 | 일치 |

수정한 Cluster.start는 Windows venv에서 `sys._base_executable`을 직접 실행하고,
자식 환경에만 `__PYVENV_LAUNCHER__=sys.executable`을 전달합니다.
이것은 CPython 3.12 런처가 사용하는 가상환경 경로 전달 방식입니다.
전역 환경 변수, Python 설치, 가상환경 파일은 변경하지 않습니다.
자식에서 같은 sys.prefix/sys.executable을 유지하고 Pydantic 2.14.1 및 프로젝트 패키지 import가 되는 것까지 확인했습니다.

원래 `started["pid"] == process.pid` assertion은 그대로입니다.
부모 PID가 테스트 프로세스인지, 가상환경 prefix가 유지되는지도 추가 검사합니다.
노드 로그를 런처 PID로 바꾸거나 로그 PID를 신뢰해 Popen PID를 덮어쓰지 않았습니다.
Popen의 종료 코드·kill·wait가 실제 노드를 대상으로 동작하도록 생성 방식을 수정했습니다.

노드 시작 로그에는 실제 부모 PID, Python 실행 경로 및 prefix를 추가했습니다.
테스트 evidence에도 launcher가 아닌 관리 대상 PID와 런타임 PID를 별도로 남깁니다.

참고: [Python 3.12 venv의 Windows redirector 설명](https://docs.python.org/3.12/library/venv.html),
[CPython 3.12.10 getpath의 런처 경로 처리](https://github.com/python/cpython/blob/v3.12.10/Modules/getpath.py).
이 실행 방식은 현재 프로젝트의 CPython 3.12 Windows 환경을 대상으로 합니다.

## 2. 연결 실패와 타임아웃 혼동

기존 exchange는 `open_connection`의 연결 기한 만료와 연결 후 프레임 I/O 만료를 모두 TimeoutError로 내보냈고,
노드는 두 경우를 구분하지 않고 `timeout`으로 반환했습니다.
중단된 N2 요청은 1.5초 설정의 기한에 도달했으며 sent 이벤트가 없었습니다.
Windows에서 OS 연결 오류가 애플리케이션의 짧은 연결 기한보다 늦게 돌아오면 기존 분류 문제가 드러납니다.
다만 원본 코드가 단계별 원인을 보존하지 않았기 때문에 당시 OS의 최종 Winsock 오류 번호까지 확정할 수는 없습니다.

이제 exchange에서 **연결 수립 구간만** ConnectionFailed로 감쌉니다.
TimeoutError도 OSError의 하위 타입이므로 해당 구간에서는 함께 포착하되, 수립 후 만료는 변환하지 않습니다.
노드는 다음 의미로 오류를 반환합니다.

| 발생 구간/상태 | 응답 코드 | 로그 phase 및 부가 정보 |
|---|---|---|
| 연결 거부/접근 거부 등 수립 실패 | connection_failed | connect, connect_error, 원본 errno/winerror |
| 연결 수립 기한 만료 | connection_failed | connect, connect_timeout |
| 연결 수립 후 쓰기·응답 대기 만료 | timeout | io, 전달 여부 불명확 가능 |
| 수립 후 연결 리셋 등 OSError | connection_failed | io, 전달 여부 불명확 가능 |
| 들어오는 요청 프레임 만료 | timeout | request |

phase/reason은 JSON 이벤트 로그 필드이며 기존 ErrorResponse 스키마는 바꾸지 않았습니다.
연결 실패는 해당 시도의 실패일 뿐 노드 고장 확정이나 Heartbeat 판정이 아닙니다.
임의의 timeout을 모두 connection_failed로 바꾸거나 타임아웃을 늘려 문제를 숨기지 않았습니다.

기존 실패 테스트의 `result.code == "connection_failed"`를 유지했습니다.
추가로 connect 단계 오류와 sent 부재를 확인하고, 이어 같은 포트에 실제 TCP 리스너를 열어 요청을 받되 ACK를 보류합니다.
이 경우에는 sent가 존재하고 `timeout`, phase=io가 반환되는지 검사합니다.
두 경우 모두 N3로 우회하거나 N4에 전달되지 않는 것을 확인하도록 했습니다.
새 함수를 추가하는 대신 기존 테스트 안의 검증을 강화해 전체 테스트 수는 64개입니다.
이 TCP 검사 자체의 수정 후 실행은 아래 제한 때문에 미검증입니다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `src/exit_link/communication/protocol.py` | 연결 단계 전용 ConnectionFailed 및 원인 보존 |
| `src/exit_link/communication/node.py` | 단계별 오류 매핑/로그, 실제 실행 환경 시작 로그 |
| `tests/test_tcp_integration.py` | 실제 인터프리터 직접 실행, 엄격한 PID 검사 유지/강화, 응답 타임아웃 회귀 검사 |
| `scripts/diagnose_process.py` | 소켓 없이 PID·가상환경 보존을 재현하는 진단 |
| `README.md` | 로컬 결과 및 재검증 상태, 오류 코드 의미 |
| `docs/stage-2-fix-report.md` | 이 보고서 |
| `docs/stage-2-fix-pid-diagnostic.json` | 실제 프로세스 진단 출력 |
| `docs/stage-2-fix-static-results.txt` | 선별 pytest 원문 |
| `docs/stage-2-fix-collection.txt` | 전체 64개 수집 원문 |
| `docs/stage-2-fix-verification-attempt.txt` | 수정 후 전체 검증 시도의 사전 차단 기록 |

TCP 프레이밍·메시지·ACK 스키마, TTL, 중복 캐시, 명시 경로, 토폴로지/건물 JSON,
기존 FastAPI와 1단계 테스트 및 의존성은 유지했습니다.
Heartbeat·자동 경로 전환은 시작하지 않았습니다.

## 수정 후 실제 검증

| 검증 | 결과 |
|---|---|
| PID 재현 및 직접 실행 방식 | 실제 자식 프로세스 실행 성공, PID/부모/venv 검사 모두 참 |
| 소켓 불필요 선별 pytest | 31 passed, 5 deselected in 0.67s |
| 전체 수집 | 64 tests collected |
| compileall | 종료 코드 0 |
| pip check | No broken requirements found. |
| 전체 검증 스크립트 | localhost 사전 검사에서 10013, 종료 코드 2 |
| 수정 후 전체 64개 | **미검증**: pytest_started=false, pytest_exit_code=null |

선별 통과는 기존 토폴로지 23개와 새 스키마 8개입니다.
5 deselected는 해당 선별 명령에서 제외한 프레이밍 검사이며 전체 미검증 개수와 다릅니다.
이번 Codex 실행 문맥에서 실행 완료하지 못한 것은 HTTP 2개, 프레이밍 5개, TCP 통합 26개입니다.
PID 진단 성공은 TCP 통합 전체 통과를 뜻하지 않습니다. pytest 시간은 통신 성능 수치가 아닙니다.

사전 검사 결과는 `data/measured/stage2-20261020T123925Z-d982d2a2/summary.json`에도 보관했습니다.
현재 10013은 일반 PowerShell에서 재현되지 않으므로 방화벽을 끄거나 포트 설정을 변경할 근거가 없습니다.

## 일반 PowerShell 재검증

```powershell
Set-Location 'C:\Users\User\Documents\Codex\2026-10-20\exit-link-fastapi-python-tcp-socket\outputs\exit-link'
.\.venv\Scripts\python.exe .\scripts\diagnose_process.py
.\.venv\Scripts\python.exe .\scripts\verify_stage2.py
$LASTEXITCODE
```

기대 조건은 다음과 같으며 실제 결과를 확인하기 전 성공으로 간주하지 않습니다.

1. PID 진단 direct의 checks가 모두 true
2. 새 결과 폴더의 pytest-results.txt에 `64 passed`
3. summary.json에 pytest_started=true, pytest_exit_code=0, status=passed
4. evidence.json에 각 노드의 pid/runtime_pid 일치 및 cleanup_failures 빈 목록
5. 중단 노드 요청은 phase=connect/connection_failed, ACK 보류 요청은 phase=io/timeout

실제 결과는 매 실행의 고유한 `data/measured/stage2-<실행ID>/`에 저장되며 과거 실패 로그를 덮어쓰지 않습니다.
별도 설치나 의존성 갱신은 필요하지 않습니다. 이 결과를 확인한 뒤 2단계 안정성을 최종 판단해야 합니다.
