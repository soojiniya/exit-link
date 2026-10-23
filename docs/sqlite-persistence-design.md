# 실험 영구 저장 설계안 — 구현 전 검토 이력

이하 내용은 최초 설계 당시 기록입니다. 사용자 구현 요청에 따라 SQLite 저장을 추가했습니다.
최종 동작·설계 차이·API는 [구현 가이드](sqlite-persistence-guide.md), 실행 증거는
[검증 보고서](sqlite-persistence-report.md)를 기준으로 합니다. 이하의 “미구현”은 최초 작성 시점 설명입니다.

2026-10-21. DB 생성·스키마 마이그레이션·기존 API 변경을 실행하지 않았습니다.
이 문서의 필드와 후속 API는 검토안입니다. 기존 프로세스 제어 권한을 DB의 PID로 복원하지 않습니다.

## 현재 상태와 권장 방향

Backend.sessions, deliveries(최근 512개), EventBus.history(최근 512개)는 메모리입니다.
API 소유 실험은 UUID 디렉터리의 communication.json, JSONL 원본 로그, evidence.json을 남깁니다.
GuidanceInbox의 최신 버전 가드는 별도 JSON 파일에 영속 저장하지만 중앙 실험 이력 DB는 아닙니다.
프론트엔드의 labLog는 브라우저 요청 기록이며 서버 재시작 후 복구할 수 있는 실험 원장이 아닙니다.
현재 Analytics는 experiment.changed 발행 시각 구간으로 결과를 추정 배정하므로 경계에서 완료된 송신을 정확히 귀속할 수 없습니다.

SQLite를 중앙 기록 저장소로 추가하고, JSON 원문과 검색용 정규화 필드를 함께 저장하는 방안을 권장합니다.
기존 DTO·REST 경로·WebSocket 프레임은 유지하며 저장 계층을 내부에 둡니다.
현재 단일 worker를 유지하고 한 개의 DB writer가 트랜잭션을 직렬 처리합니다.
TCP 노드 6개가 각자 중앙 DB에 쓰지 않도록 합니다. 노드는 기존 JSONL/수신 가드를 유지합니다.
권장 위치는 Git 제외 대상 `data/measured/exit-link.sqlite3`입니다.

현재 Python 3.12.10의 SQLite는 **3.49.1**로 확인했습니다.
SQLite 공식 문서는 3.51.3 이상 또는 특정 백포트에서 수정한 WAL-reset 문제를 설명합니다.
따라서 현재 런타임에서 다중 연결 WAL을 바로 활성화하지 않습니다. 초기안은 DELETE journal + FULL 동기화이며,
WAL 도입은 패치된 SQLite 런타임 확인과 동시 읽기/쓰기·체크포인트 시험을 승인 조건으로 둡니다.
[SQLite WAL 공식 문서](https://www.sqlite.org/wal.html#the_wal_reset_bug)

## 저장 구조 초안

모든 ID는 TEXT UUID, UTC 시각은 TEXT ISO 8601, boolean은 CHECK(value IN (0,1)), JSON은 json_valid CHECK를 사용합니다.
실제 성능 관측은 REAL ms 또는 INTEGER ns + clock domain을 저장합니다. 미관측 값은 NULL이며 0으로 대체하지 않습니다.
아래 각 행은 테이블 초안이며 API JSON을 그 형태로 변경한다는 뜻이 아닙니다.

| 테이블 | 주요 열·키 | 목적 |
|---|---|---|
| schema_migrations | version PK, checksum, applied_at_utc | 순서·무결성을 확인하는 DB 버전 |
| backend_runs | run_id PK, started_at_utc, ended_at_utc NULL, end_reason, environment_json | OS/Python/SQLite/코드 버전, 시계 종류·해상도, 같은 실행의 clock_domain_id |
| experiments | experiment_id PK, run_id FK, created/start/end 시각, status, conditions_json, topology_json, topology_hash, topology_origin | 실행 조건과 당시 실제 loopback 포트까지 포함한 가상 토폴로지 스냅샷 |
| scenarios | scenario_id PK, building_id, building_hash, created_at_utc, origin=simulation | 시나리오의 안정된 ID와 건물 버전 |
| scenario_revisions | (scenario_id,revision) PK/FK, changed_at_utc, hazards_json, snapshot_json | 위험 구역·차단 통로의 전체 교체 이력과 복원 가능한 ScenarioSnapshot |
| evacuation_plans | (scenario_id,start_location,route_version) PK, scenario_revision FK, status, path_json, exit_id NULL, distance_m_assumed NULL, calculated_at_utc | no_route를 포함한 가상 대피 계산 원문 |
| control_actions | action_id PK, experiment_id FK, run_id FK, requested/completed 시각, node_id NULL, action, outcome, error_json NULL, evidence_json | 시작·종료·장애 주입·복구 요청과 실제 성공/실패, 이전/새 PID, 포트 진단 |
| fault_observations | observation_id PK, experiment_id FK, event_ref FK, observer_node, target_node, state, detection_ms NULL | 각 관측 노드의 suspect/down/recovered 원문과 감지 시간 |
| guidance_messages | message_id PK, scenario_id/revision FK, route_version, audience_id, source,destination, issued_at_utc, experiment_id NULL, guidance_json | 송신 준비 시점에 실험 ID를 확정, 동일 ID의 내용 충돌 거부 |
| guidance_deliveries | message_id PK/FK, observed_at_utc, ack_received, success NULL, transport_error NULL, retries NULL, elapsed_ms NULL, receipt_disposition NULL, receipt_query_error NULL, final_route_json NULL, delivery_json | transport 성공과 안내 적용 상태를 별도로 보존 |
| delivery_attempts | (message_id,attempt_number) PK/FK, started_at_utc, duration_ms, route_calculation_ms, route_json, outcome, ttl_remaining NULL | 실제 시도·실패·재시도·선택 경로 |
| event_log | db_event_id INTEGER PK, run_id FK, stream_id, stream_sequence, experiment_id NULL, source, source_event_key UNIQUE, occurred_at_utc, ingested_at_utc, event_type, payload_json, provenance_json | 발행 순서와 원본 사건 시각을 분리, 정확한 원문·증거 연결 |
| metric_observations | metric_id PK, experiment_id/message_id/event_ref FK, name, value NULL, unit, method, baseline, clock_domain_id NULL, evidence_refs_json | 감지·계산·전달 복구 등 측정 기준과 측정/파생/시뮬레이션 구분 |
| imports | import_id PK, source_hash UNIQUE, source_path, imported_at_utc, validation_status | 기존 JSONL/evidence를 중복 없이 명시적으로 가져온 이력 |

시나리오는 여러 실험에서 재사용될 수 있으므로 scenarios에 하나의 experiment_id를 강제하지 않습니다.
메시지는 준비 시점의 현재 실험 ID를 내부적으로 고정하고, 비동기 송신 완료 시점의 활성 실험으로 다시 배정하지 않습니다.
실험 외 수동 CLI 노드 전송은 experiment_id=NULL과 execution_context=project_manual로 기록합니다.
필요하면 experiment_scenarios(experiment_id,scenario_id) 연결 테이블을 추가합니다.

주요 인덱스는 experiments(started_at_utc,experiment_id), event_log(experiment_id,db_event_id),
guidance_deliveries(observed_at_utc,message_id), fault_observations(experiment_id,target_node,observer_node)입니다.
대용량 원본 로그는 파일 보존 + SHA256/offset 참조를 병행하고 DB에 무제한 중복 저장하지 않습니다.

## 데이터 출처와 판정 기준

출처는 단일 simulation/real 필드로 합치지 않고 다음 축을 구분합니다.

- topology_origin=simulation, disaster_origin=simulation: 가상 건물·네트워크·위험 조건
- observation_origin=real_process / real_tcp_observation / real_process_control: 실제 관측·제어
- calculation_origin=computation: Dijkstra 경로 및 계산 결과
- metric_kind=measured / derived / simulation: 직접 계측, 관측에서 계산한 값, 가상 비용

ACK 수신은 전달 확인이며 사람의 대피 완료가 아닙니다. human_evacuation_verified=false를 유지합니다.
applied/stale/duplicate/version_conflict/publisher_conflict/적용 미확인은 별개로 보관합니다.
응답 타임아웃은 목적지에 도달하지 않았다는 증거가 아니므로, ACK 미수신과 확정 미전달을 혼동하지 않습니다.
실험 시작 중 아직 기동하지 않은 노드에 대한 neighbor_down은 초기 수렴 구간이며 장애 주입 결과와 분리합니다.
동일 장애를 N1/N4가 각각 보고한 경우를 독립 장애 2건으로 합산하지 않습니다. 원문 관측 2건과 장애 episode 1건을 구별합니다.

원본 JSONL의 idempotency key는 (experiment_id,process_incarnation,log_file,byte_offset)로 만듭니다.
WebSocket 이벤트에는 (run_id,stream_id,sequence) UNIQUE를 둡니다. 재발행과 원본 로그의 중복은 source_event_key로 구분합니다.
PID만으로 프로세스 재시작·이벤트 중복·현재 소유권을 판정하지 않습니다.

## 측정 정의

| 지표 | 기준점·단위 | 불충분한 증거의 처리 |
|---|---|---|
| 장애 감지 | 같은 관측 노드의 첫 Heartbeat 실패 → down 확정, ms | 로그 측정값이 없으면 NULL |
| 주입부터 감지 | 실제 kill 요청 또는 종료 확인 → 특정 관측자의 down, ms | 기준점 종류를 별도 열에 기록, 서로 혼합 금지 |
| 경로 계산 | 기존 route_calculation_ms, 시도별/전체를 구별 | 계산하지 않았으면 NULL, no_route 계산도 별도 결과 |
| 전달 복구 | 같은 message_id 첫 실패 → 최종 ACK, ms | ACK 없으면 NULL/미복구; 다음 새 메시지 성공과 구별 |
| 재시작 복구 | 이전 running 증거 + node_started → 첫 up/recovered, ms | 처음 시작한 노드 또는 이전 기록이 없으면 재시작 성공 표본으로 만들지 않음 |
| 경로 전환 | 시도/직전 메시지 경로와 최종 ACK 경로 비교 | 출발·목적·실험·시나리오가 다른 결과를 임의 비교하지 않음 |
| 전송 지연 | 기존 elapsed_ms와 시도별 duration_ms | 측정 시계·해상도를 함께 보관 |

현재 Windows Python의 monotonic은 GetTickCount64, 해상도 15.625ms로 확인됐습니다.
실제 UI 송신 관측에 elapsed_ms=0과 약 16ms가 있습니다. 0은 현재 시계의 양자화된 측정값이며 지연이 없다는 뜻이 아닙니다.
perf_counter는 QueryPerformanceCounter(해상도 100ns)로 확인했습니다.
후속 계측 개선은 별도 measurement_method 버전으로 도입하고, 기존 수치를 소급해서 고해상도 측정처럼 바꾸지 않습니다.
UTC 사건 시각 차이는 파생값이며 같은 clock_domain의 단조 시계 계측과 구별합니다.
서버 재시작·호스트 재부팅을 넘나드는 monotonic_ns를 빼서 복구 시간을 만들지 않습니다.

## 기록과 트랜잭션

1. 제어/송신 의도를 먼저 커밋합니다. TCP I/O를 기다리는 동안 DB 트랜잭션을 잡지 않습니다.
2. 실제 작업 결과와 관련 이벤트·검색용 행을 한 트랜잭션으로 기록합니다.
3. 영속 결과 커밋 후 기존 WebSocket 이벤트를 발행합니다. 별도 outbox의 미발행 표시는 같은 트랜잭션으로 기록합니다.
4. 강제 종료로 의도만 남은 작업은 pending/unknown으로 유지하고 실제 로그로 조정합니다. 성공으로 채우지 않습니다.
5. 쓰기 큐는 유한 크기, 단일 writer 연결, foreign_keys=ON, 파라미터 바인딩, busy_timeout·재시도 상한을 둡니다.
6. 디스크 부족/쓰기 실패를 성공 처리하지 않습니다. 이미 일어난 TCP 동작은 DB rollback으로 취소할 수 없으므로 known message_id와 상태 미확인을 구분합니다.

WAL을 쓰더라도 동시 writer는 하나입니다. 로컬 디스크만 사용하고 네트워크 공유/클라우드 동기화 폴더는 피합니다.
[SQLite 트랜잭션 공식 문서](https://www.sqlite.org/lang_transaction.html)

## API·WebSocket 호환성 초안

- 기존 `/api/v1` 응답 모델과 stage5 OpenAPI/TS 타입의 필수 필드를 변경하지 않습니다.
- 기존 `/events`는 현재 stream_id의 최근 512개 실시간 복구용으로 유지합니다. DB 전역 번호를 sequence에 대입하지 않습니다.
- 서버 재시작 시 stream_id는 새 UUID이며 sequence는 새 스트림 기준입니다. 이전 running/healthy 관측을 현재 상태로 복원하지 않습니다.
- 기존 소유 실험은 interrupted로 보관하고 자동 프로세스 재실행/DB PID 종료를 하지 않습니다.
- 이력 조회는 승인 후 별도 `/api/v1/history/experiments`, `/{id}/deliveries`, `/{id}/events`, `/{id}/metrics` 등 페이지네이션 API로 추가하는 방안을 권장합니다.
- 원문 DTO를 그대로 delivery_json/snapshot_json에 보관하므로 기존 화면에는 현재 DTO로 투영할 수 있습니다.
- 영구 저장과 실시간 캐시는 분리합니다. 재시작 후 과거 시나리오/전송 결과를 기존 조회에 복원할지, 별도 이력 조회로만 보일지는 도입 승인 시 결정합니다.
  초기 권장안은 현재 화면 의미를 유지하는 별도 이력 조회이며, 자동 복원은 별도 설정과 건물 hash/스냅샷 검증을 거칩니다.
- 저장 오류가 추가되면 기존 ApiError 형태의 storage_unavailable 코드와 503을 문서화합니다. 이는 승인 후 타입 재생성과 함께 추가합니다.

## 마이그레이션·검증 계획

1. 현재 API/WS 계약, 실제 로그와 빌드 버전을 고정하고 읽기 가능한 백업을 생성합니다.
2. 임시 DB에서 migration v1, FK/UNIQUE/CHECK, 무결성·롤백 시험을 실행합니다. schema_migrations와 PRAGMA user_version을 일치시킵니다.
3. 저장 기능을 기본 비활성화한 설정 뒤에 추가하고, 기존 187개 회귀 테스트·프론트엔드 verify를 유지합니다.
4. 단일 writer의 원자성, 디스크 부족, SQLITE_BUSY, 중복 이벤트, 요청 중 강제 종료, 재시작 후 unknown 상태를 시험합니다.
5. 기존 data/measured의 정상 evidence/GuidanceDelivery/로그를 명시적 CLI로 검증·가져옵니다. 허용 루트 아래의 파일만 처리하며 *.local 토큰은 수집하지 않습니다.
6. backfill은 source_hash로 멱등 처리합니다. 원문에 없는 실험 ID·측정값·ACK·시각은 추정하지 않고 NULL/unknown으로 둡니다.
7. 과거 이벤트로 실시간 stream_id/sequence를 이어붙이지 않습니다. 이력 API에서 별도 조회합니다.
8. DB writer 장애 시 원본 JSONL은 보존합니다. rollback은 DB 백업과 기능 플래그로 수행하고 기존 JSON 수신 가드와 로그를 삭제하지 않습니다.
9. WAL 도입 시 패치 버전, 체크포인트/백업 복원, WAL 동반 파일 보존, 장시간 읽기와 쓰기 충돌을 별도로 검증합니다.

승인 대상은 저장 경로·보관 정책, journal 모드/런타임 업데이트, 자동 복원 범위, 신규 이력 API, 저장 실패 처리 정책입니다.
이 설계안만으로 저장 기능이 구현되거나 서버 재시작 후 데이터가 보존된다고 보고하지 않습니다.
