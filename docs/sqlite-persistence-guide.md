# SQLite 실험 기록 및 Claude Analytics 연동

기존 REST·WebSocket·TCP 스키마와 5개 페이지를 유지하고, 별도 읽기 전용 이력 API를 추가했습니다.
현재 화면은 RAM 상태, 과거 기록은 SQLite 상태입니다. 이력의 PID와 healthy 상태를 현재 프로세스에 적용하지 않습니다.

## 설계안 검토 후 결정

- Python 기본 sqlite3의 3.49.1 대신 패치된 SQLite 3.54.1 내장 APSW 3.54.1.0을 고정했습니다.
  [SQLite WAL-reset 수정 설명](https://www.sqlite.org/wal.html#the_wal_reset_bug),
  [APSW 내장 SQLite 설명](https://rogerbinns.github.io/apsw/install.html).
- 초안의 “커밋 후 WS”는 DB 오류가 TCP·실시간 처리를 막지 않아야 한다는 요구와 충돌했습니다.
  WS를 먼저 발행하고 전용 스레드의 유한 FIFO 큐(1,024건)로 기록합니다. WS 수신/HTTP 200은 DB 커밋 확인이 아닙니다.
  이력 조회는 앞서 큐에 들어간 기록의 처리 장벽입니다. 조회 결과와 저장 상태를 함께 확인합니다.
- 정규화는 실제 조회에 필요한 10개 업무 테이블로 제한했습니다. 별도 scenarios/plans/faults/metrics 테이블 대신
  버전별 시나리오·전체 스냅샷·원문 이벤트·전달 시도에 보관합니다. 기존 로그 자동 가져오기와 outbox는 미구현입니다.
- 저장은 기본 활성화입니다. DB 생성 실패는 실시간 서버를 중단하지 않습니다. 최초 설치부터 새로 발생한 기록만 저장합니다.
- 송신 준비 시 실험 ID를 고정합니다. 완료 시점의 다른 실험에 결과를 재배정하지 않습니다.

## 설정·운영

프로젝트 루트에서 기존 잠금 파일을 설치하고 서버를 실행합니다.

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.lock.txt
.\.venv\Scripts\python.exe -m pip install --no-deps -e .
$env:EXIT_LINK_CONTROL_TOKEN = & .\.venv\Scripts\python.exe -c "import secrets; print(secrets.token_urlsafe(32))"
$env:EXIT_LINK_ENABLE_EXPERIMENTS = '1'
$env:EXIT_LINK_DATABASE_PATH = Join-Path (Get-Location) 'data\measured\stage5\history.sqlite3'
.\.venv\Scripts\python.exe -m uvicorn exit_link.main:app --host 127.0.0.1 --port 8000 --workers 1 --no-proxy-headers
```

DB 기본 경로는 `EXIT_LINK_STAGE5_ARTIFACT_DIR/history.sqlite3`이며 artifact 기본값은 `data/measured/stage5`입니다.
같은 DB 경로를 유지해야 재시작 후 과거 이력을 읽습니다. `EXIT_LINK_PERSISTENCE_ENABLED=0`은 저장 비활성화입니다.
OS 파일 잠금으로 한 DB에 한 백엔드만 허용합니다. 다중 worker/`--reload`를 사용하지 않습니다.
DB·WAL·SHM·lock·오류 로그·측정 폴더는 기존 Git 제외 규칙에 포함됩니다. 토큰은 DB에 기록하지 않습니다.

WAL, synchronous=FULL, foreign_keys=ON, busy_timeout=150ms, 자동 체크포인트 1,000페이지를 적용합니다.
한 이벤트와 관련 검색용 행은 BEGIN IMMEDIATE 트랜잭션으로 함께 커밋/롤백합니다. 쓰기 락을 잡고 TCP를 기다리지 않습니다.
정상 종료는 큐를 비우고 WAL 체크포인트를 수행합니다. 커밋된 기록은 비정상 종료 후에도 읽을 수 있습니다.
다음 시작에서 미종료 run과 starting/running/stopping 실험, 미완료 제어를 interrupted로 표시합니다.
정확한 종료 시각을 알 수 없는 실험의 ended_at은 NULL이며, interruption_detected_at은 다음 시작 시각입니다.
강제 종료된 run은 recording_complete=false입니다. 이것은 기록 완전성 표시이며 TCP 성공/실패 판정이 아닙니다.

새 DB는 application_id, user_version=1, schema_migrations SHA256을 원자적으로 설정합니다.
다른 앱 DB·알 수 없는 버전·변조된 migration은 거부하며 자동 삭제/덮어쓰지 않습니다.
기존 JSON 파일과 수신 노드 가드는 변경하지 않습니다. 백업은 서버를 정상 종료한 뒤 DB와 원본 로그를 함께 복사합니다.
실행 중인 DB 파일만 복사하면 WAL의 최신 커밋을 누락할 수 있습니다. 네트워크 공유·동기화 폴더는 피합니다.

## 테이블과 관계

| 테이블 | 저장 내용 및 연결 |
|---|---|
| schema_migrations | 버전·체크섬·적용 시각 |
| backend_runs | 실행 ID·환경·시계 해상도·시작/종료·기록 완전성 |
| experiments | run FK, 실험 UUID·조건·실제 포트 포함 가상 토폴로지·상태·시각 |
| scenario_revisions | (scenario_id,revision) PK, 건물 ID·위험 설정 |
| event_log | run/실험 FK, event_id/source_key UNIQUE, 스트림/순번, 발생/저장 시각·원문·장애 감지 ms |
| scenario_snapshots | event/revision FK, 대피 계획·안내·이벤트를 포함한 기존 ScenarioSnapshot |
| guidance_messages | message_id PK, run/실험/revision FK, 송신 전 안내 전체 |
| guidance_deliveries | message_id UNIQUE FK, ACK·지연·재시도·기존 GuidanceDelivery 전체 |
| delivery_attempts | (message_id,attempt_number) PK, 소요/계산 ms·경로·결과 |
| control_actions | run/실험 FK, action_id UNIQUE, 요청/완료·장애 유형·실제 PID/실패 진단 |

위 표의 업무 테이블은 10개이며 SQLite 자동 생성 sqlite_sequence를 포함하면 11개입니다.
시나리오는 실험 간 재사용할 수 있습니다. 메시지·이벤트의 실험 ID는 실험 외 동작에서 NULL일 수 있습니다.
실험 외 기록은 현재 실험별 API에 노출하지 않습니다. 주기적인 network.changed 전체 폴링은 저장하지 않고 상태 전이와
원본 heartbeat_config를 저장합니다. 로그 키는 실험·파일·PID·바이트 오프셋이며, WS 키는 run·stream·sequence입니다.
백엔드를 거치지 않는 독립 CLI 송신과 과거 JSONL은 자동 수집하지 않습니다.
동일 ID/동일 내용은 멱등 처리하고, 다른 내용 또는 다른 실험에 동일 메시지 ID를 재사용하면 롤백·오류로 기록합니다.

## 신규 REST API

모든 경로는 `GET /api/v1/history` 아래입니다. 기존 loopback peer/Host/Origin 제한을 사용합니다.
읽기에는 토큰이 필요 없습니다. 제어·전송 API의 기존 토큰 요구는 유지됩니다.

| 경로 | 응답 타입 | 매개변수 |
|---|---|---|
| /status | StorageStatus | 없음 |
| /experiments | ExperimentPage | limit=50 (1..100), cursor 선택 |
| /experiments/{UUID} | ExperimentHistory | 미존재 404 |
| /experiments/{UUID}/events | ArchiveEventPage | after=0, limit=100 (1..200), event_type 선택 |
| /experiments/{UUID}/deliveries | DeliveryHistoryPage | limit=50 (1..100), cursor 선택 |
| /experiments/{UUID}/controls | ControlHistoryPage | limit=50 (1..100), cursor 선택 |
| /comparison | ComparisonPage | experiment_id 반복 UUID 1..20개 |

목록/전달/제어는 archive_id 내림차순이고 next_cursor를 다음 요청 cursor로 전달합니다.
이벤트는 archive_id 오름차순이고 next_after를 after로 전달합니다. 숫자는 WS sequence와 별개입니다.
event_type은 `network.event`, `scenario.changed`, `guidance.result` 같은 종류 또는 `neighbor_down`, `route_selected` 같은
원본 프로세스 event명으로 필터합니다. 미존재 실험의 하위 목록/비교는 빈 items를 반환합니다.
DB 실패·비활성화 시 빈 성공 응답 대신 503 ApiError(detail.code=storage_unavailable)를 반환합니다.
입력 오류는 기존 422, 접근 거부는 403입니다. 상태 API는 DB 오류 중에도 200으로 진단 정보를 제공합니다.

## 측정 의미

기존 실측 필드만 복사합니다. 측정하지 않은 수치는 NULL입니다. MetricStats는 n/minimum/maximum/mean/median/unit(ms)입니다.

- delivery_latency: 기존 transport_result.elapsed_ms. 송신 호출 전체 지연입니다.
- route_calculation: 기존 route_calculation_ms. 시도별 값은 delivery_attempts와 원문 attempts에도 남습니다.
- delivery_recovery: 같은 메시지의 첫 실패부터 최종 성공까지 기존 recovery_after_first_failure_ms. 새 메시지 성공을 복구 시간으로 만들지 않습니다.
- heartbeat_detection: 첫 Heartbeat 실패부터 down 확정까지 원본 detection_since_first_failure_ms. 실험 running 시각 이후 관측만 집계합니다.
  n은 관측자 표본 수이며 장애 발생 건수가 아닙니다. 여러 관측자가 같은 장애를 보고할 수 있습니다.
- route_changes: 같은 실험/시나리오/audience/출발/목적의 시도 경로를 전달 결과 저장 순서로 비교한 변화 수입니다.
  각 메시지 내부는 시도 순서이며 동시 송신의 전역 시간 순서를 추정하지 않습니다. 물리적 장애 건수와 다릅니다.
- retries_total: 기록된 transport_result의 합. ack_rate는 기록된 전달 결과의 ACK 비율이며 전체 실행 성공률을 추정하지 않습니다.

실험 조건·가상 토폴로지/위험·Dijkstra 경로는 시뮬레이션/계산입니다. TCP·ACK·프로세스 장애 관측은 실제 localhost입니다.
ACK와 application_receipt.disposition을 별도 표시합니다. applied/stale/duplicate/version_conflict/적용 미확인은 다른 상태입니다.
human_evacuation_verified는 계속 false이며 사람의 대피 완료나 실제 화재 안전을 증명하지 않습니다.

## Claude 프론트엔드 연결

생성된 [OpenAPI](contracts/stage5/openapi.json), [TypeScript](contracts/stage5/types.ts)를 사용합니다.
기존 frontend의 `@contracts` 경로는 같은 타입 파일을 가리킵니다. StorageStatus, ExperimentHistory,
ExperimentPage, ArchiveEventPage, ArchivedDelivery, DeliveryHistoryPage, ControlHistoryPage,
ExperimentComparison, ComparisonPage, MetricStats가 추가되었습니다.

1. Analytics의 현재 실험/WS 스토어는 유지하고 별도 이력 데이터 소스를 추가합니다.
2. /history/experiments 목록의 experiment_id로 상세·deliveries·events·controls를 조회합니다. 시각 구간으로 실험을 추정 배정하지 않습니다.
3. 두 실험 비교 예: `/api/v1/history/comparison?experiment_id=<UUID1>&experiment_id=<UUID2>`.
4. 빈 배열은 “기록 없음”, NULL은 “미측정”, 503은 “저장소 조회 불가”로 구별합니다. 0ms는 관측값이므로 숨기지 않습니다.
5. recording_complete=false와 status.failed/dropped를 표시하고 비교 결과가 기록된 표본만의 통계임을 밝힙니다.
6. 기존 WS 6개 이벤트는 그대로입니다. WS 이벤트와 DB 커밋은 비동기이므로 현재 상태와 과거 이력을 섞지 않습니다.
   새 전용 history WebSocket 이벤트는 추가하지 않았습니다. 새로고침/실험 종료 시 이력을 다시 조회합니다.

상태의 pending/failed/dropped는 현재 run 값입니다. 기록 실패는 stderr와 archive-errors-<run>.jsonl에 남깁니다.
큐 초과는 실시간 스레드의 파일 I/O를 피하기 위해 카운트·stderr에만 남기며 불완전 표시를 다음 DB 접근 때 커밋합니다.
DB 접근 자체가 계속 실패하면 그 표시도 저장할 수 없으므로 현재 status와 원본 로그를 함께 확인해야 합니다.
오류 후 state=degraded는 같은 run에서 유지됩니다. 다음 성공을 이유로 과거 누락을 정상 기록으로 바꾸지 않습니다.

## 한계

미커밋 큐의 crash 내구성, 자동 재생/백필, 디스크 용량 관리·보존 기간·압축, 내보내기 UI는 미구현입니다.
정상 종료 drain은 제한 시간 내 최선의 처리이며 전원 손실/강제 종료 전 큐 전체 저장을 보장하지 않습니다.
기록 오류가 한 번 발생한 run은 해당 run의 모든 실험 통계를 보수적으로 불완전 처리합니다.
스키마 v1만 지원하며 후속 변경은 새 migration으로 추가해야 합니다. SQLite 파일은 암호화하지 않습니다.
이번 작업에서 5개 페이지 디자인 및 TCP 라우팅/타이밍 알고리즘은 변경하지 않았습니다.
