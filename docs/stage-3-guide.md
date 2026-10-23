# 3단계: 분산 장애 감지와 자동 통신 경로 전환

이 문서는 구현 동작과 로컬 실행법입니다. **현재 Codex에서 실제 TCP 검증은 10013으로 차단됐습니다.**
예시 경로와 설정값은 기대 동작/실험 입력이지 관측된 성공 결과나 성능 수치가 아닙니다.

## 실행

프로젝트 루트에서 서로 다른 PowerShell 터미널 6개에 하나씩 실행합니다.

```powershell
.\.venv\Scripts\python.exe -m exit_link.communication node --id N1 --resilient
.\.venv\Scripts\python.exe -m exit_link.communication node --id N2 --resilient
.\.venv\Scripts\python.exe -m exit_link.communication node --id N3 --resilient
.\.venv\Scripts\python.exe -m exit_link.communication node --id N4 --resilient
.\.venv\Scripts\python.exe -m exit_link.communication node --id N5 --resilient
.\.venv\Scripts\python.exe -m exit_link.communication node --id N6 --resilient
```

추가 터미널:

```powershell
.\.venv\Scripts\python.exe -m exit_link.communication status --id N1
.\.venv\Scripts\python.exe -m exit_link.communication send --source N1 --destination N4 --auto-route --payload '긴급 안내' --ttl 16 --max-retries 3
# 상태가 허용하면 첫 시도에 선호할 경로를 지정할 수 있습니다.
.\.venv\Scripts\python.exe -m exit_link.communication send --source N1 --destination N4 --auto-route --route 'N1,N2,N4' --payload '우회 확인' --ttl 16 --max-retries 3
```

처음에는 상태가 unknown이므로 경로가 없을 수 있습니다. status에서 광고 6개와 정상 링크 up을 확인한 뒤 전송합니다.
송신 성공은 delivery_result.success=true, 상관관계가 일치하는 ACK 및 종료 코드 0으로 확인합니다.
실패는 success=false와 명시적인 error입니다. no_route를 복구 성공으로 취급하지 않습니다.
--resilient를 생략한 노드는 기존 2단계 모드이며, 기존 --route 전송은 자동 우회하지 않습니다.

원본 토폴로지/포트는 그대로입니다. 모든 통신은 127.0.0.1에 한정합니다.
종료는 Ctrl+C 또는 기존 stop --id 명령을 사용합니다.

## Heartbeat와 상태 전이

각 노드가 **인접 노드에만** 주기적으로 요청/응답을 보냅니다. probe_id, 출발/목적지를 대조합니다.
기본 설정:

| 옵션 | 기본값 | 의미 |
|---|---:|---|
| --heartbeat-interval | 0.5초 | 모든 인접 노드 탐색 라운드가 끝난 뒤 대기 |
| --heartbeat-timeout | 0.4초 | 개별 연결/프레임 I/O 제한 |
| --failure-threshold | 3 | down 확정에 필요한 연속 실패 |
| --recovery-threshold | 2 | down에서 up 복구에 필요한 연속 성공 |
| --state-ttl | 6초 | 생성 시각 기준 링크 광고 유효 수명 |

초기 unknown → 정상 응답 up → 실패 suspect → 연속 실패 down으로 전이합니다.
suspect에서 성공하면 up으로 돌아가고, down에서는 연속 성공 기준을 채워야 복구됩니다.
복구 성공이 끊기면 down을 유지합니다. 단순한 한 번의 지연을 즉시 확정 장애로 취급하지 않습니다.
타임아웃은 개별 작업 기준이므로 설정 interval 자체가 탐지 시간 보장은 아닙니다.
이웃별 탐색은 동시 실행합니다. 다음 라운드는 느린 탐색 종료 및 interval 이후 시작합니다.

neighbor_suspect, neighbor_down, neighbor_recovered/neighbor_up 로그에는 실패/성공 횟수와 원인을 기록합니다.
down 확정 시 첫 실패 응답 관측부터의 실제 경과 ms도 기록합니다. 물리적 고장 시점부터의 시간과 구분합니다.
실패는 현재 인접 연결에서의 관측이며 전원 고장과 네트워크 분할을 완벽히 구분하는 판정이 아닙니다.

## 중앙 서버 없는 상태 공유

Heartbeat 요청과 응답에 광고를 함께 실어 이웃을 통해 확산합니다. 별도 중앙 라우팅 서버는 없습니다.
광고 한 개에는 origin, epoch, sequence, generated_at, 해당 origin의 모든 정적 이웃 링크 상태가 있습니다.

- origin별 소유 노드만 자기 상태를 작성합니다. 외부에서 받은 자기 origin 광고는 무시합니다.
- epoch는 프로세스 시작의 time.time_ns, sequence는 해당 프로세스 안에서 증가합니다.
- 높은 (epoch, sequence)만 받아 재시작 후 새 상태와 오래된 패킷을 구분합니다.
- origin/정적 이웃 목록을 검증하고 미래 1초 초과 또는 state_ttl 이상 오래된 광고는 거부합니다.
- 수신자는 생성 시각의 남은 수명만 보존합니다. 같은 버전 재수신은 만료 시각을 늘리지 않습니다.
- 만료 후에도 버전 watermark를 보관해 오래된 광고의 재생으로 상태가 부활하지 않게 합니다.
- 변화가 없어도 각 라운드에 새 sequence를 발행해 살아 있는 origin의 상태를 갱신합니다.
- 6개 origin만 저장·전달하며 광고 목록도 6개로 제한합니다.

상태는 즉시 일치하지 않는 eventual consistency입니다. 상태 복구도 여러 이웃을 거쳐 전파됩니다.
경로는 origin 광고가 신선하고 양 끝이 모두 up이라고 보고한 링크만 사용합니다.
unknown/suspect/down, 한쪽만 up인 링크, 만료된 origin, 단절된 원격 노드를 경로에서 제외합니다.
하나의 연결 장애만으로 다른 정상 연결까지 가진 노드를 전역 장애로 단정하지 않습니다.
통신 그래프 사본만 수정하며 건물 이동 그래프는 사용하지 않습니다.

## 자동 경로, ACK와 재전송

기존 Message/Ack/ErrorResponse 필드는 유지하고 reliable_send/delivery_result 등 별도 제어 타입을 추가했습니다.
출발 노드만 NetworkX로 경로를 계산하고 재시도합니다. 중계 노드는 기존 명시 경로 전달만 수행합니다.
새 제어 메시지는 업그레이드된 클라이언트/노드용이며 구버전 프로그램이 이를 이해한다고 가정하지 않습니다.

1. 최신 링크 상태로 경로를 선택하고 기존 Message로 전송합니다.
2. ACK를 받으면 ID·출발/목적지·해당 시도 경로를 대조해 성공을 확정합니다.
3. connection_failed, timeout, invalid_response(중간 종료로 인한 EOF 포함)면 실패를 보고한 홉의 다음 연결을 제외합니다.
4. 새 상태와 현재 메시지의 제외 연결 집합으로 다시 계산합니다. 제외 집합은 재시도 동안 줄이지 않습니다.
5. 경로가 없으면 no_route, 시도 한도를 다 쓰면 retry_exhausted, 예산이 부족하면 ttl_expired를 반환합니다.

max_retries는 0~6, 기본 3입니다. 전체 시도 수는 max_retries+1 이하입니다.
TTL은 0~64, 기본 16이며 각 홉에서 감소합니다. 추가로 출발 노드는 **매 시도 전에 전체 예정 경로의 홉 수를 예약 차감**합니다.
실제 전송 전에 실패했어도 예약분을 돌려주지 않는 보수적인 총 예산이므로 실제 네트워크 홉 수와 같은 측정 지표가 아닙니다.
경로에 중복 노드를 허용하지 않고 시도 수·예산·제외 집합을 함께 제한해 무한 중계/재시도를 막습니다.

연결 수립 실패/연결 기한 만료는 connection_failed/phase=connect,
수립 후 I/O 만료는 timeout/phase=io로 구분합니다. ACK를 잃은 경우 실제 전달 여부는 불명확할 수 있습니다.
해당 전송의 임시 연결 제외는 Heartbeat의 확정 down을 기다리지 않으므로 빠른 실패 대응이 가능합니다.
Heartbeat가 down으로 확인한 뒤의 새 전송은 공유된 상태 자체로 우회합니다.

중복 판정은 source+message_id를 키로, source/destination/timestamp/payload를 내용으로 비교합니다.
경로·홉·TTL은 달라도 같은 논리 메시지이면 다시 수신 처리하지 않습니다. 본문 등이 달라지면 충돌입니다.
ACK를 이미 확인한 노드는 duplicate=true ACK를 반환할 수 있습니다. 이때 ACK 경로는 이번 확인 요청의 경로이며,
최초 본문 전달 경로는 목적지의 received 로그가 기준입니다. 재전송 경로 필드를 실제 최초 수신 경로로 혼동하지 않습니다.
기존 300초/10000개 메모리 캐시 한계와 재시작 시 중복 기록 소실은 유지됩니다.

## 실제 장애 실험 및 검증

일반 PowerShell에서 실행합니다. 새 외부 의존성은 없습니다.

```powershell
Set-Location 'C:\Users\User\Documents\Codex\2026-10-20\exit-link-fastapi-python-tcp-socket\outputs\exit-link'
.\.venv\Scripts\python.exe .\scripts\diagnose_tcp.py
.\.venv\Scripts\python.exe .\scripts\verify_stage3.py
$LASTEXITCODE
.\.venv\Scripts\python.exe .\scripts\experiment_stage3.py
$LASTEXITCODE
```

검증 실행기는 기존 64개와 새 31개, 총 95개를 실행하며 원문/실제 종료 코드를 저장합니다.
독립 실험은 다음을 수행합니다.

1. 실제 노드 6개를 각각 독립 프로세스로 실행하고 상태가 수렴할 때까지 기다립니다.
2. baseline 전송/ACK를 확인합니다.
3. 특정 메시지가 N2의 relay_wait에 진입한 로그를 확인한 뒤 그 실제 프로세스를 강제 종료합니다.
4. 같은 ID의 진행 중 메시지가 대체 경로/재시도로 ACK를 받는지 검사합니다.
5. Heartbeat down 관측 후 별도 새 메시지도 장애 노드를 피하는지 검사합니다.
6. N2를 재시작해 새 epoch와 회복 상태가 퍼지는지 검사합니다.
7. N2 다음 N3를 연속 종료해 N1을 고립시키고 전달이 no_route로 실패하는지 검사합니다.

실험은 명시적 입력인 relay-delay 0.35초, interval 0.1초, heartbeat-timeout 0.15초,
실패/복구 기준 2회, state-ttl 3초, 데이터 I/O 제한 1.5초를 사용합니다.
relay-delay는 OS 전달을 가짜로 계산하는 값이 아니라 **실제 중계 코루틴의 처리 대기**이며 종료 시점을 재현하기 위한 설정입니다.
설정값을 관측된 네트워크 지연으로 기록하지 않습니다. 일반 노드 기본 relay-delay는 0입니다.
임시 localhost 포트만 사용하며 다른 프로세스나 상용 장비는 종료하지 않습니다.

결과 위치:

- data/measured/stage3-tests-<ID>/: summary, pytest 원문, stage2/stage3 프로세스 evidence와 JSONL
- data/measured/stage3-experiment-<ID>/: summary, fault-recovery, no-route, processes 원문

연결 사전 검사가 실패하면 종료 코드 2이고 pytest/실험을 시작하지 않습니다. 이 경우 성능값을 생성하지 않습니다.
실험은 성공 검사가 실패하면 status=failed 및 비제로로 끝나며 프로세스 정리 실패도 실패입니다.

## 관측 지표와 기준

| 지표 | 단위/기준 |
|---|---|
| detection_observed_after_fault_ms | 실험 제어 프로세스의 강제 종료 요청 직전부터 status에서 down을 본 시점까지, polling 지연 포함 상한 관측 |
| down_since_first_failed_probe_observation_ms | 감지 노드에서 첫 실패 응답을 본 시점부터 down 전환까지, 실제 고장 시각과 다름 |
| route_calculation_ms | 출발 노드에서 graph 필터/경로 계산을 실제 perf_counter로 잰 시간, 전체 합 및 시도별 |
| delivery_recovered_after_fault_ms | 제어 프로세스의 종료 요청부터 진행 중 메시지의 성공 ACK 결과를 관측할 때까지, 실패 시 null |
| recovery_after_first_failure_ms | 출발 노드의 첫 시도 실패 반환부터 성공 확인까지, 재전송 성공 시에만 값 존재 |
| node_recovery_observed_ms | 재시작 요청부터 전체 정상 링크 상태 수렴 관측까지 |
| success/retries/attempts | 실제 ACK 여부, 실제 추가 시도 수 및 각 시도의 경로/결과/기간 |
| path_before/path_after | 실험에서 원래 경로와 성공 ACK 확인 경로; 목적지 received 로그로 실제 전달 검증 |

모든 기간은 같은 프로세스의 monotonic/perf_counter 차이로 계산합니다. UTC 시각은 기록/광고 신선도 확인용입니다.
입력은 topology_origin=simulation, TCP 관측은 observation_origin=real_process/transport=real_tcp_loopback으로 구분합니다.
단위 테스트의 가짜 시계/그래프 검사는 TCP 관측 파일로 내보내지 않습니다.

## 한계 및 다음 단계 경계

신뢰하는 단일 Windows 호스트의 6개 노드 실험입니다. 인증·TLS·영속 상태·정확히 한 번의 영속 처리,
다중 호스트 시계 보정, congestion 제어, 지수 backoff, 대규모 gossip 최적화는 없습니다.
epoch는 벽시계 기반이므로 호스트 시계가 뒤로 크게 바뀌면 재시작 상태 순서 판정에 제한이 있습니다.
네트워크 분할 때 전역 장애 여부를 확정하는 합의 프로토콜은 아니며, 신선한 양방향 정보가 없으면 보수적으로 실패합니다.
TTL/재시도/상태 수명 값은 실험 조건이며 실제 건물 안전성을 검증한 값이 아닙니다.
4단계 대피 경로 계산은 별도 건물 그래프를 사용해 추가해야 하며 이번 구현에는 포함하지 않았습니다.

참고: [NetworkX shortest_path](https://networkx.org/documentation/stable/reference/algorithms/generated/networkx.algorithms.shortest_path.html),
[Python asyncio 취소 및 태스크](https://docs.python.org/3.12/library/asyncio-task.html).
