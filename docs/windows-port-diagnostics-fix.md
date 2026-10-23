# Windows 포트 진단 인코딩 수정 및 검증

검증일: 2026-10-21. 본 문서는 진단 코드 수정 검증이며, 네트워크 성능 비교 실험 결과가 아니다. 480셀·1,440메시지 본 실험은 실행하지 않았다.

## 원인

사용자가 일반 Windows PowerShell에서 실행한 기존 결과는 230개 중 227개 통과, 재시작 관련 3개 실패다. 실제 자식 노드의 바인딩 실패는 `WinError 10048`이었다.

기존 `port_evidence()`는 `subprocess.run(..., text=True)`로 `netstat` 출력을 읽었다. 전체 검증기는 `PYTHONUTF8=1`을 설정한다. 네이티브 명령 출력이 UTF-8이 아니면 subprocess 출력 판독 중 `UnicodeDecodeError`가 발생할 수 있다. 사용자 로그에서는 판독 실패 후 `stdout=None`인 상태에서 `.splitlines()`가 호출되어 추가 `AttributeError`가 발생했다. 이 예외가 원래의 바인딩 실패 기록 및 `NodeStartError` 생성 과정을 가렸다.

사용자가 제공한 디코딩 오류 및 None 출력 조건을 재현하는 단위 테스트로 수정 동작을 확인했다. Codex에서는 동일한 실제 노드 복구 시퀀스 전체를 재현할 수 없었다.

## 수정 파일

- `src/exit_link/simulation/diagnostics.py`: 바이너리 캡처(`text=False`), Windows OEM 코덱을 사용한 명시적 디코딩, 손상된 바이트 대체 및 진단 경고, 코덱 부재 시 locale 코덱 대체, None 출력 및 비정상 종료 처리, 디코딩 예외 격리.
- `tests/test_port_diagnostics.py`: 신규 11개 테스트. 네이티브/손상 출력의 PID 파싱, 정확한 로컬 포트 필터링, None stdout/stderr, 명령 실패·타임아웃·디코딩 예외, 실제 Windows 점유 포트의 바인딩 실패 보존 검증.
- `docs/windows-port-diagnostics-fix.md`: 본 보고서.

진단 결과의 기존 JSON 필드와 형식은 유지한다. 시스템 명령 실패 시 `inspection_error`에 원인을 기록하고, 바인딩 결과를 덮어쓰지 않는다. 목록이 없으면 PID를 추정하지 않고 `owner_visibility=not_observed`를 유지한다.

## 유지한 안전 정책

`simulation/processes.py`, `api/runtime.py`, 기존 재시작 테스트 3개는 수정하지 않았다.

- 프로세스 소유권은 기존 실제 자식 프로세스 핸들과 `node_started` PID 확인으로 검증한다. netstat 목록 자체로 프로세스를 종료하지 않는다.
- 실패한 자식 노드는 정리하고 기존 소유 핸들을 보존한다.
- 실제 점유 상태이면 HTTP 503 `node_control_failed`를 반환하며 재시도하지 않는다.
- 실제 주소 충돌 기록이 있고 진단 시점에 포트가 해제된 경우에만 기존 최대 3회 시도 정책을 적용한다. 대기 시간 증가나 오류 숨김은 추가하지 않았다.
- TCP/ACK/재전송, WebSocket, SQLite, 프론트엔드 및 본 실험 설정은 변경하지 않았다.

## 이 실행 환경에서의 결과

| 검증 | 결과 |
| --- | --- |
| 신규 진단 테스트 | 11 passed, 0.43초 |
| UTF-8 모드의 실행 가능한 회귀 검증 | 123 passed, 12 deselected, 3.41초 |
| 전체 테스트 수집 | 기존 230개 + 신규 11개 = 241개 |
| 실제 임시 소켓 listen 및 충돌 bind | WinError 10048 보존 확인 |
| 실제 netstat PID 관측 | 미검증: 이 환경에서는 헤더만 출력되고 소켓 목록이 비어 있음 |
| 기존 실패 테스트 3개 | localhost 사전 검사 실패로 실행하지 못함 |
| 전체 검증기 | `blocked_before_pytest`, `pytest_started=false` |

localhost 사전 검사는 bind/listen 이후 connect 단계에서 `WinError 10013`으로 실패했다. 9101~9106의 바인딩은 모두 가능했다. 따라서 전체 241개 중 이 환경에서 통과가 확인된 것은 123개이고, 나머지 118개는 이번 수정 후 미검증이다. 사용자의 이전 227개 통과 결과를 수정 후 통과 결과로 재사용하지 않는다.

증거 파일(로컬 측정/검증 디렉터리, Git 제외):

- `data/measured/port-diagnostics-20261021b.xml`
- `data/measured/port-fix-regression-20261021.xml`
- `data/measured/stage5-tests-20261021T033202Z-5ae3c0d1/summary.json`

## 일반 Windows PowerShell에서 재검증

기존 백엔드와 실험 노드 실행을 정상 종료한 뒤 프로젝트 `outputs/exit-link`에서 실행한다. 기존 검증 조건은 그대로이며 본 실험을 실행하지 않는다.

```powershell
$env:PYTHONUTF8 = '1'
.\.venv\Scripts\python.exe scripts\diagnose_tcp.py
if ($LASTEXITCODE -ne 0) { throw 'localhost 사전 검사 실패' }

$validationId = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
.\.venv\Scripts\python.exe -m pytest tests/test_restart_stability.py -v --tb=short --basetemp "data/measured/restart-fix-$validationId" --junitxml="data/measured/restart-fix-$validationId.xml"
if ($LASTEXITCODE -ne 0) { throw '기존 재시작 테스트 3개 재검증 실패' }

.\.venv\Scripts\python.exe -m pytest tests/test_port_diagnostics.py -v
if ($LASTEXITCODE -ne 0) { throw '진단 회귀 테스트 실패' }

.\.venv\Scripts\python.exe scripts\verify_stage5.py
if ($LASTEXITCODE -ne 0) { throw '전체 검증 실패: 출력된 summary.json 확인' }
```

예상 전체 수집 수는 241개다. **241개 통과는 아직 확인하지 않았다.** 실제 PID 관측과 점유 중 503 유지·포트 해제 후 재시도는 위 기존 테스트 3개를 일반 PowerShell에서 통과해야 최종 검증된다.

## 본 실험 준비와의 관계

본 실험은 실행하지 않았다. 소스 파일 수정으로 기존 준비 계획의 소스 해시는 달라진다. 이는 의도된 무결성 검사이므로 기존 계획의 해시를 수동으로 고치지 않는다. 로컬 회귀 검증 완료 후 본 실험을 승인받기 전에 준비 전용 절차로 계획을 새로 생성·검증해야 한다.
