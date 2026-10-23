# 5단계 API 및 Claude 연동 가이드

기준: `/api/v1`, `ws://127.0.0.1:8000/ws/v1/events`, 단일 worker.
프론트엔드와 3D 코드는 이 단계에 포함하지 않습니다.

## 계약 파일과 기존 스키마 재사용

- `contracts/stage5/openapi.json`: REST 요청·응답·오류·인증 헤더의 기계 판독 명세
- `contracts/stage5/WebSocket.schema.json`: `type`으로 구분하는 7종 서버 프레임
- `contracts/stage5/types.ts`: 위 명세에서 생성한 타입과 `Operations` 요청/응답 매핑
- `schemas/stage4/`: 기존 JSON Schema 10개 유지, 변경 없음

4단계 HazardUpdate/ScenarioSnapshot/EvacuationPlan/GuidanceDelivery를 REST에서 재사용합니다.
ScenarioDefinition은 기존 배치 시나리오 입력용이며 HTTP 생성은 ScenarioCreate를 사용합니다.
Guidance/GuidanceReceipt/GuidanceQuery/GuidanceReply는 기존 TCP 내부 계약입니다.
기존 DashboardSnapshot은 단일 시나리오의 내보내기 파일용으로 유지합니다.
API의 BackendSnapshot은 시나리오 목록, 네트워크 관측, 실험 상태, 최근 전송 결과와 스트림 커서를 담습니다.
건물 이동 그래프와 통신 그래프는 기존대로 별개입니다.

## 실행·접근 제한

README의 서버 실행 명령을 사용합니다. 필수 옵션은 `--host 127.0.0.1 --workers 1 --no-proxy-headers`입니다.
실험 중 `--reload`를 사용하지 않습니다.
`EXIT_LINK_CONTROL_TOKEN`은 32자 이상이며 모든 POST/PUT/DELETE에 `X-Exit-Link-Token`으로 전송합니다.
토큰이 없으면 읽기 전용입니다. 실험 제어에는 추가로 `EXIT_LINK_ENABLE_EXPERIMENTS=1`이 필요합니다.
토큰은 API 응답, OpenAPI, WebSocket, 실행 로그에 포함하지 않습니다.
프론트엔드는 사용자가 로컬에서 입력한 토큰을 메모리에서 사용하며 소스·공개 빌드·Git에 넣지 않습니다.

REST와 WebSocket 모두 실제 연결 상대의 IP가 loopback인지 확인합니다.
Host는 localhost/127.0.0.1/::1만 허용하며 X-Forwarded-For를 인증 근거로 사용하지 않습니다.
Origin이 있으면 정확한 허용 목록과 일치해야 합니다. 기본 목록은 다음 4개입니다.

- `http://localhost:5173`, `http://127.0.0.1:5173`
- `http://localhost:8000`, `http://127.0.0.1:8000`

CORS credentials/cookie 인증과 wildcard origin을 사용하지 않습니다.
다른 개발 포트를 쓸 경우 ApiSettings.origins에 명시적으로 추가합니다. 프록시를 통한 제어는 지원하지 않습니다.
WebSocket은 읽기 전용이므로 제어 토큰을 URL에 넣지 않습니다.
동일 PC의 신뢰하는 개발자를 위한 제한이며, 다중 사용자 인증·TLS·로컬 악성 프로세스 방어는 구현하지 않았습니다.

## REST API 목록

| Method | 경로 (`/api/v1` 뒤) | 응답/역할 |
|---|---|---|
| GET | `/building` | BuildingView: 건물 노드·이동 연결과 층별 공간 ID |
| GET | `/building/floors/{floor}` | FloorView, 없는 층 404 |
| GET | `/snapshot` | BackendSnapshot: 현재 상태와 스트림 커서 |
| GET | `/network` | NetworkView: 통신 토폴로지와 마지막 실제 TCP 관측 |
| POST | `/network/refresh` | 즉시 실제 TCP 상태 재관측, 토큰 필요 |
| GET | `/scenarios` | 현재 시나리오 목록 |
| POST | `/scenarios` | ScenarioCreate → ScenarioSnapshot, 201 |
| GET | `/scenarios/{scenario_id}` | 상태·경로·재난 이벤트 이력 |
| GET | `/scenarios/{scenario_id}/hazards` | HazardUpdate |
| PUT | `/scenarios/{scenario_id}/hazards` | 위험 구역 전체 교체 및 등록된 출발지 재탐색 |
| GET | `/scenarios/{scenario_id}/plans` | 이미 계산한 경로 목록 |
| POST | `/scenarios/{scenario_id}/plans` | PlanRequest, 출발지 경로 계산·추적 등록 |
| POST | `/scenarios/{scenario_id}/guidance` | GuidanceSend → 실제 GuidanceDelivery |
| GET | `/deliveries?scenario_id=...` | 최근 전송 결과, 시나리오 필터 선택 |
| GET | `/deliveries/{message_id}` | 단일 전송 결과, 없거나 보관 창 밖이면 404 |
| GET | `/experiment` | 활성화 여부·실험 ID·소유 노드 PID/실행 상태 |
| POST | `/experiment` | 실제 독립 프로세스 6개 시작 및 초기 Heartbeat 수렴 대기 |
| DELETE | `/experiment` | 소유 실험 종료·프로세스 정리·로그 보존 |
| POST | `/experiment/nodes/{node_id}/fail` | 소유 노드 프로세스 강제 종료 |
| POST | `/experiment/nodes/{node_id}/recover` | 같은 실험 노드 재시작, Heartbeat 재확인은 별도 관측 |
| GET | `/events?stream_id=...&after=...` | EventPage, 최근 512개 이벤트의 커서 기반 재조회 |

실험 시작/종료/노드 제어에는 요청 본문이 필요하지 않습니다. PID, 명령어, 실행 파일, 파일 경로를 입력받는 API는 없습니다.
수동 CLI로 실행한 노드는 고정 포트 9101~9106에서 관측할 수 있지만 실험 제어 대상이 아닙니다.
API 소유 실험은 원본 JSON의 ID·연결 관계를 유지하면서 임시 loopback 포트를 사용합니다.
`NetworkView.configuration_source`와 응답 topology의 실제 포트를 기준으로 표시합니다.
실험 종료 후 프로젝트 기본 토폴로지 관측으로 돌아갑니다.

## 생성·위험 변경·안내 전송 예

아래는 요청 예이며 성공을 가정한 실험 결과가 아닙니다.
서버를 실행한 별도 PowerShell 터미널에서 서버 토큰을 입력합니다.

```powershell
$api = 'http://127.0.0.1:8000/api/v1'
$headers = @{ 'X-Exit-Link-Token' = (Read-Host '서버에서 생성한 제어 토큰') }
$scenario = Invoke-RestMethod -Method Post -Uri "$api/scenarios" -Headers $headers -ContentType 'application/json' -Body '{"starts":["F2_E","F3_W"]}'
$sid = $scenario.state.scenario_id
$experiment = Invoke-RestMethod -Method Post -Uri "$api/experiment" -Headers $headers

$body = @{ expected_revision = $scenario.state.revision; hazards = @{ fire_locations = @('F2_SW') } } | ConvertTo-Json -Depth 10
$scenario = Invoke-RestMethod -Method Put -Uri "$api/scenarios/$sid/hazards" -Headers $headers -ContentType 'application/json' -Body $body

$body = @{ start_location='F2_E'; source_node='N1'; destination_node='N4'; expected_revision=$scenario.state.revision; ttl=16; max_retries=3; timeout_seconds=30 } | ConvertTo-Json
$delivery = Invoke-RestMethod -Method Post -Uri "$api/scenarios/$sid/guidance" -Headers $headers -ContentType 'application/json' -Body $body
$delivery | ConvertTo-Json -Depth 20

Invoke-RestMethod -Method Post -Uri "$api/experiment/nodes/N2/fail" -Headers $headers
Invoke-RestMethod -Method Post -Uri "$api/experiment/nodes/N2/recover" -Headers $headers
Invoke-RestMethod -Method Delete -Uri "$api/experiment" -Headers $headers
```

HazardUpdate는 PATCH가 아니라 **전체 교체**입니다. 누락한 위험 목록은 빈 배열이 됩니다.
fire_locations/dangerous_nodes/blocked_nodes는 건물 위치 ID, blocked_passages는 `{source,target}` 목록입니다.
expected_revision은 직전 응답 값을 사용합니다. 충돌하면 409 후 최신 시나리오를 다시 조회합니다.
동일 위험 상태를 재전송하면 revision/route_version을 증가시키지 않습니다.
경로 없음은 status=no_route, path=[], exit_id=null, distance_m=null입니다.

안내 전송은 기존 send_guidance → ReliableSend → 독립 TCP 노드 → ACK/GuidanceReceipt 순서입니다.
TCP 실패도 정상적으로 관측한 결과이면 HTTP 200의 GuidanceDelivery로 반환합니다.
HTTP 200 자체를 전달 성공으로 해석하지 말고 ack_received와 transport_result.success를 확인합니다.
적용 여부는 application_receipt.disposition(applied/stale/duplicate/version_conflict/publisher_conflict)으로 구별합니다.
ACK가 있어도 receipt_query_error가 있으면 애플리케이션 적용 상태는 미확인입니다.
ACK는 사람의 대피 완료를 뜻하지 않으며 human_evacuation_verified는 항상 false입니다.
재난 위험 변경은 재계산까지만 자동 수행합니다. 새 안내의 실제 전송은 명시적으로 POST /guidance를 호출합니다.

오류 본문은 `{detail:{code,message}}`입니다.
403 접근·토큰·실험 비활성, 404 대상 없음, 409 버전·프로세스 상태 충돌,
422 요청·건물 위치·입력 검증, 429 동시 송신 한도, 503 실험 시작·제어·정리 실패를 구분합니다.
요청한 장애 주입 자체와 Heartbeat의 장애 확정은 서로 다른 이벤트입니다.

## WebSocket 이벤트 계약

연결 직후 `{type:"snapshot", payload:BackendSnapshot}` 한 개를 전송합니다.
이 스냅샷은 stream_id와 마지막 sequence를 포함합니다. 이 시점의 상태로 UI를 교체합니다.
이후 이벤트 공통 필드는 다음과 같습니다.

| 필드 | 타입/의미 |
|---|---|
| schema_version | 문자열 `1.0` |
| stream_id | 백엔드 인스턴스의 UUID, 재시작 시 변경 |
| sequence | 인스턴스 내 단조 증가 번호 |
| event_id | 이벤트 UUID |
| timestamp | 백엔드 이벤트 발행 UTC ISO 8601 시각 |
| type | 아래 6종 discriminant |
| payload | type별 Pydantic 모델 |

| type | payload | UI 처리 |
|---|---|---|
| scenario.changed | ScenarioSnapshot | 해당 시나리오·재난 이벤트 이력 교체 |
| route.changed | EvacuationPlan | (scenario_id,start_location)의 경로 갱신 |
| network.changed | NetworkView | 실제 관측·토폴로지 갱신 |
| network.event | NetworkEvent | 원본 노드의 장애/복구·송수신·ACK 이벤트 추가 |
| guidance.result | GuidanceDelivery | message_id로 전달 결과 반영 |
| experiment.changed | ExperimentView | 소유 프로세스 제어 상태 갱신 |

network.event.timestamp는 **원본 프로세스 로그 시각**, 바깥 timestamp는 **서버 발행 시각**입니다.
gossip의 단순 state_updated/heartbeat_config 로그는 UI 스트림에서 제외하고 원본 실험 로그에 보존합니다.
관측 주기는 기본 1초 + 관측 소요 시간이며 실제 즉시성이 보장되는 푸시 센서는 아닙니다.
연결할 수 없으면 reachable=false 및 실제 오류를 기록합니다. not_observed/monitor_error를 정상으로 표시하지 않습니다.
TCP 관측 실패만으로 위험 구역이나 이동 그래프를 변경하지 않습니다.
노드 내부 Advertisement.epoch는 Python의 큰 정수이므로 JS에서 정밀 비교하지 않습니다.
UI 순서 판단에는 stream_id/sequence와 scenario_revision/route_version을 사용합니다.

같은 stream_id에서 sequence <= 적용한 번호는 무시하고, 번호가 빠지면 `/events`로 재조회합니다.
reset_required=true 또는 stream_id 변경이면 `/snapshot`으로 현재 상태를 교체합니다.
WebSocket 재접속 자체도 새 snapshot을 제공하므로 초기화에 사용할 수 있습니다.
연결 시 구독 등록과 baseline 생성 사이에 await가 없어 초기 상태와 다음 이벤트 사이의 누락을 방지합니다.
느린 클라이언트의 큐 128개가 차면 1013으로 닫고 재접속을 요구합니다. 최대 구독자는 32명입니다.
WebSocket으로 제어 명령 등 데이터를 보내면 1008로 닫습니다.
연결 해제 시 구독과 송수신 task를 해제합니다. 무제한 메시지 버퍼나 영구 이벤트 재생은 제공하지 않습니다.

## Claude 인계 순서

1. OpenAPI와 types.ts를 프로젝트 계약으로 사용하고 URL/필드 이름을 임의로 변경하지 않습니다.
2. `/building`과 `/network`로 두 그래프를 각각 구성합니다. 좌표·3D 배치는 추후 UI 작업이며 여기에는 실제 평면도가 없습니다.
3. WebSocket 초기 snapshot으로 상태를 구성하고 ServerFrame.type에 따라 반영합니다.
4. 가상 위험·대피 경로에는 simulation 표시, TCP 노드/ACK에는 실제 관측 시각과 오류를 표시합니다.
5. 위험 수정·안내 전송 시 expected_revision을 보내고 409를 처리합니다. 오래된 route_version으로 새 경로를 덮어쓰지 않습니다.
6. 토큰은 로컬 사용자에게 받아 메모리에서 헤더로 사용합니다. UI 지표를 임의 생성하지 않습니다.
7. 빈 데이터·not_observed·오류·no_route·미확인 receipt 상태를 별개로 표현합니다.
8. 발행한 안내와 전송 결과의 scenario_id/message_id를 연결합니다. guidance.result는 재난 이벤트 이력 전체를 대체하지 않으므로 필요하면 시나리오를 재조회합니다.

타입은 생성 결과이며 프론트엔드의 TypeScript 컴파일러에서도 확인합니다.
이 백엔드 환경에는 tsc가 설치되지 않아 tsc 자체의 검증은 별도로 수행하지 않았습니다.
기계 명세와 타입의 drift는 pytest로 확인합니다.

## 보관·측정·현재 한계

시나리오는 최대 32개/서버 세션, 시나리오별 이벤트가 2048개에 도달하면 신규 변경을 거부합니다.
동시 안내 송신은 8개, 결과와 이벤트 재조회는 각각 최근 512개입니다.
API 시나리오/결과 목록은 메모리 상태이며 재시작 시 초기화됩니다. SQLite 영속화는 후속 작업입니다.
소유 노드의 안내 버전 가드는 기존 파일 저장으로 유지되지만 새 실험은 새로운 별도 저장 디렉터리를 사용합니다.
소유 실험의 실제 로그는 data/measured/stage5/<experiment_id>/에 남습니다.
강제 서버 종료 시 자식 정리를 보장하지 않으므로 정상 종료 또는 DELETE /experiment를 먼저 사용합니다.

transport_result의 attempts/retries/route_calculation_ms/elapsed_ms/ACK.route와
실제 neighbor_down 로그의 detection_since_first_failure_ms 등을 그대로 노출합니다.
경로 거리 단위는 m_assumed, 관측 성능 시간은 필드명의 ms이며 timestamp는 UTC입니다.
실제 관측이 없는 지표는 null/빈 값으로 유지하고 추정 성공·성능 수치를 만들지 않습니다.
대시보드 그래프용 좌표·3D·React·실제 센서·사용자 인증·영속 이벤트 저장은 이번 범위 밖입니다.

구현 시 참고: [FastAPI WebSockets](https://fastapi.tiangolo.com/advanced/websockets/),
[Lifespan](https://fastapi.tiangolo.com/advanced/events/), [CORS](https://fastapi.tiangolo.com/tutorial/cors/).
