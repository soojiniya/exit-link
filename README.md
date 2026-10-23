# EXIT-LINK

가상 3층 건물과 6개 독립 Python TCP 노드를 사용하는 재난 통신 연구·개발 프로젝트입니다.
5단계 백엔드의 FastAPI REST API·WebSocket과 Claude가 구현한 Overview, Digital Twin, Network Monitor,
Simulation Lab, Analytics 프론트엔드가 있습니다. 실제 센서는 연동하지 않으며 실제 화재 안전이나 사람의 대피 완료를 보장하지 않습니다.

[Windows 전체 검증·기술 안정성 보고서](docs/windows-validation-report.md),
[프론트엔드 실행](frontend/README.md), [SQLite 구현·연동 가이드](docs/sqlite-persistence-guide.md),
[SQLite 검증 보고서](docs/sqlite-persistence-report.md)를 참고합니다.

공모전용 네트워크 비교는 별도 실행기의 [실험 설계](docs/network-comparison-design.md)와
[Windows 시범 측정 보고서](docs/network-comparison-pilot-report.md)를 참고합니다.
기존 회귀 검증 데이터를 성능 표본으로 합치지 않습니다.
본 실험의 시간표·계획·잠금·저장 검증 상태와 PowerShell 절차는 [본 실험 준비 보고서](docs/main-study-readiness.md)에 정리했습니다.

```powershell
.\.venv\Scripts\python.exe scripts\verify_windows.py --restart-cycles 20
```

실행 중인 localhost API까지 좌표 대조하려면 `--api http://127.0.0.1:8000`을 추가합니다.
브라우저 수동/자동화 점검은 보고서의 별도 절차를 사용합니다. 위 명령만으로 브라우저 조작까지 검증하지는 않습니다.

- 가상 데이터: 건물·통신 토폴로지, 화재·위험 구역, 가정 거리 기반 Dijkstra 대피 경로
- 실제 관측: 127.0.0.1 TCP 송수신, Heartbeat, 프로세스 종료·복구, ACK·재전송 결과
- 기존 TCP 메시지·ACK 스키마와 /health 응답은 유지합니다. /health의 stage: 1은 호환용이며 전체 기능 단계나 노드 가용성을 뜻하지 않습니다.
- [5단계 API 및 Claude 연동 가이드](docs/stage-5-api-guide.md)
- [5단계 변경·검증 보고서](docs/stage-5-report.md)
- [OpenAPI](docs/contracts/stage5/openapi.json), [WebSocket JSON Schema](docs/contracts/stage5/WebSocket.schema.json), [TypeScript 타입](docs/contracts/stage5/types.ts)
- [기존 TCP·자동 경로 전환 CLI](docs/stage-3-guide.md), [TCP 진단](docs/tcp-diagnostics.md)

## 설치 및 서버 실행

Windows PowerShell / Python 3.12 기준입니다. 기존 가상환경을 그대로 사용합니다.
새 환경에서는 가상환경을 만들고, 기존 환경에서도 잠금 의존성을 설치합니다. WAL 수정이 포함된
SQLite 3.54.1을 내장하는 APSW 3.54.1.0이 추가되었습니다.

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.lock.txt
.\.venv\Scripts\python.exe -m pip install --no-deps -e .
.\.venv\Scripts\python.exe -m pip check
```

프로젝트 루트에서 실행합니다. 토큰은 매번 생성하며 파일이나 Git에 저장할 필요가 없습니다.

```powershell
Set-Location 'C:\Users\User\Documents\Codex\2026-10-20\exit-link-fastapi-python-tcp-socket\outputs\exit-link'
$env:EXIT_LINK_CONTROL_TOKEN = & .\.venv\Scripts\python.exe -c "import secrets; print(secrets.token_urlsafe(32))"
$env:EXIT_LINK_ENABLE_EXPERIMENTS = '1'
.\.venv\Scripts\python.exe -m uvicorn exit_link.main:app --host 127.0.0.1 --port 8000 --workers 1 --no-proxy-headers --ws-max-size 4096
```

http://127.0.0.1:8000/docs 에서 API를 확인합니다. Swagger Authorize에 생성한 토큰을 입력합니다.
토큰이 없으면 조회만 가능하고, 실험 활성화 환경변수가 없으면 프로세스 제어는 거부합니다.
서버 시작만으로 노드 프로세스를 만들지 않습니다. POST /api/v1/experiment가 독립 노드 6개를 생성합니다.
실험 제어는 이 서버가 소유한 프로세스만 대상으로 하며 PID·명령·실행 경로를 입력받지 않습니다.
--reload나 다중 worker를 사용하지 않습니다. 정상 종료 시 소유 노드를 정리합니다.
강제 프로세스 종료·전원 차단의 자식 프로세스 정리까지 보장하지 않습니다.

## 검증

```powershell
.\.venv\Scripts\python.exe scripts\diagnose_tcp.py
.\.venv\Scripts\python.exe scripts\verify_stage5.py
$LASTEXITCODE
```

검증기는 기존 187개와 SQLite 신규 테스트를 모두 실행하고 data/measured/stage5-tests-<실행ID>/에
summary.json, pytest-results.txt와 실제 HTTP/WS/TCP 프로세스 증거를 저장합니다.
localhost 사전 검사가 차단되면 pytest를 실행하지 않고 종료 코드 2로 기록합니다.
실패·시간 초과는 성공으로 기록하지 않습니다. 최신 SQLite 검증 결과는 SQLite 검증 보고서를 확인합니다.
일반 PowerShell에서는 직접 .\.venv\Scripts\python.exe -m pytest -v 로도 실행할 수 있습니다.

## 상태와 데이터 수명

시나리오·전송 결과 목록·WebSocket 이벤트는 단일 백엔드 프로세스 메모리에 있습니다.
재시작하면 시나리오 목록이 초기화되고 stream_id가 바뀝니다.
실시간 결과·이벤트 보관 창은 각각 최근 512개입니다. 별도로 SQLite WAL에 실험·제어·시나리오·안내·장애 이벤트를
비동기 보관하며 `/api/v1/history`에서 재시작 후에도 조회합니다. 기본 DB는 `data/measured/stage5/history.sqlite3`입니다.
`EXIT_LINK_DATABASE_PATH`로 로컬 파일 경로를 지정하거나 `EXIT_LINK_PERSISTENCE_ENABLED=0`으로 저장을 끌 수 있습니다.
저장 오류는 이력 API 503과 `/api/v1/history/status`로 드러내며 기존 TCP 및 실시간 동작을 유지합니다.
강제 종료 전 큐에 남은 미커밋 기록은 유실될 수 있습니다. 과거 이력으로 현재 노드·시나리오를 자동 복원하지 않습니다.
TCP 수신 노드의 안내 버전 가드는 기존 4단계 파일 저장을 재사용합니다.
실험별 실제 프로세스 로그는 data/measured/stage5/에 보존됩니다.
관측하지 않은 노드를 정상으로 채우거나 임의 성능 수치를 만들지 않습니다.

src/exit_link/topology, routing, communication, fault_detection, evacuation은 기존 기능이며
api/contracts.py, security.py, events.py, runtime.py, dashboard.py가 5단계 연동 계층입니다.
4단계 JSON Schema 10개는 docs/schemas/stage4/에 유지합니다.
API 스키마와 타입은 다음 명령으로 다시 생성합니다.

```powershell
.\.venv\Scripts\python.exe scripts\export_stage5_contracts.py
```

.env*, 인증정보, .venv, 로컬 IDE 설정, 측정 로그는 .gitignore로 제외합니다.
커밋·원격 업로드는 수행하지 않았습니다.

시간표 지연을 개선한 별도 `aligned_v3` 실행기의 동작 원리, 내구성 정책, 검증 결과 및
2셀 Windows 예행 명령은 [aligned-v3 준비 보고서](docs/aligned-v3-readiness.md)에 정리했습니다.
기존 `m-8ce4fd46`의 v2 자료는 보존하며 새 결과와 합산하지 않습니다.
