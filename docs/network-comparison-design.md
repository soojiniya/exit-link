# 네트워크 비교 시범 실험 설계

실측 결과는 별도 `network-comparison-pilot-report.md`에 기록합니다. 이하 내용은 실행 조건·분석 규칙입니다.
기존 208개 검증 결과는 성능 표본이 아닙니다. 이 실행기의 purpose는 contest_comparison_pilot입니다.

## 비교 대상과 통제 조건

| 항목 | A: fixed | B: exit_link |
|---|---|---|
| 노드/프로토콜 | 기존 TCPNode 6개, localhost, 길이 프레이밍 | 동일 |
| 경로 | N1 → N2 → N4 고정 | 같은 초기 경로를 선호하되 이용 가능한 다른 경로 탐색 |
| Heartbeat·링크 공유 | 비활성화 | 기존 설정 그대로 활성화 |
| 메시지 ID·TTL·목적지 ACK·중복 방지 | 기존 엔진 사용 | 기존 엔진 사용 |
| 메시지당 재전송 | 없음 | 기존 소스 재전송, 최대 3회 |
| 장애 인지 | 전송 오류만 반환 | 연속 실패 + 신선한 양방향 링크 상태 + 실패 링크 제외 |

이 비교는 전체 장애 대응 방식의 비교입니다. 순수 라우팅 알고리즘만의 비용을 분리하는 실험은 아닙니다.
A도 ACK를 사용하므로 단순 전송 후 성공 처리하지 않습니다. A는 시도 때마다 고정 경로만 사용합니다.

- 같은 가상 토폴로지·동일 호스트·Python 실행 환경. 매 셀에 새 프로세스 6개, 새 임시 loopback 포트를 사용합니다.
- N1 출발/N4 목적, UTF-8 payload 256바이트, TTL 16. 실제 프레임은 ID·시각·경로·프로토콜 필드를 추가로 포함합니다.
- 중계 처리 지연 0.2초를 두 방식에 동일하게 설정합니다. 진행 중인 메시지의 중계 노드를 종료할 시간을 확보하는
  실험 조건이며 실제 링크 지연 측정값이 아닙니다. 0.2초를 측정 지연에서 빼지 않습니다.
- 노드 hop timeout 1.5초, 외부 제어 클라이언트 제한 A 8초/B 12초. B의 여러 시도를 수용하기 위한 상한이며
  성공 지연은 같은 클라이언트 perf_counter_ns 기준으로 비교합니다. 타임아웃 값 자체를 비교 지연값으로 쓰지 않습니다.
- B: probe interval 0.1초, timeout 0.15초, 실패/복구 연속 2회, link-state TTL 3초.
- 노드 준비 확인 후 두 방식 모두 0.6초 warmup. B는 링크 상태 수렴도 확인합니다. 준비 시간은 전송 통계에서 제외합니다.
- 조건별 2개의 독립 paired block × 2방식 × 3메시지 = 20셀, 계획된 60메시지입니다.
  각 조건에서 A/B 순서를 반전하고 조건 순서는 seed 20261021로 섞습니다. 같은 seed는 순서만 재현하며 OS 타이밍을 고정하지 않습니다.

## 조건별 절차

| 조건 | 절차 및 메시지 phase |
|---|---|
| normal | 정상 상태 3메시지, normal |
| single_failure | 첫 메시지의 N2 relay_wait 로그를 확인하고 N2 kill, inflight_fault 1건 + 0.4초 후 after_fault 2건 |
| sequential_failures | 위 N2 장애 첫 결과 관측 → 0.4초 → N3 kill → 0.4초 후 isolated 2건 |
| no_route | N2와 N3를 모두 kill하여 N1을 고립 → 0.4초 후 isolated 3건 |
| restart | N2 장애 첫 결과 관측 → 0.4초 → N2 재시작 → 0.6초 후 after_restart 2건 |

장애 단계는 관측 이벤트에 맞춥니다. 따라서 첫 메시지 소요 시간이 다른 A/B의 절대 벽시계상 두 번째 장애/재시작
시각은 같지 않습니다. 두 번째 장애 이후의 steady-state와 진행 중인 장애는 phase별로 구분합니다.
동시 동작을 완전히 동일한 시각표로 통제하는 실험은 후속 과제입니다.
이미 목적지에 전달된 뒤 주입한 장애는 comparable=false로 표시하며 셀 증거를 보존합니다.
전송 실패/no_route는 기대되는 관측 결과이지 실행기 실패가 아닙니다. 프로세스 시작/정리 실패 등은 별도 표시하고 중단합니다.

## 측정 정의

| 지표 | 기준·단위·분모 |
|---|---|
| 전달 성공률 | N4의 기존 received 로그에 ID가 실제 있는 메시지 수 / 실제 시도 메시지 수 |
| ACK 수신률 | 클라이언트가 엔드포인트·ID·경로 검증을 통과한 ACK 수 / 실제 시도 수 |
| 성공 전송 지연 | 클라이언트 호출 직전 → 검증된 ACK 완료, perf_counter_ns 차이 / 1e6, ms; ACK 성공 표본만 |
| 전체 응답 지연 | 오류·타임아웃까지 포함한 모든 클라이언트 시도 소요 ms. 성공 지연과 별도 집계 |
| 장애 감지 | 기존 노드 로그의 첫 Heartbeat 실패 → down 확정 detection_since_first_failure_ms. 관측자별 표본 |
| 대체 경로 계산 | 기존 route_calculation_ms. no_route 탐색도 포함, A는 미수행 NULL |
| 장애 후 첫 ACK | kill 종료 확인 → 이후 최초 ACK를 컨트롤러가 관측한 시점, ms. 장애 episode별로 기록 |
| 재시작 후 첫 ACK | N2 재시작 요청 직전 → after_restart 메시지 최초 ACK, ms. 기동/대기 시간을 포함 |
| 재시도 | B의 기존 DeliveryResult.retries, A는 정책상 0. 응답 자체를 못 받으면 B의 실제 횟수는 NULL |
| Heartbeat 오버헤드 | 측정 창 내 성공적으로 writer.drain한 outgoing heartbeat/reply 프레임 수·바이트·bytes/s |
| 링크 공유 오버헤드 | 같은 프레임에서 advertisements를 []로 만들었을 때 줄어드는 실제 인코딩 바이트 수 |

관측 창은 warmup 후부터 마지막 시험 메시지 완료까지이며 장애·명시적 대기·재시작도 포함합니다.
조건마다 창 길이가 다르므로 원시 바이트뿐 아니라 셀별 bytes/s도 제공합니다. 요청/응답은 송신 측에서 한 번씩 셉니다.
probe_attempts는 접속 실패로 프레임을 못 보낸 probe도 포함합니다. gossip 바이트는 Heartbeat 바이트의 일부이므로 합산하지 않습니다.
TCP/IP 헤더·SYN/FIN·OS 재전송·물리 회선 바이트·CPU 비용은 계측하지 않습니다. 프레임 drain은 실제 수신의 증거가 아닙니다.
별도 실험 launcher에서만 함수 계측과 JSONL 기록을 적용합니다. 계측 비용을 포함하며 운영 서버는 이 launcher를 사용하지 않습니다.

장애 후 ACK가 관측되지 않으면 복구 시간은 NULL이며 관측 종료까지의 no_ack_observation_window_ms를 함께 기록합니다.
0이나 무한대로 대체하지 않습니다. 뒤이어 다른 노드가 장애가 나면 새 episode를 만들며 같은 첫 복구를 영구 복구로 해석하지 않습니다.
이는 개별 메시지 내부 재시도 복구 시간(recovery_after_first_failure_ms)과 다른 지표이며 기존 원문도 함께 남깁니다.

Windows Python 3.12의 perf_counter는 system-wide입니다. 정수 ns로 기록하고 같은 실행 호스트 안에서만 비교합니다.
[Python 공식 time 문서](https://docs.python.org/3.12/library/time.html#time.perf_counter).
기존 엔진의 monotonic 기반 elapsed_ms·장애 감지 값도 별도 원문으로 보존하며 고해상도 값으로 소급 변환하지 않습니다.

평균·중앙값·p95·p99·최소/최대·n을 제공합니다. 백분위수는 nearest-rank이며 NULL 표본을 만들어 채우지 않습니다.
6개 이하 성공 표본의 p95/p99는 사실상 최대값이므로 꼬리 성능 추정에 쓰지 않습니다.
같은 셀의 3메시지는 독립 반복 실험 3회가 아닙니다. 독립 단위는 새 클러스터 셀/paired block입니다.
오류 메시지와 비교 불가 셀도 파일에서 삭제하지 않으며 failed_or_incomparable 및 comparable 필드를 확인해야 합니다.
비교 불가 셀이 있으면 summary.groups는 진단용이며 성능 주장에 쓰지 않습니다. 정상 셀만의 새 분석은 명시적으로 수행해야 합니다.

## 저장·실행·회귀 검증

기존 SQLite /history/comparison은 GuidanceDelivery 중심이며 고정 경로 raw Message나 Heartbeat 프레임 카운터를 받는
범용 벤치마크 저장 API가 아닙니다. 이번에는 스키마/화면 변경 없이 별도 분석 JSON·CSV를 선택했습니다.
기존 검증 로그와 기존 SQLite 실험을 성능 표본으로 가져오지 않습니다. 실험 ID는 셀 UUID, run ID는 전체 시범 UUID입니다.

```powershell
Set-Location 'C:\Users\User\Documents\Codex\2026-10-20\exit-link-fastapi-python-tcp-socket\outputs\exit-link'
.\.venv\Scripts\python.exe scripts\compare_network.py --repetitions 2 --seed 20261021
$LASTEXITCODE
.\.venv\Scripts\python.exe scripts\verify_stage5.py
$LASTEXITCODE
```

출력은 `data/measured/b-<실행ID>/`입니다. Windows 경로 길이를 줄이기 위해 짧은 이름을 사용합니다.
manifest.json에 실행 순서·환경·설정·Python 소스 SHA256·기준 토폴로지를 기록하고 각 셀의 trial.json에 실제 포트를 보관합니다.
messages.csv는 실패 포함 메시지 원시 데이터, summary.json은 phase별 통계·실험별 오버헤드·장애 episode 원시값 및 조건별 통계입니다.
t00~t19에 trial.json, messages.jsonl, p/evidence.json 및 각 PID의 실제 노드 로그가 있습니다.
각 셀의 완료 메시지는 즉시 JSONL에 기록하고 종료 시 목적지 로그와 대조합니다. 중단된 셀은 trial.json과 원문으로 점검합니다.
전체 실행 중단 시 완료된 셀까지만 summary에 남으며 trials_planned/recorded를 비교합니다.
단위 테스트나 pytest의 실제 TCP 셀은 검증 데이터이며 제출 표본에 합치지 않습니다. 이 보고서는 명시된 b-실행 폴더만 사용합니다.

분석은 `.\.venv\Scripts\python.exe scripts\analyze_comparison.py data\measured\b-<실행ID>`로 실행합니다.
analysis.json, trial-summary.csv, failed-messages.csv, results-table.md를 추가로 만듭니다.
분석기는 지정 폴더의 manifest만 사용하고, 잘못된 purpose·셀/순서 불일치를 거부합니다.
완료되지 않았거나 comparable=false인 셀은 분석 표에서 별도 excluded_cells로 남기고 성공률 분모에 임의로 넣지 않습니다.
전송 실패 자체는 정상 완료 셀의 표본으로 포함하며 성공 표본만 골라 성공률을 계산하지 않습니다.

실행 전 localhost 진단이 막히면 실험 미실행/exit 2입니다. 이번 시범은 네트워크 권한을 허용한 Windows 환경에서 수행합니다.
추가 장시간 실행 전에 시범 소요 시간·정리 실패·표본 구조를 검토합니다. CLI는 1~4반복 시범만 허용합니다.
표준오차/신뢰구간·동등 예산 재시도 baseline·Heartbeat는 켜고 우회만 끈 ablation·무중계지연 실험은 후속 설계입니다.
