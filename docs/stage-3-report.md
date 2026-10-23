# EXIT-LINK 3단계 구현 및 검증 보고

작성일: 2026-10-20 (Asia/Seoul)

**3단계 코드와 테스트·실험 실행기를 구현했습니다. 현재 전체 95개 통과와 실제 TCP 장애 복구 성공은 미검증입니다.**
기존 로컬 64개 통과 원문을 확인했으며 기존 테스트의 조건은 수정하지 않았습니다.
현재 Codex는 localhost connect를 WinError 10013으로 거부합니다.

## 기존 분석 및 호환성

기존 protocol/node/client/CLI, 통신·건물 JSON, 그래프 생성기, 테스트, 단계별 보고서와
`data/measured/stage2-20261020T124128Z-83cdb99a/pytest-results.txt`를 확인했습니다.
해당 로컬 기록은 `64 passed in 10.89s`이며 사용자 최종 결과와 일치합니다.
이것은 변경 전 버전의 결과이고 변경 후 재통과를 대신하지 않습니다.

기존 구조는 출발 노드 TCP 요청 → 명시 경로의 노드별 TCP 연결 → 목적지 ACK → 연결 사슬을 통한 반환입니다.
이 동작과 Message/Ack/ErrorResponse 필드는 유지했습니다.
기존 노드 명령은 기본적으로 명시 모드이며 자동 재시도를 하지 않으므로 기존 실패 처리 테스트 의미도 유지됩니다.
3단계는 node --resilient와 send --auto-route로 활성화합니다.
자동 전송에는 별도 reliable_send/delivery_result 제어 타입을 사용합니다.
구버전 프로그램이 새 제어 타입을 처리할 수 있다는 wire 호환성 보장은 하지 않습니다.

## 새로 생성한 파일

| 파일 | 책임 |
|---|---|
| `src/exit_link/fault_detection/models.py` | 버전/생성 시각이 있는 링크 상태 광고 |
| `src/exit_link/fault_detection/state.py` | 실패/복구 상태 머신, 신선도·재생 방지 저장소 |
| `src/exit_link/fault_detection/heartbeat.py` | 이웃별 동시 Heartbeat와 분산 상태 공유 |
| `src/exit_link/routing/communication.py` | 신선한 양방향 링크만 남긴 통신 그래프·경로 선택 |
| `src/exit_link/communication/reliable.py` | 출발 노드의 제한된 재시도/TTL 예산/결과 관측 |
| `src/exit_link/simulation/processes.py` | 실제 6개 프로세스 시작·종료·강제 종료·원문 보관 |
| `src/exit_link/simulation/experiment.py` | 특정 메시지 처리 중 실제 중계 종료 및 복구 실험 |
| `src/exit_link/metrics/recording.py` | 실제 제공된 관측의 JSON 저장 |
| `scripts/verify_stage3.py` | localhost 사전 검사 후 전체 pytest 및 evidence 저장 |
| `scripts/experiment_stage3.py` | 독립 실행 가능한 장애/복구/무경로 실험 |
| `tests/test_stage3_state.py` | 24개 순수 상태/그래프/설정 테스트 |
| `tests/test_stage3_tcp.py` | 7개 실제 TCP·프로세스 장애 테스트 |
| `docs/stage-3-guide.md` | 상세 동작, 실행, 측정 기준, 한계 |
| `docs/stage-3-report.md` | 이 보고서 |
| `docs/stage-3-static-results.txt` | 실제 선별 pytest 출력 |
| `docs/stage-3-collection.txt` | 전체 95개 수집 출력 |
| `docs/stage-3-verification-attempt.txt` | 전체 검증 사전 차단 기록 |
| `docs/stage-3-experiment-attempt.txt` | 실험 사전 차단 기록 |

## 수정한 파일

| 파일 | 변경 |
|---|---|
| `src/exit_link/communication/protocol.py` | Heartbeat·상태 조회·자동 전송 제어 타입과 결과 스키마 추가 |
| `src/exit_link/communication/node.py` | 선택적 Heartbeat 수명주기, 제어 타입 분기, 논리 메시지 중복 판정, 실험용 처리 대기, monotonic 로그 |
| `src/exit_link/communication/client.py` | 상태 조회/자동 전송 API 및 ACK 상관관계 검사 |
| `src/exit_link/communication/__main__.py` | resilient/config/status/auto-route CLI |
| communication/fault_detection/routing/simulation/metrics의 `__init__.py` | 현재 모듈 책임 설명 |
| `README.md` | 현재 검증 상태와 3단계 진입 명령 |
| `data/measured/README.md` | 실제 관측과 사전 차단/검증 임시 파일의 구분 |

기존 64개 테스트 파일, 두 JSON, FastAPI/health, topology, 의존성, 잠금 파일은 최종적으로 변경하지 않았습니다.
Heartbeat/재시도가 없는 기존 모드를 유지했고, 목적지 중복 캐시는 경로 변경을 허용하도록 내용 비교에서 route/hop/TTL을 제외했습니다.
동일 ID에 본문/목적지/시각이 달라지면 여전히 충돌로 거부합니다.
작업 파일은 모두 기존 프로젝트 안에 생성했으며 커밋/외부 업로드는 하지 않았습니다.

## 동작 원리

각 노드가 정적 이웃을 주기적으로 탐색합니다. 첫 실패는 suspect, 연속 실패 기준 충족 시 down입니다.
down 복구는 설정한 연속 성공이 필요합니다. 일시 성공 후 실패하면 down을 유지합니다.
상태 변경은 구조화된 이벤트로 기록합니다.

Heartbeat에 origin/epoch/sequence/generated_at/이웃 상태를 실어 이웃 간에 공유합니다.
높은 버전과 신선한 정보만 수용하고, 같은 패킷을 받아 만료 시각을 늘리지 않습니다.
만료 후 watermark도 유지합니다. 재시작의 새 epoch는 이전 프로세스 광고와 구분됩니다.
중앙 서버는 필요하지 않습니다. source의 상태가 불완전하면 성공을 추측하지 않고 no_route로 실패할 수 있습니다.

자동 송신은 최신 상태에서 양방향 모두 up인 링크만 사용합니다.
출발 노드가 NetworkX 경로를 선택하며, 실패 홉의 연결을 현재 메시지의 제외 집합에 넣고 재계산합니다.
중계 노드가 따로 재시도하지 않아 재시도 수가 계층마다 곱해지지 않습니다.
이전 실패 연결의 제외는 시도 동안 유지하고, 경로 중복 노드·시도 수·TTL 예산을 함께 제한합니다.
복구 경로가 없으면 no_route, 한도 소진은 retry_exhausted, 예산 부족은 ttl_expired입니다.

총 TTL 예산은 시도 전에 전체 예정 경로 길이를 예약 차감하는 보수적인 정책입니다.
연결 전에 실패했어도 예약분을 돌려주지 않습니다. 실제 네트워크 홉 측정값과 구별해야 합니다.
메시지 ID/본문/시각을 유지하므로 ACK 유실 후 다른 경로로 재전송돼도 중복 수신을 억제합니다.
duplicate ACK의 경로는 확인 요청의 경로이고 최초 실제 본문 수신 경로는 목적지 received 로그가 기준입니다.

연결 수립 실패/기한 만료와 연결 후 I/O 만료의 구분을 유지했습니다.
전송 실패는 즉시 임시 연결 제외로 이어질 수 있고, Heartbeat의 down 확정과는 별개입니다.
실험에서는 진행 중 메시지의 재전송과, down 확정 이후 별도 새 전송을 각각 검사합니다.

## 실제 실행한 검증

| 항목 | 결과 |
|---|---|
| 변경 전 로컬 2단계 원문 | 64 passed, 사용자 결과와 일치 |
| 변경 후 소켓 불필요 선별 실행 | **55 passed, 5 deselected in 1.05s** |
| 선별 구성 | 기존 토폴로지 23 + 기존 메시지 스키마 8 + 새 상태/그래프 24 |
| 전체 수집 | 95 tests collected = 기존 64 + 신규 31 |
| compileall | 종료 코드 0 |
| pip check | No broken requirements found. |
| 변경 후 전체 pytest | 사전 검사에서 10013, 실행되지 않음, 종료 코드 2 |
| 실제 장애 실험 | 사전 검사에서 10013, 시작하지 않음, 종료 코드 2 |

현재 실행 완료하지 못한 테스트는 총 40개입니다: 기존 HTTP 2개, 프레이밍 5개, 기존 TCP 통합 26개, 신규 TCP 7개.
선별 명령의 5 deselected는 프레이밍 검사만 뜻하며 전체 미검증 개수와 다릅니다.
pytest 시간은 통신 성능 수치가 아닙니다. 전체 95개 통과나 실제 우회 성공을 보고하지 않습니다.

원문 및 사전 검사 JSON:

- `data/measured/stage3-tests-20261020T125457Z-19816ba8/summary.json`: pytest_started=false, pytest_exit_code=null
- `data/measured/stage3-experiment-20261020T125457Z-fb098021/summary.json`: experiment_started=false

이 실행들에는 장애 성능값·가상 성공 메시지를 작성하지 않았습니다.
순수 그래프 테스트는 가짜 시계를 사용한 규칙 검증이며 실제 TCP 관측과 명확히 분리됩니다.

## 로컬 PowerShell 검증

```powershell
Set-Location 'C:\Users\User\Documents\Codex\2026-10-20\exit-link-fastapi-python-tcp-socket\outputs\exit-link'
.\.venv\Scripts\python.exe .\scripts\diagnose_tcp.py
.\.venv\Scripts\python.exe .\scripts\verify_stage3.py
$LASTEXITCODE
.\.venv\Scripts\python.exe .\scripts\experiment_stage3.py
$LASTEXITCODE
```

전체 검증의 기대 조건은 **95 passed**, pytest_exit_code=0, status=passed입니다.
실험은 실제 baseline/ACK, 진행 중 N2 강제 종료, 대체 경로 재전송, 감지 후 새 전송,
N2 재시작/상태 전파, N2→N3 연속 장애의 no_route를 검사하며 실패 시 비제로로 끝납니다.
각 실행의 고유 폴더에 PID/원문/evidence/결과를 저장하고 이전 결과를 덮어쓰지 않습니다.
프로세스 정리 실패나 주입하지 않은 비정상 종료도 실패입니다.
수동 노드/메시지/상태 명령은 stage-3-guide.md에 있습니다.

## 측정 가능한 지표

실제 실행에 성공한 경우에만 아래 관측이 생성됩니다. 상세 필드명과 기준은 가이드 표를 참고합니다.

- 강제 종료 요청→제어 프로세스가 down 관측: ms, polling 지연 포함 상한 관측
- 첫 실패 응답 관측→down 확정: ms, 감지 노드 안의 monotonic 차이
- 경로 계산: ms, source의 perf_counter로 시도별/누적 측정
- 강제 종료 요청→진행 중 메시지의 ACK 관측: ms, 실패하면 null
- source의 첫 실패 반환→재시도 ACK: ms
- 재시작 요청→정상 링크 상태 수렴 관측: ms
- 실제 성공 여부, 실제 재시도 수, 각 시도의 경로/결과/기간, 변경 전후 경로

실험 조건에는 임시 포트/프로세스 명령, Heartbeat 설정, TTL/시도 한도,
실제 중계 처리 대기 입력(relay-delay=0.35초), origin/transport 구분을 기록합니다.
설정한 대기값을 측정한 전송 지연으로 취급하지 않습니다.

## 알려진 한계 및 4단계 준비

- 현재 환경에서는 TCP 회귀가 미검증이므로 로컬 전체 테스트/실험 결과를 먼저 확인해야 합니다.
- 신뢰하는 localhost 환경용으로 인증/TLS/악의적 상태 광고 방어는 없습니다.
- 상태는 eventual consistency이며, 분할/과부하/노드 정지를 완벽히 구분하는 합의 시스템은 아닙니다.
- epoch/신선도는 단일 호스트 시계를 전제로 합니다. 큰 시계 역행과 다중 호스트 시간 오차를 해결하지 않았습니다.
- 중복 기록·광고·재전송 상태는 메모리이며 재시작 후 영속적으로 유지하지 않습니다.
- 지수 backoff/혼잡 제어, 대규모 gossip 최적화, SQLite 저장, FastAPI/WebSocket 상태 API는 후속 작업입니다.
- React/3D 및 건물 대피 알고리즘은 구현하지 않았습니다.

4단계는 별도 건물 이동 그래프를 사용하는 대피 경로 모듈을 추가하면 됩니다.
통신의 도달 가능성과 사람의 대피 가능성을 같은 그래프로 합치지 않아야 합니다.
로컬 검증 완료 후 실제 로그/관측을 기준으로 3단계 한도를 정리하고,
건물 간선의 통행 가능 상태와 대피 경로 입력/출력 스키마를 별도로 설계하는 것이 다음 작업입니다.
