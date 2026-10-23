# EXIT-LINK 1단계 완료 보고

확인 날짜: 2026-10-20 (Asia/Seoul)

## 기존 상태 및 생성 위치

시작 폴더에는 `outputs/`, `work/`만 있었고 기존 프로젝트 소스와 적용할 `AGENTS.md`는 없었습니다.
완성된 프로젝트를 `outputs/exit-link/`에 생성했습니다.
중간 데이터 생성 스크립트와 HTTP 점검 스크립트, 설치용 임시 파일은 상위 `work/`에 두었습니다.
개발 기준은 Windows / PowerShell / Python 3.12.10입니다.
프로젝트 안에 `.venv`를 만들고 편집 가능 패키지 설치를 완료했습니다.

## 변경 파일

기존 소스 수정 없이 다음 파일을 새로 생성했습니다. 경로는 프로젝트 루트 기준입니다.

| 파일 | 역할 |
|---|---|
| `.gitignore` | 환경·인증·캐시·DB·측정 파일 제외 |
| `pyproject.toml` | Python 범위, 런타임/개발 의존성, 패키징, pytest 설정 |
| `requirements.lock.txt` | 검증 환경에서 설치된 의존성 버전 고정 |
| `README.md` | 구현 범위, 실행법, 데이터 명세, 확장 방향 |
| `src/exit_link/__init__.py` | 최상위 Python 패키지 |
| `src/exit_link/main.py` | FastAPI 앱 팩토리와 실행 진입점 |
| `src/exit_link/api/__init__.py`, `api/health.py` | HTTP 어댑터와 `/health` |
| `src/exit_link/topology/__init__.py` | 토폴로지 패키지 |
| `src/exit_link/topology/models.py` | Pydantic 데이터 검증 |
| `src/exit_link/topology/loader.py` | JSON 로딩과 건물 위치 참조 검증 |
| `src/exit_link/topology/graphs.py` | 독립적인 이동/통신 NetworkX 그래프 생성 |
| `src/exit_link/data/simulation/building.json` | 3층, 공간 14개, 이동 연결 15개 |
| `src/exit_link/data/simulation/communication.json` | 노드 6개, 논리 링크 7개, 향후 로컬 포트 |
| `src/exit_link/communication/__init__.py` | 후속 TCP 엔진 확장 위치 |
| `src/exit_link/fault_detection/__init__.py` | 후속 Heartbeat 확장 위치 |
| `src/exit_link/routing/__init__.py` | 후속 통신/대피 경로 서비스 확장 위치 |
| `src/exit_link/simulation/__init__.py` | 후속 장애 시나리오 확장 위치 |
| `src/exit_link/storage/__init__.py` | 후속 SQLite 저장소 확장 위치 |
| `src/exit_link/metrics/__init__.py` | 후속 측정 기능 확장 위치 |
| `data/measured/README.md` | 실제 측정 자료의 분리 원칙 |
| `tests/test_health.py` | HTTP 및 OpenAPI 테스트 |
| `tests/test_topology.py` | 데이터, 연결성, 단일 노드 제거, 격리 테스트 |
| `docs/pytest-results.txt` | 최종 pytest 원문 출력 |
| `docs/stage-1-report.md` | 이 보고서 |

확장 위치로 표시한 패키지는 설명만 있는 빈 패키지입니다.
건물과 통신 그래프는 별도 JSON·모델·생성 함수로 관리하며 `location_id`로 위치만 참조합니다.
통신망은 외곽 순환 6개 링크와 가운데 보조 링크 1개입니다.

## 실제 검증 결과

최종 실행한 명령과 결과:

```text
python -m pytest -v
25 passed in 1.15s

python -m pip check
No broken requirements found.
```

위 `python`은 프로젝트 `.venv/Scripts/python.exe`입니다.
제한된 실행 환경의 기본 임시 폴더에 쓰기가 불가능해, 검증 시 `TEMP`와 `TMP`를 상위 `work/tmp`로 지정했습니다.
첫 실행에서는 해당 임시 폴더 문제로 24개 통과·1개 준비 단계 오류가 있었고 경로 조정 후 해결했습니다.
최초 의존성 조합의 Starlette 폐기 예정 경고도 공식 권고에 맞춰 개발 의존성을 `httpx2`로 바꿔 해결했습니다.
최종 실행에는 실패·오류·경고가 없었습니다. 테스트 원문은 `pytest-results.txt`에 보관했습니다.
`1.15s`는 pytest 자체 실행 시간이며 통신 지연이나 성능 실험 결과가 아닙니다.

검증한 항목:

- `/health` HTTP 200과 JSON 응답, OpenAPI 등록
- 건물의 3개 층, 층별 양쪽 계단참, 2개 출구, 모든 공간의 출구 접근 가능성
- 통신 노드 6개의 공간 참조와 고유한 localhost 포트
- 통신망의 이중 연결성 및 N1~N6 각각 제거 후 남은 5개 노드의 모든 쌍 연결성
- 두 그래프의 분리 및 한쪽 변경이 다른 그래프/원본 데이터에 영향을 주지 않는 것
- 중복 ID·간선·포트, 미등록 노드·공간, 자기 연결, 잘못된 거리·층간 이동·출처 거부
- 사용자 지정 JSON 경로 및 현재 작업 폴더 변경 후 기본 데이터 로딩

별도로 Uvicorn을 `127.0.0.1:18000`에서 일시 실행하고 실제 HTTP 요청을 보냈습니다.

```json
{
  "http_status": 200,
  "body": {
    "status": "ok",
    "service": "EXIT-LINK",
    "stage": 1,
    "data_mode": "simulation"
  }
}
```

점검 후 서버 프로세스를 종료했습니다. 이 검증은 HTTP 서버 점검이며 별도 노드 간 TCP 전송 실험이 아닙니다.

주요 설치 버전은 FastAPI 0.152.0, Uvicorn 0.54.0, NetworkX 3.7,
Pydantic 2.14.1, pytest 9.1.1, httpx2 2.15.1입니다.
전체 버전은 `requirements.lock.txt`를 참고합니다.

## Git 및 데이터 출처

로컬 Git 저장소를 `main` 브랜치로 초기화했습니다. 커밋과 원격 업로드는 하지 않았습니다.
`git check-ignore --no-index`로 `.env`, `.env.production`, `.env.development.local`,
`.venv`, `.vscode/settings.json`, `.python-version`, `.envrc`, DB, 인증 JSON, 개인 키,
측정 JSON/CSV가 제외되는 것을 확인했습니다.

모든 입력 JSON에는 `data_origin: simulation`을 표시했습니다.
건물 거리와 통신 연결은 가상 설계 입력이며 실제 평면도·상용 통신 장비를 사용하지 않았습니다.
실제 성능 측정 자료는 생성하지 않았습니다.
단일 노드 제거 검증은 정적 그래프 성질만 확인하며 자동 장애 감지·메시지 전달 성공을 의미하지 않습니다.

## 실행 및 다음 작업

이 프로젝트 루트에서 다음 명령으로 실행할 수 있습니다.

```powershell
.\.venv\Scripts\python.exe -m uvicorn exit_link.main:app --host 127.0.0.1 --port 8000 --reload
```

`http://127.0.0.1:8000/health`와 `/docs`에서 확인합니다.
새 환경 설치 및 상세 설명은 `README.md`를 참고합니다.

다음 2단계 작업은 별도 Python 프로세스로 실행되는 6개 TCP 노드와 기본 송수신입니다.

1. 노드 ID·포트를 읽는 실행 진입점과 프로세스 종료 처리
2. TCP 스트림의 메시지 경계를 위한 길이 접두어 또는 줄 구분 JSON 프레이밍 규약
3. 송신자·수신자·메시지 ID·종류·본문을 가진 메시지 모델
4. 연결/송신/수신 실패를 관찰할 로그 및 실제 프로세스 통합 테스트

Heartbeat, 자동 우회, ACK·재전송, 대피 경로 알고리즘, SQLite, WebSocket, 성능 측정,
React는 이후 단계에서 진행합니다. Docker와 3D 시각화는 구현하지 않았습니다.
