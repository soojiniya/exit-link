# EXIT-LINK 2단계 구현 및 검증 상태

작성일: 2026-10-20 (Asia/Seoul)

**2단계 코드와 테스트를 추가했지만 실제 TCP 통합 검증은 완료하지 못했습니다.**
localhost 연결이 WinError 10013으로 거부되어, 사용자 요청에 따라 로컬 PowerShell 실행 절차와 진단 방법을 제공합니다.
이 보고서는 실제 전달/ACK 성공이나 전체 pytest 통과를 주장하지 않습니다.

## 변경 범위

프로젝트 루트는 `outputs/exit-link`입니다. 시작할 때 기존 코드·JSON·테스트·의존성을 확인했습니다.

| 구분 | 파일 | 내용 |
|---|---|---|
| 수정 | `src/exit_link/communication/__init__.py` | 현재 패키지 책임 설명 |
| 수정 | `README.md` | 현재 범위, 정확한 노드/송신/종료/테스트 실행법 |
| 신규 | `src/exit_link/communication/protocol.py` | 메시지·ACK·오류 모델, 길이 프레임, 비동기 I/O |
| 신규 | `src/exit_link/communication/node.py` | TCP 서버 수명주기, 경로 검증, 중계, 중복/TTL, 이벤트 로그 |
| 신규 | `src/exit_link/communication/client.py` | 출발 노드로 실제 TCP 요청 및 ACK 상관관계 확인, 종료 API |
| 신규 | `src/exit_link/communication/__main__.py` | node/send/stop CLI와 오류 종료 코드 |
| 신규 | `tests/test_tcp_protocol.py` | 프레이밍 및 메시지 스키마 테스트 13개 |
| 신규 | `tests/test_tcp_integration.py` | 실제 소켓과 독립 프로세스를 사용하는 테스트 26개 |
| 신규 | `scripts/diagnose_tcp.py` | 임시 localhost 왕복·고정 포트 bind 진단 |
| 신규 | `scripts/verify_stage2.py` | 사전 검사, 전체 pytest, 로그/종료 코드 보관 |
| 신규 | `docs/tcp-diagnostics.md` | Windows 권한·방화벽·점유·예약 포트 구분 절차 |
| 신규 | `docs/stage-2-static-results.txt` | 실제로 통과한 31개 테스트 원문 |
| 신규 | `docs/stage-2-collection.txt` | 64개 전체 수집 결과; 통과 결과와 다름 |
| 신규 | `docs/stage-2-loopback-diagnostic.json` | 현재 환경의 실제 진단 출력 |
| 신규 | `docs/stage-1-readme.md` | 변경 전 README 보관, 1단계 시점 기록 |
| 신규 | `docs/stage-2-report.md` | 이 보고서 |

`data/measured/stage2-<실행ID>/summary.json`에도 실행기의 실제 사전 검사 결과를 기록했습니다.
이 디렉터리는 기존 Git 제외 규칙을 따릅니다.
기존 `main.py`, `api/`, `topology/`, 두 JSON, 1단계 테스트, pyproject/의존성 잠금 파일은 수정하지 않았습니다.
재난 시뮬레이션·대피 경로·프론트엔드·3D는 작업하지 않았습니다.
새 의존성, 커밋, 원격 업로드는 없습니다.

## 코드에 구현한 동작

- 6개 ID/localhost 포트를 기존 CommunicationTopology 로더로 읽고 개별 프로세스로 실행
- asyncio 스트림으로 여러 연결을 동시에 처리, 노드당 최대 128개 연결
- uint32 big-endian 길이와 UTF-8 JSON, 65536바이트 본문 제한, 부분 수신 복원
- UUID, 출발/목적지, 시간대 포함 시각, 문자열 payload, TTL, 경로/홉/직전 노드 표시
- 사용자 지정 명시적 경로를 검증하고 인접한 다음 노드로만 전송
- 최종 노드 수신 후 ACK 생성 및 기존 연결 사슬을 통한 응답 반환
- ID·경로·ACK 출발/도착 노드 대조, 중복 및 처리 중 중복 억제, ID 내용 충돌 거부
- 매 링크마다 TTL 1 감소, 부족하면 오류, 목적지 도달 시 0 허용
- 포트 충돌·잘못된 ID/메시지·프레임·연결 거부·타임아웃·잘못된 응답 처리
- 종료 CLI 및 Ctrl+C 정리 경로, JSON 시작·송신·중계·수신·ACK·오류·종료 로그

명시 경로만 사용하며 최단 경로 검색조차 추가하지 않았습니다. 경로 실패 시 그대로 오류를 반환합니다.
ACK는 수신 애플리케이션 처리/로그 생성에 대한 응답이며 SQLite 등 영속 저장 완료를 뜻하지 않습니다.
캐시는 노드별 300초/10000개 메모리 상태이며 만료·용량 초과·재시작 이후에는 중복 방지를 보장하지 않습니다.
타임아웃 후 전달 여부가 불명확할 수 있고 자동 재전송은 없습니다.
`from_node`는 경로 일관성 표시로, 발신자 인증 기능은 아닙니다. 제어 명령도 신뢰하는 로컬 개발 환경용입니다.

## 실제 실행 결과

| 항목 | 현재 결과 |
|---|---|
| 기존 토폴로지 테스트 | 23개 실제 통과 |
| 새 메시지 스키마 테스트 | 8개 실제 통과 |
| 위 선별 pytest 실행 | **31 passed, 5 deselected in 0.84s** |
| 전체 테스트 수집 | 64개 수집; 수집 성공은 테스트 통과가 아님 |
| `compileall -q src tests scripts` | 종료 코드 0 |
| `pip check` | `No broken requirements found.` |
| 9101~9106 bind 진단 | 현재 시점 모두 가능 |
| 임시 localhost 연결 | bind 성공 후 connect에서 PermissionError / WinError 10013 |
| 전체 실행기 | 사전 검사에서 중단, pytest_started=false, pytest_exit_code=null |

선별 실행 명령:

```powershell
.\.venv\Scripts\python.exe -m pytest tests\test_topology.py tests\test_tcp_protocol.py -k 'not coalesced and not invalid_or_truncated' -v
```

실제 실행에서는 제한 환경의 임시 폴더 문제를 피하기 위해 TEMP/TMP 및 `--basetemp`를 상위 `work/` 안에 지정했습니다.
5 deselected는 이 선별 명령에 포함한 파일 중 실행하지 않은 프레이밍 테스트 개수입니다.
위 시간은 pytest 실행 시간이며 네트워크 지연이나 성능 결과가 아닙니다.

처음에는 기존 테스트와 새 비동기 테스트를 실행하려 했지만 이벤트 루프 초기화가 대기해 중단했습니다.
별도 스택 진단에서 Windows asyncio가 자기 통지용 socketpair를 만드는 중 accept에서 대기하는 것을 확인했고,
동기 소켓 진단으로 임시 포트 connect가 10013으로 거부되는 것을 확인했습니다.
따라서 이 환경의 제한은 새 노드 로직만의 테스트 문제가 아니며 기존 FastAPI TestClient 실행에도 영향을 줍니다.
정확한 차단 원인은 샌드박스/Windows 정책을 비교 진단하기 전까지 확정하지 않습니다.

## 미검증 항목

전체 64개 중 아래 **33개는 현재 환경에서 실행 완료하지 못했습니다.**

- 기존 HTTP 테스트 2개: 1단계 당시의 통과 기록은 유지하지만 이번 환경에서 재통과 확인은 못함
- 새 프레이밍 비동기 테스트 5개: 합쳐진 프레임/잘린 프레임/크기 검증
- TCP 통합 테스트 26개: 6개 프로세스, 1:1, N1→N2→N4, 6개 노드 경유, ACK 체인,
  순차/동시 중복, TTL 만료, 잘못된 경로/메시지/프레임, 동시 연결, 연결 실패, 포트 충돌, 정상 종료, CLI

통합 테스트는 transport mock이나 가상 전달 함수로 성공을 대신하지 않습니다.
현재 실제 노드 간 메시지 전달/ACK 성공 결과와 성능 측정값은 없습니다.
전체 pytest 통과 여부는 로컬에서 아래 명령을 실행한 결과로 확정해야 합니다.

## 로컬 실행 및 결과 확인

```powershell
Set-Location 'C:\Users\User\Documents\Codex\2026-10-20\exit-link-fastapi-python-tcp-socket\outputs\exit-link'
.\.venv\Scripts\python.exe .\scripts\diagnose_tcp.py
.\.venv\Scripts\python.exe .\scripts\verify_stage2.py
$LASTEXITCODE
```

실행기는 소켓 사전 검사를 통과한 경우만 전체 pytest를 실행합니다.
결과 폴더에 실제 pytest 출력, 프로세스별 JSONL, PID/메시지 이벤트 evidence.json, summary.json을 남깁니다.
성공은 실제 `64 passed` 출력과 pytest_exit_code=0으로 확인합니다.
테스트 코드를 수정하면 수집 개수가 달라질 수 있으므로 출력 자체를 확인합니다.

수동 노드 시작/다중 홉 송신/종료 명령은 README에 있습니다.
실행 문맥 비교, 방화벽 규칙, 보안 감사, 포트 PID 및 제외 범위는 `tcp-diagnostics.md`를 참고합니다.
노드는 `127.0.0.1`에만 바인딩하며 외부에 공개하지 않습니다.

## 3단계 준비 사항

먼저 로컬에서 2단계 전체 테스트를 실행하고 실제 실패가 있다면 수정해야 합니다.
그 후 기존 패키지 경계를 유지해 다음을 진행할 수 있습니다.

1. `fault_detection/`에 Heartbeat 모델·주기·실패 임계치·노드 상태 전이 추가
2. `routing/`에 노드 상태를 반영하는 통신 그래프 사본과 대체 경로 서비스 추가
3. 명시 경로 전달과 자동 경로 선택을 분리하고 메시지 ID/TTL/ACK 상관관계를 유지
4. 연결 실패/ACK 시간 초과와 노드 고장 판정을 구별하고 탐지 이벤트로 연결
5. 실패한 노드를 실제로 중단하는 프로세스 테스트로 우회·중복·TTL 검증

Heartbeat, 장애 상태 저장, 자동 우회, ACK 재전송 정책은 이번 단계에 구현하지 않았습니다.
