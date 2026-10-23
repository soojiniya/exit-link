# EXIT-LINK 本 실험 준비 및 검증 상태

2026-10-21 KST. **480셀 본 실험은 실행하지 않았습니다.**
최종 계획은 `data/measured/m-ef7153ef/plan.json`이며 run ID는 `45a09b31-e521-41ad-b38f-b3328f615dbe`입니다.
읽기 전용 감사의 12개 검사가 통과했고 완료 셀·실행 디렉터리는 모두 0개입니다.
현재 환경의 localhost 제한 때문에 **최신 전체 회귀와 실제 TCP 재검증은 일반 PowerShell에서 완료해야 합니다.**

## 이전 작업 확인 및 이번 변경

중단 전 마지막 전체 로그는 `stage5-tests-20261020T225152Z-f1bc4990`의 **226 passed / 178.72초**였습니다.
그 뒤 추가한 테스트와 이번 수정을 포함한 현재 수집 수는 **230개**입니다. 226 통과는 현재 코드 전체 통과 결과가 아닙니다.
Git에서는 프로젝트 파일들이 미추적으로 보여 신뢰할 커밋 기준 diff가 없습니다. 기존 파일을 확인하며 필요한 부분만 수정했습니다.

| 파일 | 구현·보완 내용 |
|---|---|
| src/exit_link/experiments/comparison.py | aligned_v2 시간표, 요청 전체 6초 제한, 정확한 F~F+9초 프레임 집계, 창 이후 수신 별도 보존, 영구 의도/결과 기록 |
| src/exit_link/experiments/study.py | 준비/제한 실행/체크포인트 재개, 설계·코드·스크립트·의존성·JSON 해시, 환경 일치 검사 |
| src/exit_link/experiments/safety.py | fsync + 원자 교체, OS 파일 잠금; 중단 전 추가된 구현을 유지 |
| src/exit_link/experiments/inference.py | 메시지 위치별 Wilson 구간, paired-cell bootstrap; 중단 전 구현 유지 |
| scripts/prepare_main_study.py | 기본은 계획 생성만 수행. 실행에는 별도 --execute/--max-cells 필요 |
| scripts/check_main_plan.py (이번 신규) | 노드를 시작하지 않는 계획 수량·층·균형·공통 설정·해시·환경 감사 |
| scripts/analyze_main_study.py | 메시지 실패·예약 오차·불완전/변조 셀을 구분하고 원문 CSV 보존 |
| scripts/compare_network.py | 시범 실행기도 공통 잠금 및 미정리 lease 검사를 사용 |
| tests/test_main_study.py | 현재 14개 검증 항목. 기존 216개 assertion·기대값은 수정하지 않음 |

백엔드 API/SQLite 스키마·React 5개 페이지 및 디자인을 변경하지 않았습니다.
기존 시범 데이터 `b-1f456262`는 읽기만 했고 분석 파일을 덮어쓰지 않았습니다.

## 공정성 검토와 비교의 범위

시범 60건과 analysis.json의 A 10/30, B 20/30 결과는 일치합니다. 다만 조건을 합친 성공률로 성능을 주장하지 않습니다.
시범에서는 후속 행동이 첫 전송 결과 뒤에 시작됐습니다. 원시 시각을 대조한 평균은 다음과 같습니다.

| 첫 N2 종료 확인 후 행동 | fixed | exit_link |
|---|---:|---:|
| 단일 장애의 첫 후속 송신 | 415.368ms | 627.374ms |
| 연속 장애의 N3 종료 요청 | 413.879ms | 630.309ms |
| 재시작 요청 | 416.356ms | 629.079ms |

이것은 새 실험값이 아니라 기존 시범 로그에서 계산한 값입니다. v2에서는 후속 행동을 전송 결과와 독립적으로 예약합니다.
A/B 입력·시간표·클라이언트 응답 제한·관측 창은 같게 했습니다. 단, **전체 장애 대응 정책**을 비교합니다.
A는 고정 경로/재시도 0/Heartbeat 없음, B는 Heartbeat/대체 경로/재시도 최대 3회입니다.
재시도 예산과 Heartbeat가 다른 만큼 순수 경로 알고리즘만의 우위로 해석하면 안 됩니다. 동일 재시도 예산과 HB-only ablation은 별도 후속 실험입니다.

## 확정 준비 설정: 480셀·1,440메시지

| 조건 | 장애 시점 층 | 방식별·층별 반복 | 전체 셀 | 전체 메시지 |
|---|---|---:|---:|---:|
| 정상 | none | 30 | 60 | 180 |
| 단일 N2 장애 | before_send / inflight | 각 30 | 120 | 360 |
| N2→N3 연속 장애 | before_send / inflight | 각 30 | 120 | 360 |
| 대체 경로 없음 | before_send (N2·N3 차단) | 30 | 60 | 180 |
| N2 재시작 | before_send / inflight | 각 30 | 120 | 360 |
| 합계 | 8개 층 × 2방식 | 층·방식당 30셀 | **480** | **1,440** |

하나의 paired block은 같은 층의 A/B 새 클러스터 2개입니다. 각 층에서 A→B와 B→A를 15회씩 배정합니다.
층 순서는 seed 20261022로 섞고, 같은 paired block은 같은 warmup 추가값(0/.033/.066초)을 사용합니다.
셀마다 새 6개 노드·메시지 ID·동적 localhost 포트를 사용합니다. 데이터의 독립 단위는 셀이며 메시지 3개를 독립 반복 3회로 세지 않습니다.

공통 값: payload 256 UTF-8 bytes, TTL 16, 중계 처리 지연 **설정값** .2초, warmup .6초+추가값,
node hop timeout 1.5초, 외부 응답 deadline 6초, 관측 창 9초, 예약 오차 허용 100ms입니다.
B의 기존 Heartbeat 설정은 interval .1초/timeout .15초/실패·복구 연속 2회/link-state TTL 3초입니다.

## 공통 시간표와 오차

- 정상: 준비 후 기준 F를 정합니다. 장애 조건: N2 종료를 확인한 perf_counter_ns가 F입니다.
  no_route는 두 번째인 N3 종료 확인을 F로 씁니다.
- before_send/정상/no_route의 송신 목표는 F+.05, F+.8, F+2.5초입니다.
- inflight는 N2의 해당 메시지 relay_wait를 확인해 종료합니다. 첫 메시지는 이미 진행 중이고 후속 송신은 F+.8, F+2.5초입니다.
- 연속 장애의 N3 종료 요청 및 재시작 요청 목표는 **F+1초**입니다. 첫 메시지의 결과를 기다리지 않습니다.
- 재시작은 별도 스레드에서 진행합니다. 마지막 송신을 기동 완료까지 임의 지연하지 않으며,
  listening_before_final_send와 scheduled_post_restart phase로 실제 준비 여부를 따로 남깁니다.
- F+.8초 송신은 .2초 중계 대기와 F+1초 두 번째 장애의 경계 근처일 수 있습니다. 성공 여부를 가정하지 않고
  실제 dispatch/장애 시각 차이와 phase별 결과를 분석해야 합니다.
- 두 클라이언트는 소켓 단계별 제한 외에 동일한 요청 전체 6초 wait_for를 사용합니다.
  취소 후 소켓 정리에 추가 시간이 들 수 있으며, 그 시간을 성공 응답으로 처리하지 않습니다.
- 프레임 오버헤드는 정확히 F~F+9초만 잘라 9초로 나눕니다. 관측 창 이후 수신은 received_after_window_count로 남깁니다.
- 송신 dispatch·후속 제어·관측 종료가 100ms 넘게 늦거나 장애 전에 이미 첫 메시지가 도착한 셀은
  comparable=false / schedule_deviation입니다. 성공/실패 메시지를 파일에서 지우지 않습니다.

## 통계 계획 및 해석 제한

1. 조건 × 장애 시점 × 메시지 위치(0/1/2)별 전달 성공률과 ACK 수신률을 구분합니다.
   동일 셀에서 위치 하나당 결과 1개이므로 최대로 독립 셀 30개입니다. ACK 없음과 목적지 미수신을 동의어로 쓰지 않습니다.
2. 비율은 95% Wilson 구간, A/B 전달률 차이는 matched cell pair를 재표집한 5,000회 bootstrap을 제공합니다.
   [NIST Wilson 구간 설명](https://www.itl.nist.gov/div898/handbook/prc/section2/prc241.htm).
   **가상 산술 예시**로 30/30의 Wilson 하한은 약 88.65%, 0/30의 상한은 약 11.35%입니다. 본 실험의 측정 결과가 아닙니다.
3. 모든 pair 차이가 같으면 bootstrap 구간이 점으로 줄 수 있어 boundary_warning을 남깁니다.
   이것을 드문 실패가 불가능하다는 증거로 삼지 않습니다. 다중 비교는 현재 exploratory/unadjusted 95%입니다.
4. 지연은 ACK 성공 표본만 평균·중앙값·nearest-rank P95를 계산하며 실패를 0ms로 채우지 않습니다.
   지연 신뢰구간은 아직 구현하지 않았고, 성공 표본의 조건부 지연으로 명시합니다. P95 표본이 적으면 탐색적 수치입니다.
5. Heartbeat 첫 실패→down, 기존 경로 계산·시도·재전송, 장애 확인→첫 ACK, 재시작 요청→첫 후속 ACK를 따로 보존합니다.
   TCP 실패 재시도가 Heartbeat 확정보다 먼저 성공할 수 있습니다. 이 시간을 합치거나 모두 Heartbeat 효과라 부르지 않습니다.
6. 미복구 시간은 NULL + 관측 종료까지의 구간입니다. 두 번째 장애는 새 episode입니다.
   Heartbeat/gossip는 실제 송신 애플리케이션 프레임 비용이며 TCP/IP 헤더·SYN/FIN·OS 재전송·CPU 비용은 포함하지 않습니다.
7. 본 분석은 완료·해시 확인·타이밍 적합한 matched pair만 사용합니다. 한쪽 제외 시 나머지도 unmatched_pair로 표시합니다.
   제외율이 방식과 연관될 수 있으므로 방법별 제외 수와 모든 메시지 원문도 함께 제시합니다. 실패 때문에 셀을 제외하지 않습니다.

## 저장·재개·중복 실행

- 기본 준비 명령은 plan.json만 만듭니다. --execute와 --max-cells를 둘 다 명시해야 실행 경로로 들어갑니다.
- message-intents.jsonl은 제출 의도, messages.jsonl은 완료 관측을 fsync합니다. 의도만 있는 메시지는 성공으로 만들지 않습니다.
- trial.json과 plan.json은 fsync한 임시 파일을 os.replace로 교체합니다. 완료 셀 SHA256을 체크포인트에 남깁니다.
  전원 손실·스토리지 고장에 대한 절대 보장은 아닙니다.
- 셀 경계 재개는 완료 체크포인트를 검사하고 건너뜁니다. 파일 누락/변조·체크포인트 없는 셀 디렉터리는 덮어쓰지 않고 거부합니다.
- 코드·실행 스크립트·잠금 의존성·시뮬레이션 JSON 해시와 Python/OS/라이브러리 환경이 달라지면 재개를 거부합니다.
- data/measured/.benchmark.lock은 OS가 보유하는 공통 잠금입니다. 파일의 존재만으로 실행 중이라고 판단하지 않습니다.
  시범 CLI와 본 실험 CLI가 같은 잠금을 사용합니다. 다른 앱·백엔드·pytest의 실행까지 차단하는 잠금은 아닙니다.
- owner lease가 active/needs_audit이면 다른 실행을 차단합니다. 강제 종료 후 자식 자동 정리를 보장하지 않습니다.
  raw 로그/communication.json/PID의 현재 명령·포트를 사람이 확인해야 합니다. 디스크의 PID만 보고 자동 kill하거나 lease를 자동 지우지 않습니다.
- 비정상 중단으로 checkpoint 직전에 끝난 셀도 자동 채택하지 않습니다. 원문은 보존하고 감사 후 대체 계획/제외 이력을 명시합니다.

결과 파일: plan.json, readiness.json, validation-summary.json,
t000~t479/trial.json·message-intents.jsonl·messages.jsonl·p/evidence.json·노드 로그·실제 토폴로지,
분석 시 main-analysis.json 및 **실패/비교 제외 메시지까지 포함하는** main-messages.csv입니다.
main-analysis의 exclusions는 timing_excluded, incomplete_or_execution_failure, cleanup_or_integrity_excluded,
uncheckpointed_or_modified_cell, unmatched_pair, not_executed를 구분합니다. no_route/connection_failed/timeout은 메시지 결과로 따로 남습니다.

## 이번 검증 결과 — 통과와 미검증 구분

| 범위 | 현재 결과 |
|---|---|
| 전체 수집 | **230 tests collected** |
| 완료한 제한 없는 부분집합 | **112 passed, 0 failed**, 4.77초; 기존 103 + 신규 9 |
| 계획 감사 | **12개 검사 통과**, 480셀/1,440메시지, 실행·완료 셀 0 |
| OS 중복 잠금 | 별도 Python 프로세스의 접근 거부와 잠금 해제 후 접근 성공 확인 |
| 저장 | 잘못된 직렬화 시 이전 파일 유지, 별도 writer의 os._exit 후 커밋 파일 유지 확인 |
| 분석 | 실제 메시지 실패와 예약 오차 셀을 별도 보존하는 합성 단위 fixture 확인 |
| 최신 전체/실제 TCP·asyncio | **미검증 118개**. 네트워크 제한으로 완료하지 못함 |
| 기존 백엔드·SQLite·프론트엔드 | 기능/디자인 소스 수정 없음. 현재 REST/WS 계약 순수 검사는 통과. 최신 전체 운용 재검증은 위 제약 적용 |

증거: [JUnit](../data/measured/ready-pure-complete.xml), [전체 수집 목록](../data/measured/main-collected-tests.txt),
[계획 감사](../data/measured/m-ef7153ef/readiness.json), [검증 요약](../data/measured/m-ef7153ef/validation-summary.json),
[차단 사전 검사](../data/measured/stage5-tests-20261021T031551Z-38d80dfb/summary.json).

이번 세션의 localhost connect가 WinError 10013입니다. 또한 비동기 테스트 추적에서는 Windows asyncio Proactor의
_make_self_pipe → socket._fallback_socketpair → accept 단계에서 멈췄습니다. 해당 두 부분 실행은 중단했고 성공으로 집계하지 않았습니다.
최신 셀 경계 재개 mock, 설정 거부 execute 경로, 전체 응답 제한 coroutine, 실제 재시작/TCP 셀은 일반 PowerShell 재검증 대상입니다.
이전 226 통과 로그에는 재개와 실제 노드 정리가 포함되지만 이후 변경에 대한 검증을 대신하지 않습니다.
새 v2 8개 층 전체의 실제 TCP 사전 점검과 장시간 적재, 전원 차단은 아직 하지 않았습니다.
프론트엔드 build/typecheck/verify·브라우저 수동 조작은 소스 변경이 없어 이번에 재실행하지 않았습니다.

## Windows 사전 확인 및 예상 시간

Windows 일반 PowerShell, Python 3.12 가상환경과 requirements.lock.txt의 의존성, 허용된 localhost가 필요합니다.
실험 중 절전/휴면·자동 재부팅·빌드/pytest/다른 실험·대시보드 실험 제어를 함께 실행하지 않습니다.
쓰기 가능한 로컬 디스크에 원본 로그 용량을 확보합니다. HB 원시 로그는 시간에 따라 커지므로 첫 16셀 이후 실제 사용량으로 용량을 다시 추정합니다.
현재 코드의 .2초 중계 지연과 localhost 성능을 실재 재난 통신망에 일반화하지 않습니다.

시범 셀의 관측 창 외 준비/정리 평균은 **6.995초**였습니다. 새 고정 관측 창 9초를 더하면 약 **15.995초/셀**입니다.
이것은 실측 시범에서 얻은 계수로 만든 **예산 추정**이며 새 본 실험 측정값이 아닙니다.

| 범위 | 추정 시간 |
|---|---:|
| 모든 층을 한 번씩 포함하는 최초 16셀 점검 | 약 4분 16초 |
| 10 paired block/층, 총 160셀 | 약 42분 39초 |
| 계획 전체 30 paired block/층, 총 480셀 | 약 **2시간 8분** |

부하·오류·로그 I/O를 고려해 전체에는 약 2시간 30분 이상 여유를 잡습니다. 현재는 긴 실행을 시작하지 않았습니다.
표본 수는 성능 결과를 보며 유리하게 바꾸지 않고 30쌍으로 고정하며, 중간 점검은 정리/타이밍/용량 문제에 한정합니다.

## PowerShell 검증 명령 — 본 실험 실행 명령과 분리

```powershell
Set-Location 'C:\Users\User\Documents\Codex\2026-10-20\exit-link-fastapi-python-tcp-socket\outputs\exit-link'
.\.venv\Scripts\python.exe -m pip check
.\.venv\Scripts\python.exe scripts\diagnose_tcp.py
.\.venv\Scripts\python.exe scripts\check_main_plan.py data\measured\m-ef7153ef
.\.venv\Scripts\python.exe scripts\verify_stage5.py
$LASTEXITCODE
```

verify_stage5는 본 실험을 실행하지 않고 전체 pytest를 돌립니다. localhost 사전 검사 실패 시 pytest는 시작하지 않습니다.
정상 PowerShell에서 **최신 230개 전체 통과를 확인한 뒤** 다음 실행 범위를 검토해야 합니다.
준비만 다시 하려면 `scripts\prepare_main_study.py`를 사용하며 새 폴더가 출력됩니다. 코드·환경을 바꿨으면 기존 계획을 쓰지 않습니다.

아래는 **사용자 확인 후 사용할 예시이며 이번에 실행하지 않은 명령**입니다. 처음에는 480셀이 아닌 16셀로 모든 층을 점검합니다.

```powershell
.\.venv\Scripts\python.exe scripts\prepare_main_study.py --execute data\measured\m-ef7153ef --max-cells 16
.\.venv\Scripts\python.exe scripts\analyze_main_study.py data\measured\m-ef7153ef
```

완료 후 같은 계획을 재개하면 완료 셀은 건너뜁니다. 미정리 lease가 있으면 강행하지 말고 원본과 실제 소유 프로세스/포트를 먼저 확인합니다.
