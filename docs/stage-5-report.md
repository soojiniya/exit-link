# EXIT-LINK 5단계 백엔드 구현·검증 보고서

작성: 2026-10-21 (Asia/Seoul). 기존 프로젝트에만 추가했으며 프론트엔드·3D는 구현하지 않았습니다.

## 최종 검증

**전체 pytest 184개 통과, 실패 0, 종료 코드 0.**
기존 141개 회귀 테스트와 신규 43개(ASGI REST/WS·보안 36, 계약 2, 실제 통신 5)를 포함합니다.
기존 테스트의 검증 조건 및 4단계 JSON Schema 10개를 변경하지 않았습니다.

- 실행: `.venv/Scripts/python.exe scripts/verify_stage5.py`
- 환경: Windows / Python 3.12.10 / pytest 9.1.1
- 출력 원문: `data/measured/stage5-tests-20261020T172142Z-29085390/pytest-results.txt`
- 사전 검사·종료 코드: 같은 폴더의 `summary.json` (`success:true`, `status:passed`, `pytest_exit_code:0`)
- pytest 출력 시간: **70.14초**. 이 값은 전체 테스트 실행 시간이며 장애 감지·복구 성능 지표가 아닙니다.
- pip check: No broken requirements found. src/scripts/tests compileall 성공.
- 계약 파일은 재생성 결과와 일치함을 검사했습니다. TypeScript 컴파일러 tsc는 설치되지 않아 별도 타입 컴파일은 미실행입니다.

전체 검증 뒤 계약 테스트 중 변환기 단순 매핑 검사를 제어 API의 토큰·node_id 대상 명세 검사로 보강했습니다.
계약 테스트 2개를 다시 실행해 모두 통과했습니다(1.65초). 애플리케이션 코드는 전체 검증 이후 변경하지 않았습니다.

초기 localhost 진단은 connect 단계 WinError 10013으로 차단됐습니다.
이 채팅의 네트워크 실행 권한을 허용받은 후 동일 진단이 성공했으며 실제 통합 테스트를 실행했습니다.
초기 신규 테스트 실행에서 시스템 임시 폴더 쓰기가 제한되어 fixture 오류가 발생했습니다.
프로젝트 내부의 고유 basetemp를 사용해 재실행했고, 검증 스크립트에도 동일 방식을 적용했습니다.
WebSocket TestClient의 상대 URL은 ws://testserver로 연결되어 Host 제한에 거부되는 것을 확인했습니다.
테스트 URL을 실제 허용 대상 ws://127.0.0.1로 지정했습니다. 서버의 Host 검사와 Assertion은 완화하지 않았습니다.

## 실제 HTTP·WebSocket·TCP 검증

신규 통합 테스트는 가짜 TCP 응답이나 그래프 시뮬레이션을 성공 결과로 대체하지 않습니다.
별도 Uvicorn 프로세스를 127.0.0.1 임시 포트에 띄우고, HTTP 실험 API가 노드 6개를 각각 독립 프로세스로 실행합니다.
각 노드의 runtime PID 확인과 3단계 Heartbeat 수렴 확인을 재사용합니다.
Python httpx2와 websockets 클라이언트로 실제 HTTP/WS 연결을 맺습니다.

| 실제 검증 | 확인 결과 | 증거 (stage5-backend/ 아래) |
|---|---|---|
| HTTP 안내 → 다중 홉 TCP → ACK/적용 receipt | N1 → N2 → N4, applied | http-guidance.json |
| WebSocket 초기 스냅샷·위험 변경·안내 결과 | no_route 대피 경로와 실제 안내 ACK, 연속 이벤트 번호 | websocket-events.json |
| HTTP로 N2 종료 → 장애 감지 → 우회 → 복구 | N1 → N3 → N4, ACK/applied, neighbor_down/recovered 원본 로그 | fault-recovery.json |
| 잘못된 노드·중복 시작·외부 Origin 제어 | 404/409/403, 기존 소유 PID 유지 | pytest-results.txt, uvicorn.log |
| N2/N3 연속 종료 후 출발 노드 고립 | ack_received=false, transport_result.error.code=no_route | no-route.json |

실제 소유 실험 ID는 `86260cbc-555d-4561-b90b-f44232db16d8`입니다.
`stage5-backend/owned-clusters/<실험ID>/evidence.json`에서 프로세스 실행 이력 9회(최초 6개+복구 3회),
장애 주입 3회, **cleanup_failures=[]**를 확인했습니다. 개별 JSONL 원본 로그도 보존했습니다.
TCP ACK는 메시지 전달 증거이며 사람의 대피 완료나 실제 화재 안전 증거가 아닙니다.
가상 화재·통로 차단 입력과 실제 TCP 전달 관측을 각각 simulation / real_tcp_observation으로 구분합니다.

## 추가·수정 파일

| 파일 | 변경 내용 |
|---|---|
| src/exit_link/api/contracts.py (추가) | 요청·응답·이벤트 모델, 기존 4단계 모델 재사용 |
| src/exit_link/api/security.py (추가) | 설정, loopback/Host/Origin 검사, 토큰 검사 |
| src/exit_link/api/events.py (추가) | 순서·보관 창·느린 구독자 처리를 갖춘 이벤트 버스 |
| src/exit_link/api/runtime.py (추가) | 시나리오·실제 TCP 관측·안내 전송·소유 실험 수명주기 |
| src/exit_link/api/dashboard.py (추가) | REST 21개 동작과 WebSocket 라우트 |
| src/exit_link/main.py (수정) | 앱 lifespan·CORS·오류 처리·신규 라우터 등록 |
| scripts/export_stage5_contracts.py (추가) | 실행 가능한 모델에서 OpenAPI·WS 스키마·TS 타입 생성 |
| scripts/verify_stage5.py (추가) | localhost 사전 검사, 전체 테스트 및 원본 증거 보관 |
| tests/test_stage5_api.py (추가) | REST/WS·권한·Origin·Host·커서·큐 테스트 36개 |
| tests/test_stage5_contracts.py (추가) | 계약 drift 및 제어 API 보안 명세 테스트 2개 |
| tests/test_stage5_tcp.py (추가) | 실제 HTTP/WS/TCP 통합 테스트 5개 |
| docs/contracts/stage5/openapi.json (추가) | /health 포함 REST 22개 동작의 기계 명세 |
| docs/contracts/stage5/WebSocket.schema.json (추가) | 초기 스냅샷+실시간 이벤트 6종 |
| docs/contracts/stage5/types.ts (추가) | REST 모델·Operations·Ws 모델·ServerFrame 타입 |
| docs/stage-5-api-guide.md (추가) | 전체 API 표·이벤트 스키마·PowerShell 예·Claude 인계 |
| docs/stage-5-report.md (추가) | 이 보고서 |
| README.md (수정) | 최신 범위·실행·검증·상태 수명 |
| data/measured/README.md (수정) | 가상 자료와 실제 실행 증거의 구분 |

기존 communication/fault_detection/routing/evacuation/topology 코드·JSON·의존성은 변경하지 않았습니다.
.gitignore의 .env*, 인증정보·로컬 환경·data/measured 제외 규칙은 유지합니다.
실제 실행 증거는 로컬 data/measured에 보관하며 자동 Git 업로드하지 않습니다. 커밋·원격 업로드는 하지 않았습니다.

## 동작 원리와 안전한 제어

ScenarioSession이 건물 이동 그래프에서 계산한 상태를 REST와 이벤트에 투영합니다.
위험 구역 교체는 expected_revision을 확인하고 등록한 출발지의 경로를 다시 계산합니다.
안내 전송은 기존 send_guidance를 호출하므로 3단계 자동 통신 경로 전환·TTL·중복 방지·ACK를 유지합니다.
안내 수신 노드의 4단계 버전 가드와 파일 저장도 그대로 유지합니다.

네트워크 폴러는 실제 get_status 응답을 기본 1초 간격(+I/O 소요 시간)으로 관측합니다.
관측 전에는 빈 nodes/not_observed이며, 실패 시 실제 오류를 기록하고 성공 상태를 생성하지 않습니다.
소유 노드 JSONL 로그는 바이트 offset으로 새 완전한 행만 읽고 장애/복구·송수신/ACK 이벤트를 발행합니다.
기존 TCP Heartbeat 자체는 노드 프로세스에서 계속 동작하며 웹서버가 장애 판정을 대체하지 않습니다.

제어 API는 실제 peer loopback, 로컬 Host, 명시적 Origin, 제어 토큰을 검사합니다.
실험 활성화는 명시적 환경변수가 필요하고, 기본값은 비활성화입니다.
백엔드가 직접 생성한 Popen 핸들만 제어하고 API에서 PID/명령/파일 경로를 받지 않습니다.
시작·종료·장애·복구 요청은 한 개의 asyncio 제어 lock으로 직렬화합니다.
외부 수동 노드를 관측하더라도 이 API로 종료할 수 없습니다.

WebSocket은 초기 스냅샷을 보내고 그 다음 sequence의 이벤트를 제공합니다.
최근 512개 재조회, stream_id 변경·커서 누락 감지, 큐 초과 시 1013 재동기화, 연결 종료 시 구독 정리를 구현했습니다.
자세한 이벤트 payload와 Claude 적용 순서는 [API 가이드](stage-5-api-guide.md)에 있습니다.

## 로컬 PowerShell 재검증

```powershell
Set-Location 'C:\Users\User\Documents\Codex\2026-10-20\exit-link-fastapi-python-tcp-socket\outputs\exit-link'
.\.venv\Scripts\python.exe scripts\diagnose_tcp.py
.\.venv\Scripts\python.exe scripts\verify_stage5.py
$LASTEXITCODE
```

사전 진단 차단 시 pytest를 실행하지 않고 종료 코드 2로 기록합니다.
테스트 실패/시간 초과 시 비제로, 통과 시 0입니다. 제한 시간은 300초입니다.
검증기는 매 실행 고유 디렉터리를 생성하므로 이전 검증 자료를 덮어쓰지 않습니다.

서버 실행과 사용자 지정 시나리오·장애·안내 예는 README와 API 가이드에 정리했습니다.

## 측정과 남은 범위

기존 엔진이 관측한 재시도 횟수, 실제 ACK 경로, 시도별 경로 계산 ms,
전달 시간 ms, 장애 의심부터 확정까지의 ms를 API/이벤트/원본 로그에서 확인할 수 있습니다.
단위·시점은 가이드에 명시했으며 측정값을 임의 생성하거나 일반 성능 보장으로 해석하지 않습니다.

API 상태는 단일 worker 메모리이며 시나리오/결과 목록은 서버 재시작 때 초기화됩니다.
결과와 이벤트는 각각 최근 512개만 보관합니다. 영구 이력·SQLite·멀티 worker 동기화는 미구현입니다.
새 실험은 새 수신 저장소를 사용합니다. 같은 실험 내 노드 복구에는 기존 버전 가드가 유지됩니다.
복구 API 성공은 프로세스 시작 확인이며 Heartbeat가 up으로 수렴했는지는 실제 network 관측을 확인해야 합니다.
강제 서버 종료/전원 차단 시 자식 프로세스 정리까지 보장하지 않습니다.
React/3D·실제 센서·상용 장비·실제 재난 안전 검증·사람의 대피 완료 판정은 구현하지 않았습니다.

Claude는 `openapi.json`, `WebSocket.schema.json`, `types.ts`, `stage-5-api-guide.md`를 받아 UI를 연결할 수 있습니다.
백엔드 계약 파일을 기준으로 두 그래프·가상 위험·실제 TCP 상태·전송 적용 여부를 각각 표현합니다.
