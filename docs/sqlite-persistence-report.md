# SQLite 영구 저장 구현·검증 보고서

2026-10-21 KST. 기존 프로젝트에서 중단 지점을 확인한 뒤 저장 기능을 이어서 구현했습니다.
기존 187개 회귀 조건, TCP 엔진, 재난/대피 계산, 5개 프론트엔드 페이지의 디자인을 유지했습니다.

## 변경 파일

| 파일 | 변경 이유 |
|---|---|
| src/exit_link/storage/archive.py (신규) | APSW 단일 writer, 큐·트랜잭션·복구·멱등 기록·이력/비교 조회 |
| src/exit_link/storage/schema.py (신규) | schema v1, FK/CHECK/UNIQUE/인덱스·migration 체크섬 |
| src/exit_link/storage/models.py (신규) | 저장 상태·실험/이벤트/전달/제어 이력·통계 DTO |
| src/exit_link/storage/__init__.py | 저장 계층 설명 갱신 |
| src/exit_link/api/history.py (신규) | localhost 전용 읽기 API 7개 |
| src/exit_link/api/runtime.py | 기존 이벤트·송신·제어에 비동기 기록 연결, 원본 로그 키와 실험 연관 고정 |
| src/exit_link/api/security.py | 저장 활성화·DB 경로 환경 설정 |
| src/exit_link/main.py | 이력 라우터 등록 |
| pyproject.toml, requirements.lock.txt | APSW 3.54.1.0 의존성 고정 |
| tests/test_sqlite_archive.py (신규) | WAL·중복·롤백·잠금·큐·오류·정상/비정상 재시작 |
| tests/test_sqlite_api.py (신규) | 빈 이력·페이지·필터·비교·보안·에러 API |
| tests/test_sqlite_tcp.py (신규) | 실제 6개 노드·N2 장애·ACK·DB 기록·서버 재시작·DB 오류 격리 |
| scripts/verify_stage5.py | SQLite 실제 실험 증거 보관, 사용자 DB 설정을 테스트에서 격리 |
| docs/contracts/stage5/openapi.json, types.ts | 신규 이력 계약 생성 |
| docs/sqlite-persistence-guide.md (신규) | 설계 차이·스키마·API·Claude 연동·운영 한계 |
| docs/sqlite-persistence-design.md, README.md | 최초 설계와 현재 구현을 구별하고 실행 안내 갱신 |
| docs/sqlite-persistence-report.md (신규) | 이 보고서 |

WebSocket JSON Schema도 기존 생성기로 재생성했으며 기존 이벤트 계약을 유지합니다.
기존 pytest 파일의 assertion/기대값은 변경하지 않았습니다.

## 저장·API

10개 명시적 테이블과 SQLite 자동 sqlite_sequence가 있습니다. 관계와 필드는
[구현 가이드](sqlite-persistence-guide.md)의 테이블 표 및 src/exit_link/storage/schema.py를 확인합니다.
실험 실행 환경·시각·가상 토폴로지·위험 변경·대피 계획·제어 결과·실제 장애 로그·Heartbeat 구성·안내·ACK·적용 상태·
시도별 경로·재전송·기존 실측 ms를 기록합니다. 동일 메시지/이벤트 ID를 재사용합니다.
DB 오류는 TCP 결과를 바꾸지 않으며, 기록 누락을 recording_complete=false와 오류 로그로 알립니다.

신규 GET은 `/api/v1/history/status`, `/experiments`, `/experiments/{id}`,
`/experiments/{id}/events`, `/experiments/{id}/deliveries`, `/experiments/{id}/controls`, `/comparison`입니다.
OpenAPI·TS DTO 및 빈 목록/null/503·페이지네이션 의미는 [Claude 연동 가이드](sqlite-persistence-guide.md)에 정리했습니다.
Analytics 페이지 자체는 이번 작업에서 변경하지 않았습니다.

## 검증 기록

Windows 11 실행 환경 / Python 3.12.10 / APSW 3.54.1.0(내장 SQLite 3.54.1)에서 직접 실행했습니다.

| 검증 | 최종 결과 |
|---|---|
| 전체 pytest | **208 passed, 0 failed, 0 skipped**, 126.75초, exit 0 |
| 기존 회귀 | 187개 모두 통과, 기대 조건 변경 없음 |
| 신규 SQLite | 21개 통과 (archive 13, API 5, 실제 TCP 3) |
| npm run typecheck / build / verify | 모두 exit 0 |
| 실제 실험 DB integrity_check | ok |
| 실제 실험 DB foreign_key_check | 위반 0건 |

전체 실행 증거는 `data/measured/stage5-tests-20261020T222733Z-1a6af3be/summary.json`,
`pytest-results.txt`입니다. localhost 진단이 성공하여 실제 HTTP/WebSocket/TCP 테스트를 실행했으며,
이번 실행에서 환경 제한으로 생략한 TCP 항목은 없습니다.
원시 결과는 [pytest 실행 로그](../data/measured/stage5-tests-20261020T222733Z-1a6af3be/pytest-results.txt),
[실험 DB 무결성 검사](../data/measured/stage5-tests-20261020T222733Z-1a6af3be/sqlite-backend/database-integrity.json)를 확인합니다.
프론트엔드 Windows 실행은 typecheck/build/verify 모두 exit 0입니다.
verify에는 좌표 검증 38개와 상태 처리 검증 6개가 포함됩니다.
증거: `data/measured/windows-validation-20261020T222227Z-851e83a8/summary.json` 및 phase별 txt.
`pip check`도 No broken requirements found로 완료했습니다.

첫 전체 실행은 **203 passed, 1 failed**였습니다.
`test_actual_tcp_ack_survives_unavailable_database`의 pytest 임시 폴더·실험 UUID 조합으로 communication.json 절대 경로가
262자가 되었고 파일 쓰기가 실패했습니다. 해당 경로에 직접 쓰기를 시도해 같은 FileNotFoundError를 재현했습니다.
실제 TCP 시작 전 발생한 테스트 증거 경로 문제였습니다. 신규 테스트의 증거 폴더를 짧은 SQLite 공용 증거 루트로 바꾸고
오류 응답 본문을 assertion에 추가했습니다. 성공 조건은 6개 노드 기동·실제 ACK·적용 확인 그대로입니다.
실패 증거도 `data/measured/stage5-tests-20261020T222212Z-798414b1/`에 남겼습니다.

## 실제 TCP 및 재시작 증거

최종 실행의 실험 ID는 `c036ba05-9bf3-44cd-bb5b-3736de2146e9`입니다.
증거 루트는 `data/measured/stage5-tests-20261020T222733Z-1a6af3be/sqlite-backend/`입니다.
`recorded-experiment.json`, `after-restart.json`, `history.sqlite3`, `server-*.log`,
`nodes/<실험ID>/`의 원본 노드 로그·토폴로지·evidence.json을 보존했습니다.
별도 읽기 전용 DB 검사에서는 backend run 2개, 실험 1개, 이벤트 98건, 안내/전달/시도 각 2건, 제어 4건을 확인했습니다.

- 실제 독립 노드 6개에서 N1 → N2 → N4 안내 전송 후 N2 프로세스를 종료했습니다.
- Heartbeat down 관측 후 새 안내는 N1 → N3 → N4로 전달되었습니다. N2 복구와 실험 종료도 확인했습니다.
- 전달 결과 2건·ACK 2건을 DB에서 읽었습니다. 안내 적용은 applied 1건, duplicate 1건으로 원문 그대로 저장되었습니다.
  두 번째는 동일 안내 버전/내용이므로 새 안내 적용 성공으로 중복 집계하지 않습니다.
- 이 실험의 경로 변화 수는 1, 재시도 합계는 0입니다. 첫 실패 이후 같은 메시지의 복구가 아니므로 delivery_recovery는 NULL입니다.
- 실제 전달 지연은 0~약 15ms, 평균 약 7.5ms(2표본), 경로 계산은 평균 약 0.363ms(2표본)였습니다.
  Heartbeat 첫 실패→down은 약 266ms(관측자 2표본)였습니다. 이 수치는 해당 실행 관측이며 보편적 성능 보장이 아닙니다.
  0ms는 기존 시계 해상도에 따른 관측값이며 지연이 없다는 의미가 아닙니다. 정확한 원시 float는 JSON에 있습니다.
- 실제 Uvicorn 프로세스를 종료하고 같은 DB로 새 프로세스를 시작한 뒤, 과거 상세·전달 2건이 동일하게 조회됐습니다.
  Windows terminate는 비정상 프로세스 종료이므로 해당 backend run은 다음 시작에서 불완전 기록으로 표시됩니다.
  종료 전에 명시적으로 중지한 실험은 stopped로 남고, 현재 시나리오/노드 목록은 빈 상태입니다.
- 별도 DB 접근 불가 실험에서도 실제 6개 노드 기동·ACK·안내 applied가 유지되고 이력 조회는 503으로 반환됐습니다.
- 단위 테스트에서는 Archive 정상 close 후 재개방과, 별도 writer 프로세스의 os._exit 후 커밋된 이력·interrupted 처리를 확인했습니다.

## PowerShell 재검증

```powershell
Set-Location 'C:\Users\User\Documents\Codex\2026-10-20\exit-link-fastapi-python-tcp-socket\outputs\exit-link'
.\.venv\Scripts\python.exe -m pip install -r requirements.lock.txt
.\.venv\Scripts\python.exe -m pip install --no-deps -e .
.\.venv\Scripts\python.exe scripts\diagnose_tcp.py
.\.venv\Scripts\python.exe scripts\verify_stage5.py
$LASTEXITCODE
.\.venv\Scripts\python.exe scripts\verify_windows.py --frontend-only
$LASTEXITCODE
```

verify_stage5는 SQLite를 포함한 전체 pytest를 실행하고 독립 API/TCP 프로세스·DB·재시작 전후 JSON·결과 txt를
실행 ID별로 남깁니다. localhost 사전 진단 실패 시 테스트를 실행하지 않고 exit 2로 기록합니다.
Windows 긴 경로 설정이 꺼져 있다면 프로젝트 경로를 과도하게 늘리지 않습니다.

## 한계·미검증·다음 작업

이번 실행에서 브라우저 5페이지 수동 조작은 다시 하지 않았습니다. 기존 화면 코드는 유지하고 자동 검사만 실행했습니다.
전원 차단·실제 디스크 고갈·하드웨어 고장·장시간 대규모 적재는 검증하지 않았습니다.
DB 오류 격리는 실제 파일 접근 실패 및 SQLite writer 잠금으로 검증했으며 이 결과를 모든 디스크 고장 검증으로 확대하지 않습니다.
강제 종료 후 커밋된 기록 조회는 검증하지만, 비동기 큐의 미커밋 데이터 보존을 보장하지 않습니다.
과거 JSONL 백필, 실패 기록 자동 재생, 실행 중 백업 API, 보관/용량 정책, Analytics 이력 UI는 다음 작업입니다.
수신 ACK/안내 applied는 사람 대피 완료나 실제 화재 안전을 뜻하지 않습니다.
