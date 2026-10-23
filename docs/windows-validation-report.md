# Windows 전체 시스템 검증 및 안정성 개선 보고서

2026-10-21 (KST). 기존 5개 페이지의 디자인·CSS·3D 배치·컴포넌트 외관은 유지했습니다.
데이터 영구 저장은 [SQLite 설계안](sqlite-persistence-design.md)만 작성했으며 구현·DB 생성·API 대규모 변경은 하지 않았습니다.

## 최종 결과

| 항목 | Windows 실행 결과 |
|---|---|
| 전체 Python pytest | **187 passed, 0 failed**, 종료 코드 0, 105.55초 |
| npm run typecheck | 통과, 기존 생성 계약 타입 직접 참조 포함 |
| npm run build | 통과, Vite 프로덕션 산출물 생성 |
| npm run verify | 통과: 타입 검사 + 좌표 38개 + 상태 회귀 검사 6개 |
| 실제 API 응답과 좌표 대조 | 38 통과, 0 실패 |
| 실제 HTTP·WebSocket·TCP | 기존 회귀 테스트 및 Windows Chrome UI에서 확인 |
| N2 장애·즉시 복구 스트레스 | 수정 전 20/20, 수정 후 20/20 및 최종 통합 실행 20/20; 각 회차 전·후 ACK 확인 |
| 실제 포트 충돌 | Windows errno=10048 재현, 실패 503 유지, 잘못된 핸들 교체 결함 수정 |
| 포트 충돌/조건부 재시도 회귀 | 실제 소켓·프로세스 테스트 3개 통과, 전체 187개에 포함 |
| pip check / compileall | 정상 |
| 서버 실행 중 브라우저 애플리케이션 오류 | 0개, React Router 향후 버전 경고 2종 유지 |

환경: Windows 11 / Python 3.12.10 / pytest 9.1.1 / Node 24.21.0 / npm 11.19.0 / Windows Chrome 155.
187개는 기존 184개 + 신규 복구 안정성 테스트 3개입니다. 기존 테스트 조건은 완화하지 않았습니다.
TypeScript 컴파일러도 Windows에서 실제 실행했으며 이전 보고서의 tsc 미실행 상태를 해소했습니다.
테스트 실행 시간은 시스템/장애 복구 성능 수치가 아닙니다.

## 실제 실행 증거

프로젝트 루트 기준으로 다음 실행 원문을 보존했습니다. 이 자료들은 .gitignore 대상입니다.

- `data/measured/windows-validation-20261020T191643Z-5ab1ff0b/summary.json`
  - frontend-typecheck/build/verify, live-layout, pytest, restart-stress 모두 exit 0
  - 각 단계의 원문 `*.txt`와 실행 명령·시각·독립 종료 코드
- `data/measured/stage5-tests-20261020T191726Z-9187b12d/pytest-results.txt`
  - 최종 187개 전체 결과 및 실제 TCP 프로세스 증거
- `data/measured/windows-validation-20261020T191937Z-0080a60f/`
  - Analytics의 초기 기동 오분류 수정 후 최종 프론트엔드 전용 재검증
  - 타입 검사/빌드/verify(상태 6개 포함)/실제 API 좌표 대조 모두 exit 0
- `data/measured/restart-diagnostic-20261020T190424Z-11877dac/`
  - 수정 전 Windows N2 장애·복구 20회 원문
- `data/measured/restart-diagnostic-20261020T191251Z-178bf8f0/`
  - 수정 후 20회 원문. 최종 통합 실행의 추가 20회 디렉터리는 restart-stress.txt에 기록
- `data/measured/windows-ui-20261020T191034Z-78d1a8d1/`
  - browser-verification.json, analytics-final.json, final-backend-snapshot.json
  - 5개 페이지 화면 캡처, browser-errors.txt, backend.log, 실제 소유 노드 JSONL/evidence.json
  - UI 소유 실험 ID: `1155c684-e7ed-455d-b446-4edbaeff9cd1`, 노드 정리 cleanup_failures=[]

브라우저 검증 파일의 before/after-fault는 실제 UI 버튼을 통해 얻은 HTTP 응답입니다.
browser-pages의 Analytics 텍스트는 계측 분류 개선 전 캡처이므로 최종 상태는 analytics-final.json과 갱신된 Analytics.png를 기준으로 합니다.
단위 테스트의 fixture 값은 실제 송수신 결과로 저장하거나 대시보드 런타임에 사용하지 않습니다.

## 실제 UI·통신 흐름

Windows Chrome navigator.platform=Win32를 확인했습니다. 프로덕션 빌드의 Vite preview와 실제 Uvicorn을 127.0.0.1에서 실행했습니다.
일회성 토큰은 탭 메모리에 입력했고 공개 빌드에 포함하지 않았습니다.

1. Overview에서 WS 실시간 연결과 빈 초기 상태를 확인했습니다.
2. 관제 패널의 실험 시작으로 실제 독립 TCP 프로세스 6개가 running이 됐습니다.
3. UI의 서쪽 계단 화재 프리셋으로 시나리오를 생성했습니다(HTTP 201, F2_SW 가상 화재).
4. N1 → N4 안내를 전송해 **N1 → N2 → N4**, ACK 및 disposition=applied를 확인했습니다.
5. UI에서 N2를 종료하고 Heartbeat 장애 판정을 기다린 뒤 다시 전송했습니다.
6. **N1 → N3 → N4** ACK를 받았습니다. 같은 버전의 동일 안내이므로 disposition=duplicate였고, 새 안내를 다시 적용한 것으로 해석하지 않았습니다.
7. 복구 버튼으로 N2의 새 PID와 Heartbeat 정상 복귀, “복구 중” 표시 해제를 확인했습니다.
8. Overview, Digital Twin, Network Monitor, Simulation Lab, Analytics를 방문해 실제 데이터 표시와 WS 연결 유지를 확인했습니다.
9. Digital Twin의 실제 canvas 표시, Network Monitor의 이전/현재 경로 비교, Analytics의 전송·적용 상태 분리를 확인했습니다.
10. 최종 빌드 재로딩 후 WebSocket 재연결과 올바른 보관 창/데이터 없음 처리를 확인했습니다.

이 UI 실험은 장애 감지 후 새 메시지의 우회를 확인한 것입니다. 동일 메시지 전송 도중 종료·재시도는 기존 pytest 통합 테스트로 별도 검증했습니다.
두 안내의 ACK 확인을 일반적인 전달 성공률 보장으로 확대하지 않습니다.

## 복구 오류 분석: 확인된 사실과 미확인 부분

### 확인한 사실

- 기존 LocalCluster.kill은 process.kill() 뒤 wait(timeout=5)를 이미 호출합니다. 무조건 대기 시간을 늘릴 근거는 없었습니다.
- 수정 전 코드의 반복 실험에서 매번 이전 PID가 종료된 것을 확인했고, 자연 발생 503/address already in use는 20회 동안 재현되지 않았습니다.
- 종료된 N2 포트를 **테스트가 소유한 다른 실제 listening socket**으로 점유하면 새 노드는 errno=10048로 시작 실패합니다.
- 따라서 “기존 PID 종료 확인”만으로 “포트 사용 가능”까지 보장할 수는 없습니다.
- 이 실패에서 기존 코드는 node_started/PID 검증 전 새 Popen을 self.processes에 대입했습니다.
  실제 회귀 테스트는 수정 전 `cluster.processes['N2'] is old` 검사에서 실패했고, 수정 후 통과했습니다.
- 재현 시 이전 PID는 종료 상태, 새 자식도 exit 1, 실제 bind probe는 available=false였습니다.
- 현재 격리 환경의 netstat는 해당 소유 PID 행을 제공하지 않았습니다. empty rows를 점유 없음의 증거로 해석하지 않습니다.
  CIM/일부 프로세스 조회도 제한되어 일반 PowerShell 진단 절차를 함께 제공합니다.

### 수정한 동작

- node_started, runtime PID 일치, 실제 프로세스 생존 확인 **이후에만** 새 소유 핸들/로그를 커밋합니다.
- 시작 실패/시간 초과의 새 자식은 소유 Popen 핸들로 종료·회수하고 기존 핸들을 보존합니다.
- CLI 실패 로그에 errno/winerror를 추가했습니다. PID·포트·exit code·원래 오류·실제 bind probe를 `startup-failure-<PID>.json`에 기록합니다.
- 바인딩 충돌이고, 실패 직후 실제 probe에서 포트가 **이미 사용 가능해진 경우에만** 최대 3회 재시작합니다.
  포트가 계속 점유되어 있거나 권한/잘못된 상태 파일 등 다른 실패이면 즉시 503으로 알립니다. 임의 대기는 추가하지 않았습니다.
- 조건부 재시도 테스트는 실제 충돌 소켓을 자식의 실패 후 진단 경계에서 해제하는 방식으로 타이밍을 통제했습니다.
  정상 시작을 가짜 응답으로 대체하지 않았습니다. 다른 프로세스를 종료하거나 포트를 훔치지 않습니다.
- 외부/중복 listener를 허용할 수 있는 Windows SO_REUSEADDR, 강제 RST SO_LINGER, 레지스트리 TIME_WAIT 설정은 변경하지 않았습니다.

### 아직 단정할 수 없는 원인

사용자가 보고한 **원래의 간헐적 503을 Windows에서 자연 재현하지 못했습니다.**
기존 프로세스 잔존, TIME_WAIT, 다른 listener, ephemeral outbound 충돌 중 어느 것이 원래 현상의 원인인지는 미확인입니다.
Linux에서 reuse_address=False가 TIME_WAIT 재바인딩에 영향을 줄 가능성은 있으나 Linux 실패 원문/소켓 상태를 확보하지 않았으므로 원인 확정·해결 완료로 보고하지 않습니다.
현재 TCP 엔진의 소켓 재사용 정책은 그대로 유지했습니다.
[Python 3.12 create_server](https://docs.python.org/3.12/library/asyncio-eventloop.html#asyncio.loop.create_server),
[Microsoft 소켓 재사용/독점 바인딩](https://learn.microsoft.com/en-us/windows/win32/winsock/using-so-reuseaddr-and-so-exclusiveaddruse)

재발 시 같은 시점의 startup-failure JSON, 노드 원본 로그, 이전 PID 종료 코드, 포트 상태를 함께 수집해야 합니다.
이번 변경은 확인된 소유 핸들 결함을 수정하고 재발 원인을 식별할 증거를 보강한 것입니다.

## 프론트엔드의 기술적 수정

- 빠른 복구 중 Heartbeat 이벤트가 HTTP 응답보다 먼저 도착하면, 기존 코드는 응답 후 복구 표시를 새로 켜서 남길 수 있었습니다.
  요청 전 표시하고 실패 시 지우도록 수정했으며 이벤트 선행 회귀 검사로 확인했습니다.
- 시나리오 생성의 실제 201을 항상 200으로 기록하던 실험 기록을 수정했습니다.
  계약 body는 그대로 유지하고 WeakMap 메타데이터로 실제 HTTP 상태를 기록합니다.
- 더 큰 route_version을 가진 과거 scenario_revision이 현재 경로를 덮어쓰지 못하도록 했습니다.
- 이벤트 gap 복구 중 서버 stream_id가 바뀌면 이전 스트림의 이벤트를 새 상태에 적용하지 않습니다.
- Analytics는 로그가 프로세스별로 수집된다는 점을 반영해 원본 사건 시각순으로 비교합니다.
  이전 node_started 증거 없는 첫 기동을 “재시작 복구” 표본으로 만들지 않습니다. 보관 창 밖으로 증거가 사라지면 데이터 없음입니다.
- address already in use만으로 “몇 초 후 해제”를 단정하던 오류 문구를 실제 PID/포트 진단 확인 안내로 변경했습니다.
- 누락된 npm run verify를 추가했고, 좌표 38개 및 위 상태 회귀 6개를 묶었습니다.

React 레이아웃, 색상, 라우트 5개, 3D 좌표, 가구, 네트워크 시각화 디자인은 수정하지 않았습니다.

## 실패·제한 기록

1. 초기 localhost connect는 WinError 10013. 권한 허용 후 진단과 실제 통신 테스트를 실행했습니다.
2. 초기 프론트엔드 typecheck/build는 통과했으나 tsx가 설치되어 있지 않아 verify:layout은 실행 실패했습니다.
3. npm ci/복원 중 esbuild.exe 삭제·캐시 mkdir가 EPERM으로 차단됐습니다. 해당 폴더 쓰기 권한을 허용받아 lockfile 기반 npm ci를 완료했습니다.
   의존성 메이저 업그레이드는 하지 않았습니다. 복원 후 최종 검증은 통과했습니다.
4. 초기 Python 전체 실행은 **183 passed, 1 failed**였습니다.
   `test_delayed_old_guidance_does_not_replace_newer`의 os.replace에서 WinError 5가 발생했습니다.
   보관 경로: `stage5-tests-20261020T190714Z-ec0f2ddb/pytest-results.txt`.
   해당 테스트 파일 재실행 15개, 후속 전체 185개와 최종 187개는 통과했습니다.
   상태 파일 원자성·실패 처리 테스트를 완화하지 않았고, 이 WinError 5의 근본 원인은 미확정입니다.
5. 격리 환경에서 일시 검증 서버 정리용 taskkill이 동작하지 않아 첫 보조 스크립트 종료가 실패했습니다.
   실제 TCP 노드 정리는 먼저 API로 완료했고 cleanup_failures=[]였습니다.
   보조 스크립트를 원래 Popen 핸들로 종료하도록 수정하고 별도 기동/종료 시험으로 재확인했습니다.
   수정 후 `windows-ui-20261020T192225Z-907df96b/servers.json`은 status=stopped, experiment_cleanup_http_status=200이며 보조 스크립트 exit 0입니다.
   검증 서버 종료 후 남아 있던 브라우저의 재접속/조회 오류는 서버 부재로 인한 종료 구간 기록으로 구분하며, 이후 브라우저도 닫았습니다.
6. Windows 외 Linux의 원래 간헐 복구 오류는 이번 환경에서 실기 재검증하지 않았습니다.
7. React Router v7 미래 동작 경고와 일부 기존 npm 의존성 deprecated 경고는 남아 있습니다.
   빌드 실패나 브라우저 런타임 오류는 아니며 이 작업에서 디자인/의존성 메이저 마이그레이션은 하지 않았습니다.

## 변경 파일

| 파일 | 변경 이유 |
|---|---|
| src/exit_link/simulation/processes.py | 검증 후 소유권 교체, 실패 자식 회수·진단 보존 |
| src/exit_link/simulation/diagnostics.py (추가) | 실제 bind probe와 포트 관측, 소유자 관측 가능 여부 |
| src/exit_link/communication/__main__.py | 실패 errno/winerror 원문 기록 |
| src/exit_link/api/runtime.py | 증거가 있는 해제된 충돌에 한해 상한 재시도 |
| tests/test_restart_stability.py (추가) | 실제 점유·503 보존·조건부 재시작 3개 |
| scripts/diagnose_restart.py (추가) | 실제 6노드 반복 장애·복구·ACK 기록 |
| scripts/verify_windows.py (추가) | Windows 전체/프론트엔드 전용 검증과 단계별 종료 코드 |
| scripts/serve_validation.py (추가) | 소유 localhost 서버/일회성 토큰/정리 가능한 브라우저 검증 환경 |
| frontend/package.json | verify, verify:state 명령 |
| frontend/scripts/verify-state.ts (추가) | 상태·HTTP·빠른 복구·계측 분류 회귀 검사 |
| frontend/src/api/client.ts | 실제 HTTP 상태 메타데이터, Node 검증 환경 호환 |
| frontend/src/api/actions.ts | 실제 상태 코드 기록, 복구 표시 경합 수정 |
| frontend/src/store/store.ts | 복구 표시 해제, 과거 시나리오 경로 차단 |
| frontend/src/realtime/socket.ts | 스트림 교체/실패한 gap 복구 후 과거 이벤트 차단 |
| frontend/src/domain/errors.ts | 원인 미확정인 포트 오류 안내 정정 |
| frontend/src/domain/analytics.ts | 첫 기동/재시작 구분과 원본 사건 시각 순서 |
| README.md, frontend/README.md | 현재 구성과 Windows 검증 방법 |
| docs/sqlite-persistence-design.md (추가) | 승인 전 저장 구조·API 영향·마이그레이션 검토안 |
| docs/windows-validation-report.md (추가) | 이 보고서 |

OpenAPI, WebSocket JSON Schema, 기존 생성 타입 파일, TCP 메시지/ACK 모델은 바꾸지 않았습니다.
기존 계약 drift 테스트와 프론트엔드 타입 검사가 통과했습니다. 커밋·원격 업로드는 수행하지 않았습니다.

## PowerShell 검증 방법

```powershell
Set-Location 'C:\Users\User\Documents\Codex\2026-10-20\exit-link-fastapi-python-tcp-socket\outputs\exit-link'
.\.venv\Scripts\python.exe scripts\diagnose_tcp.py
.\.venv\Scripts\python.exe scripts\verify_windows.py --restart-cycles 20
$LASTEXITCODE

# 개별 실행
.\.venv\Scripts\python.exe scripts\verify_stage5.py
Set-Location frontend
npm.cmd ci
npm.cmd run typecheck
npm.cmd run build
npm.cmd run verify
```

브라우저 전체 흐름은 build 후 백엔드 루트에서 `scripts/serve_validation.py`를 실행합니다.
출력된 control-token.local을 로컬에서만 읽어 UI에 입력합니다. Ctrl+C 또는 stop.local 파일로 종료합니다.
보조 스크립트는 기본 8000/5173이 이미 사용 중이면 기존 서버를 종료하지 않고 실패합니다.
기존 서버를 이용하려면 각각 README의 일반 실행 명령을 사용합니다.
실행 중 API 좌표 대조는 `npm.cmd run verify:layout -- --api http://127.0.0.1:8000`입니다.

UI 절차: 실험 시작 → 프리셋 생성 → N1/N4 안내 → N2 장애 → down 확인 → 다시 안내 → ACK/적용 상태 확인 → N2 복구 → up 확인 → 5개 페이지 확인 → 실험 종료.
localhost가 차단된 경우 실제 통신/브라우저 성공으로 기록하지 않습니다. 전체 pytest 사전 검사 차단은 종료 코드 2로 보존됩니다.

포트 진단은 실패 JSON의 실제 포트/PID를 사용합니다. 고정 9102만 검사하면 API 임시 포트를 놓칩니다.

```powershell
$nodePort = 12345 # startup-failure JSON의 실제 port로 대체
Get-NetTCPConnection -LocalPort $nodePort -ErrorAction SilentlyContinue |
    Select-Object LocalAddress,LocalPort,RemoteAddress,RemotePort,State,OwningProcess
netstat -ano -p tcp | Select-String ":$nodePort\s"
# OwningProcess가 확인된 뒤 해당 PID를 조회합니다. PID 0/TIME_WAIT는 살아 있는 노드 PID가 아닙니다.
Get-Process -Id 12345 # 실제 관측 PID로 대체; 진단 단계에서 임의 종료하지 않음
netsh interface ipv4 show dynamicport tcp
netsh interface ipv4 show excludedportrange protocol=tcp
```

## 공모전 제출 전 추가 실험

- 실제 간헐 503 재발 환경에서 동일 시점의 실패 JSON·PID·LISTEN/TIME_WAIT·포트 예약 증거 확보
- 일반 Windows PowerShell에서 상태 파일 반복 교체와 디스크 접근 거부/점유 재현, WinError 5 원인 분리
- 기본/저사양 PC, 3D 화면 켠 상태, 동시 트래픽 등 부하별 Heartbeat 오탐·감지/복구 분포를 반복 측정
- 현재 0.1s 간격·0.15s 응답 기한·실패 2회 조건과 다른 조건을 분리해 비교; 기동 수렴과 장애 주입 표본 분리
- 고해상도 시계로 계측 방법을 버전 관리한 후 충분한 표본의 지연·재전송·경로 전환 성공률/실패·불확실 결과 수집
- 짧은 끊김/연속 2노드 장애/실험 종료 중 송신/장시간 실행/브라우저 재접속·512개 보관 창 초과 시험
- SQLite 승인 후 재시작 복원, 원자성·중복·강제 종료·디스크 부족·백업 복원 시험

이는 아직 수행하지 않은 제출 전 실험 목록입니다. 기존 가상 건물·재난 입력의 시각화는 실제 현장 안전 검증이 아닙니다.
