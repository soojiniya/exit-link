# aligned_v3 v3-6d329cd9 감사 및 잔여 계획 준비

감사일: 2026-10-21. 이번 작업은 감사와 도구 준비만 수행했다. 실제 잔여 셀 실행, 노드 종료, 전역 소유 상태 해제는 수행하지 않았다.

## 1. 확인된 사실과 미확정 원인

원본은 `data/measured/v3-6d329cd9`이다. `plan.json`의 완료 키는 정확히 0~397이고 실제 셀 디렉터리는 t000~t398이다. t399 이후 디렉터리는 없다. 398개 완료 셀의 trial SHA-256 및 저널 검사가 모두 체크포인트와 일치했다. 전체 순서도 원래 seed 20261022, 30회 반복의 생성 규칙과 일치한다.

t398은 sequential_failures / before_send / fixed / repetition 24이다. `status=failed`, `comparable=false`, `timing_valid=true`, 저널은 10개 항목으로 검증되었다. 저널 SHA-256은 `4c1d9d084d2f29c9b74043b4647779c9e4b29062614d7ed2868c4670abcfc10f`이다. 완료 체크포인트는 없다. 정상 정리는 확인되지 않았고, 최종 기록은 소유 프로세스 전부 종료 및 56019~56024 포트 사용 가능을 보고한다. `forced_reap_errors`의 실제 JSON 값은 빈 배열 `[]`이다. 이는 당시 기록이며 현재 호스트 상태를 대신하지 않는다.

N1의 `p/N1-0.jsonl`에서 확인한 순서(UTC):

| 시각 | 사실 |
| --- | --- |
| 13:10:24.821590 | node_started, PID 17068, port 56019 |
| 13:10:30.409534 | N2 연결 connect_timeout, 첫 메시지 |
| 13:10:31.172948 | N2 연결 connect_timeout, 두 번째 메시지 |
| 13:10:32.868721 | N2 연결 connect_timeout, 세 번째 메시지 |
| 13:10:37.857666 | shutdown_requested |
| 이후 | node_stopped 기록 없음 |

세 메시지는 ACK를 받지 못했다. 그러나 **N2 연결 실패가 N1 종료 실패의 직접 원인이라는 증거는 없다.** 확인된 직접 실패는 클러스터 종료 검사에서 N1 예외가 수집되어 `RuntimeError: Cluster cleanup failed: [{'node': 'N1', 'error': ''}]`로 전파된 것이다.

관련 코드:

- `src/exit_link/simulation/processes.py:168~199`: 정상 종료 요청, `process.wait(timeout=5)`, 종료 코드와 node_stopped 검사, 실패 수집 및 소유 핸들에 대한 강제 종료. 184~185행이 예외의 `str(exc)`만 저장하므로 빈 문자열로부터 예외 종류나 발생 단계를 복원할 수 없다.
- `src/exit_link/communication/client.py:59~65`: Shutdown 요청과 Stopped 응답 확인.
- `src/exit_link/communication/protocol.py:217~241`: 연결·프레임 송수신 제한 시간과 writer 정리. 연결 단계만 ConnectionFailed로 변환하고 이후 I/O 시간 초과는 별개이다.
- `src/exit_link/communication/node.py:75~88,105~107,132~141`: 요청 로그는 응답 전 기록되며 writer 정리 뒤 stop_event를 설정한다. 정상 종료 로그는 서버·핸들러 정리가 끝난 뒤에만 기록된다. Stopped 응답 자체는 Ack 전송 로그 대상이 아니므로 ACK 로그 부재로 종료 응답 부재를 단정할 수 없다.

추정: 종료 응답 대기, writer 정리, 노드 내부 핸들러 종료 중 어느 단계의 예외 또는 지연인지 구분할 필요가 있다. 빈 문자열은 TimeoutError 등과 양립하지만 확증은 아니다. 상세 예외 타입·repr·단계·자식 종료 코드가 남지 않아 현재 원본만으로 최종 원인을 확정할 수 없다. 추가 계측은 기존 엔진 소스 해시를 바꾸므로 이번에는 구현하지 않았다.

현재 CIM 프로세스 및 TCP 조회는 실행 환경의 접근 제한 때문에 실패했다. 이를 “프로세스 없음”으로 해석하지 않았다. 사용자의 과거 PowerShell 점검은 참고 증거이며, 향후 해제 시점의 새 감사가 필요하다. 과거 PID 17068을 근거로 현재 프로세스를 종료하면 안 된다.

## 2. 원본 보존 및 해시

감사 전후 원본 폴더의 **4,091개 파일 전체 내용 해시가 동일**하다. 추가·삭제·수정 파일 0개다. 전역 `.benchmark-owner.json` 바이트도 감사 전과 동일하며 `needs_audit`이다. t122의 schedule_deviation 제외와 t398의 실패를 유지했다.

- 원본 plan SHA-256: `d3c5580c4bff70500e5823c580d0849114250133871602cc598313c2d7081e2a`
- 원본 파일 목록·해시 맵의 정규 JSON SHA-256: `2fbbf105d47a21fa6560637a3a5bcde9778565d9d80434d214e6c4b0cb9bf99a`
- 기존 `study_v3.source_hashes()` 결과와 원본 계획의 엔진 소스 맵: 전부 일치.
- 새 도구 SHA-256: `3f7315bcf8726b016cb426c1c308dfddc6a1d3cab0daa2fcfda25c01cc076660`

원본 폴더 밖 `data/measured/recovery-audit-20261021T132617Z`에 감사 전 해시 목록, owner 바이트, 최종 감사 JSON, 보존 검사 JSON과 테스트 XML을 저장했다. 내용 해시 보존은 입증했으며 NTFS 접근 시각 같은 메타데이터 불변을 의미하지는 않는다.

## 3. 복구 방법 선택

**A: 현재 구현으로는 불가능.** `study_v3.py:39~80`의 검사는 체크포인트 없는 t398 디렉터리를 발견하면 `Uncheckpointed cell: manual audit required; no replay`로 거부한다. 실제 `prepare_study_v3.py --check`도 이 이유로 종료 코드 1이었다. 전역 잠금 해제만으로 이 검사를 통과할 수 없다. 실패 셀을 건너뛰는 외부 감사/제외 입력 기능은 없다. 저장된 trial을 완료 체크포인트에 채택하거나 원본 계획을 변경하는 방법은 사용하지 않는다. 기존 audit/release 스크립트는 다른 예행 디렉터리를 대상으로 작성되어 이번 사건에 그대로 사용할 수 없다.

**B: 별도 잔여 계획을 권장한다.** 원본은 영구 읽기 전용 증거로 두고, 새 도구가 원래 trial 함수를 그대로 호출하되 t399~t479만 새 디렉터리에 저장한다. 이 도구는 기존 계획을 수정해 재개하지 않는 별도의 실행 드라이버다. 엔진 소스 맵과 별개로 새 드라이버 자체 해시까지 묶는다. 소스/환경/원본 해시가 달라지면 준비 또는 실행을 차단하며 재서명하지 않는다. 엔진 해시가 일치해도 다른 실행 세션의 자료를 자동 병합하지 않는다.

## 4. 추가 파일과 도구의 보호 장치

- `scripts/recovery_v3.py`: 이번 사건 전용 audit / prepare / dry-run / release-after-audit / execute.
- `tests/test_recovery_v3.py`: 임시 480셀 계획과 모의 상태를 사용하는 27개 테스트.
- 이 문서 및 위 별도 감사 증거 디렉터리.
- 별도 후속 계획: `data/measured/v3-tail-6d329cd9-20261021`.

기존 `src`, 기존 실행/분석 스크립트, 백엔드·SQLite·프론트엔드는 변경하지 않았다.

후속 계획 파일:

| 파일 | 역할 |
| --- | --- |
| parent-plan.snapshot.json | 원본 plan의 바이트 그대로인 참조 사본. 실행용 plan.json이 아님 |
| audit.json | 준비 시점 감사, 원본 전체 파일 해시, 제외 사유, 대응 표본, 호스트 감사 한계 |
| manifest.json | 부모 run_id, plan/tree/source 해시, 원래 순서·seed·반복·설정·토폴로지, 도구·감사 해시, 81셀 명세 |
| progress.json | 후속 셀만의 별도 완료 체크포인트. 현재 빈 객체 |
| approval.request.json | 승인 요청 양식. approved=false, release_approved=false이므로 실행 권한 없음 |

manifest SHA-256은 `f508cefb8e7285c09b6e2d9e5d6651a1a1b808c48af7eb346e84ae1b4110e5dd`이다. 셀별 조건·방법·원래 인덱스·반복 번호·warmup을 원본과 정확히 비교한다. t398 포함, 순서 변경, 실패 원본 채택, 해시 변경, 링크 경로 및 원본 안 출력은 차단한다.

실행 시 기존 OS ExecutionLock을 공유하며 잠금 내부에서 다시 감사한다. needs_audit 해제는 실행과 별도 명령이다. 명시적 해제 승인, 현 owner 바이트 해시, 원본 동일성 및 새 프로세스/자식/리스너/독점 bind 감사가 모두 충족되어야 한다. 먼저 별도 release-audits 증거를 fsync/원자 교체로 저장한 뒤 owner를 전환한다. PID 파일만 읽고 프로세스를 죽이지 않는다. 이번 작업에서는 이 전환을 **실행하지 않았다**.

실행은 승인서의 manifest/도구 해시 및 명시적 최대 셀 수를 검사한다. 원본 trial의 시간표와 저널을 재사용하며 100ms 허용 오차는 그대로다. 취소·예외·정리 실패는 needs_audit를 남긴다. 이미 시도한 폴더가 있고 완료 체크포인트가 없으면 자동 재실행/채택하지 않는다. 성공적으로 저장한 완료 셀만 다음 호출에서 건너뛴다. 체크포인트는 기존 atomic_json의 flush/fsync/replace를 사용하고 취소 중 기록 완료를 기다린다. 시간 오차 셀은 실제 comparable 값을 보존하고 추가 실행을 차단한다. 전원 차단 시 OS/디스크 자체의 보장 범위를 넘는 원자성은 주장하지 않는다.

## 5. 표본 및 대응 비교

현재 개별 비교 가능 셀은 397개지만 유효 대응 쌍은 **198쌍**이다. t123은 t122가 제외되어 대응 분석에서는 단독 셀이다. 향후 t399가 유효하더라도 t398이 실패했으므로 대응 분석에서는 단독 셀이다. 개별 결과와 대응 분석의 포함 여부를 혼동하면 안 된다.

| 조건 / 시점 | 현재 유효 쌍 | 잔여 셀 |
| --- | ---: | ---: |
| normal / none | 25 | 10 |
| no_route / before_send | 25 | 10 |
| single_failure / before_send | 25 | 10 |
| single_failure / inflight | 24 | 10 |
| sequential_failures / before_send | 24 | 11 |
| sequential_failures / inflight | 25 | 10 |
| restart / before_send | 25 | 10 |
| restart / inflight | 25 | 10 |
| 합계 | 198 | 81 |

잔여 자료가 모두 유효하다는 가정에서만 최종 대응 쌍의 이론상 최대는 238이다. 측정 결과가 아니다. t122(시간 오차), t398(정리 실패·미완료 체크포인트)을 독립 제외로 남기고 메시지 실패 원본도 보존한다. 재개 사이의 시스템 부하·시간 경과·호스트 상태 차이는 세션 효과로 별도 검토해야 한다.

## 6. 테스트 및 미검증 범위

- 새 도구의 동기 단위 테스트: **23 passed, 4 deselected**, 최종 69.96초, 종료 코드 0. final-verified-unit.xml에 기록했다. 원본 보존, 정확한 81셀 순서, t398 재측정 차단, 원본/도구/감사 해시, 수정된 명세·제외 정책 거부, 승인·소유 상태·호스트 가시성 차단, 모의 공식 감사 해제를 검증했다.
- 기존 회귀 테스트 중 실행 가능한 선택 집합: **154 passed, 37 deselected**, 6.79초, 종료 코드 0. regression.xml에 기록했다.
- 서로 다른 테스트 합계 **177개 통과**. 전체 수집은 **324개**. 나머지 147개를 통과했다고 주장하지 않는다.
- 실제 원본 대상 읽기 전용 감사, 원래 --check의 실패 조건, 81셀 후속 prepare 및 dry-run 수행. 새 계획 완료 셀 **0개**.
- `scripts/verify_stage5.py`: localhost 연결 사전 검사에서 WinError 10013, **pytest_started=false**, 프로세스 종료 코드 1. 증거는 `data/measured/stage5-tests-20261021T134247Z-6c626e56/summary.json`이다. 전체 pytest를 실행했다고 보고하지 않는다.
- 새 비동기 4개 테스트(취소, 정리 실패, 두 번의 제한 실행·재개, 시간 오차 후 차단), 실제 프로세스 중단·실제 TCP 후속 실행은 로컬 검증이 필요하다. 본 환경에서는 asyncio 실행에 필요한 로컬 소켓 제약도 있어 실행하지 않았다.
- 개발 중 임시 증거 파일의 긴 Windows 경로로 실패한 테스트가 있었다. 새 도구의 UUID 파일 이름과 실행 증거 경로만 짧게 바꾸었고, 기존 검증 조건을 완화하지 않은 최종 재실행에서 위 23개가 통과했다.

## 7. 지금 가능한 상태와 추가 승인

**계획 준비·읽기 전용 검증은 완료했지만 실행 승인 가능한 상태 검증은 미완료다.** dry-run은 plan_verified_no_execution, planned=81, completed=0, owner_state=needs_audit, execution_ready=false를 반환했다. CIM 접근 실패를 안전한 빈 상태로 바꾸지 않았다. 새 비동기 테스트 4개와 전체 로컬 회귀 결과를 먼저 확인해야 한다.

필요한 사용자 결정은 (1) t398을 실패 원본으로 보존하고 별도 잔여 드라이버를 사용하는 정책 승인, (2) 현 호스트 감사가 성공한 뒤 전역 needs_audit의 증거 기반 해제 승인, (3) 우선 1셀만 실행하는 승인이다. 81셀 전체 실행은 별도 명시적 승인을 받아야 한다. 후속 결과 자동 통합은 승인 대상에 포함하지 않는다.

## 8. Windows PowerShell: 지금 실행 가능한 검증

프로젝트 루트에서 실행한다. 이 절의 명령은 본 실험 셀을 실행하지 않는다. pytest는 별도 임시 데이터/테스트 노드만 사용한다. 실행 중인 실험이나 소유 노드가 없는 로컬 검증 시간대를 사용한다.

```powershell
Set-Location 'C:\Users\User\Documents\Codex\2026-10-20\exit-link-fastapi-python-tcp-socket\outputs\exit-link'
$env:PYTHONUTF8 = '1'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
New-Item -ItemType Directory -Path "data/measured/recovery-local-$stamp" | Out-Null

# 새 27개 전체: 임시 데이터와 모의 프로세스. 본 실험 실행 아님
.\.venv\Scripts\python.exe -m pytest tests/test_recovery_v3.py -v --basetemp "data/measured/rtest-$stamp" --junitxml="data/measured/recovery-local-$stamp/unit.xml"

# 전체 회귀 및 테스트 전용 HTTP/WS/TCP
.\.venv\Scripts\python.exe scripts/verify_stage5.py

# 현 원본 감사 보고서는 별도 새 디렉터리로만 출력
.\.venv\Scripts\python.exe scripts/recovery_v3.py audit data/measured/v3-6d329cd9 --output "data/measured/recovery-local-$stamp/audit.json"
.\.venv\Scripts\python.exe scripts/recovery_v3.py dry-run data/measured/v3-tail-6d329cd9-20261021

# 참고용 읽기 전용 관찰. 조회 실패를 빈 결과로 간주하지 말 것
Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.Name -match '^python(w)?\.exe$' } | Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine
Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -in (56019..56024) } | Select-Object LocalAddress,LocalPort,OwningProcess
```

검증 후 코드가 변경되면 기존 manifest의 도구/소스 해시를 다시 서명하지 말고, 원본을 보존한 채 새 후속 디렉터리로 prepare해야 한다. 새로운 승인 계획은 하나만 선택해 실행한다. 여러 승인된 후속 계획을 병행하면 동일 셀의 중복 측정 위험이 있으므로 금지한다.

```powershell
# 코드 변경 시에만: 새 별도 디렉터리 준비. 노드 시작 없음
.\.venv\Scripts\python.exe scripts/recovery_v3.py prepare data/measured/v3-6d329cd9 "data/measured/v3-tail-$stamp"
```

## 9. 승인 이후에만 사용할 실행 절차

**아래는 이번 작업에서 실행하지 않았으며, 사용자 승인 전에는 실행하지 않는다.** request 양식은 의도적으로 approved=false다. 승인 후 별도 approval.json으로 복사하여 approved_by, 승인 UTC 시각, approved=true, release_approved=true를 승인 내용에 맞춰 작성한다. manifest/tool/owner 해시를 임의로 고치지 않는다. 현 owner가 달라졌다면 새로운 감사와 승인이 필요하다. 우선 max_cells=1을 유지한다.

```powershell
# 사용자 승인과 로컬 전체 검증 후에만
$followup = 'data/measured/v3-tail-6d329cd9-20261021'
$approval = "$followup/approval.json"  # 승인 후 작성한 문서. 현재 존재하지 않음

# 새 프로세스/자식/포트 감사 및 원본 검사를 OS 잠금 안에서 다시 시행
# 통과 시에만 증거를 먼저 저장한 다음 전역 소유 상태를 전환
.\.venv\Scripts\python.exe scripts/recovery_v3.py release-after-audit $followup --approval $approval

# t399 한 셀만 별도 후속 디렉터리에서 실행. 이번에는 실행 금지
.\.venv\Scripts\python.exe scripts/recovery_v3.py execute $followup --approval $approval --max-cells 1
.\.venv\Scripts\python.exe scripts/recovery_v3.py dry-run $followup
```

중도 취소/정리 실패/미완료 폴더 발견 시 자동 재실행이나 owner 수동 수정을 하지 않는다. 새 증거를 보존하고 추가 감사를 요청한다. 실패 원인을 계측하기 위해 기존 communication/processes 소스를 수정해야 한다면 별도 프로토콜·계획 검토가 먼저 필요하며 동일 해시 연구로 자동 병합하지 않는다.
