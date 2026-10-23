# EXIT-LINK

재난 상황을 가정한 네트워크 장애 감지 및 자동 통신 경로 전환 시스템입니다.
현재는 **1단계: 프로젝트 구조, 개발 환경, 가상 토폴로지, 기본 HTTP 서버**만 구현했습니다.
실제 건물의 안전 판단이나 대피 지침으로 사용하는 시스템이 아닙니다.

## 구현 범위

- Python 3.12 / FastAPI 기본 서버와 `GET /health`
- 가상 3층 건물: 각 층 동·서 복도와 양쪽 계단참, 1층 동·서 비상구
- 가상 통신 노드 6개, 무방향 연결 7개
- Pydantic JSON 검증과 서로 독립적인 NetworkX 그래프 생성 함수
- 정상 통신망 및 각각의 노드 1개 제거 후 잔존 노드 연결성 테스트
- pytest 테스트, 의존성 명세, 로컬 파일 Git 제외 설정

TCP 소켓, Heartbeat, ACK/재전송, 장애 주입기, 운영용 경로 탐색, WebSocket,
SQLite 저장, 성능 측정, React UI, Docker, 3D는 아직 구현하지 않았습니다.
`/health`는 HTTP 프로세스의 생존만 나타냅니다. TCP 노드 상태나 통신 성공을 확인하지 않습니다.

## Windows / PowerShell 실행

이 README가 있는 `exit-link` 폴더를 VS Code에서 열고 터미널을 실행합니다.
Python 3.12가 필요합니다. SQLite는 Python 표준 라이브러리 `sqlite3`를 향후 사용하므로 별도 패키지를 설치하지 않습니다.

```powershell
python --version
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.lock.txt
.\.venv\Scripts\python.exe -m pip install --no-deps -e .
.\.venv\Scripts\python.exe -m uvicorn exit_link.main:app --host 127.0.0.1 --port 8000 --reload
```

생성된 프로젝트에는 `.venv`를 이미 구성했습니다. 다른 PC에서는 위 순서로 다시 만듭니다.
가상환경 활성화 없이 해당 Python을 직접 실행하므로 PowerShell 실행 정책 변경이 필요 없습니다.
최초 설치 시 인터넷이 필요합니다. 버전 갱신을 의도한 개발 설치는 아래 명령을 사용합니다.

```powershell
.\.venv\Scripts\python.exe -m pip install -e '.[dev]'
```

- 상태 확인: <http://127.0.0.1:8000/health>
- Swagger 문서: <http://127.0.0.1:8000/docs>
- 종료: 서버 터미널에서 `Ctrl+C`

다른 PowerShell 터미널에서 확인:

```powershell
Invoke-RestMethod http://127.0.0.1:8000/health
```

응답 형식:

```json
{"status":"ok","service":"EXIT-LINK","stage":1,"data_mode":"simulation"}
```

테스트와 의존성 확인:

```powershell
.\.venv\Scripts\python.exe -m pytest -v
.\.venv\Scripts\python.exe -m pip check
```

잠금 파일은 검증 환경에서 설치된 런타임·개발 의존성 버전을 기록합니다.
Python/OS가 달라지면 의존성 해결을 다시 검증해야 합니다. 테스트의 실행 시간은 네트워크 성능 측정값이 아닙니다.

## 디렉터리와 책임

```text
exit-link/
  .gitignore
  pyproject.toml
  requirements.lock.txt
  README.md
  docs/
    stage-1-report.md
  data/
    measured/README.md              # 실제 측정 자료 전용, 현재 비어 있음
  src/exit_link/
    main.py                        # FastAPI 생성 및 라우터 등록
    api/health.py                  # 현재 유일한 업무 API
    topology/
      models.py                    # JSON 스키마와 구조 검증
      loader.py                    # 패키지 데이터/사용자 지정 파일 로딩
      graphs.py                    # 독립적인 이동/통신 그래프 생성
    data/simulation/
      building.json                # 가상 이동 공간
      communication.json           # 가상 통신 링크와 로컬 포트 설정
    communication/                 # 후속 TCP 엔진, 현재 패키지 설명만 존재
    fault_detection/               # 후속 Heartbeat/장애 상태
    routing/                       # 후속 통신/대피 경로 서비스
    simulation/                    # 후속 장애 시나리오 실행
    storage/                       # 후속 SQLite 저장소
    metrics/                       # 후속 성능 관측 및 출처 기록
  tests/
    test_health.py
    test_topology.py
```

각 후속 패키지에는 `__init__.py`만 있으며 동작하는 기능을 흉내 내는 코드는 없습니다.
`src` 패키지는 편집 가능 설치 또는 일반 패키지 설치 후 임의의 현재 작업 폴더에서도 데이터를 읽을 수 있습니다.
실행 경로에 의존하는 상대 파일 경로를 사용하지 않습니다.

## 건물 이동 그래프

`building.json`은 `metadata`, `building_id`, `floors`, `nodes`, `edges`로 구성합니다.
공간 노드는 `id`, `floor`, `kind`, `label`을 가집니다.
이동 간선은 `source`, `target`, `kind`, `distance_m`을 가집니다.
모든 간선은 양방향입니다. 그래프는 14개 공간과 15개 이동 간선으로 구성합니다.

```text
3층: F3_SW -- F3_W ---- F3_E -- F3_SE
       |                         |
2층: F2_SW -- F2_W ---- F2_E -- F2_SE
       |                         |
1층: F1_SW -- F1_W ---- F1_E -- F1_SE
                |        |
             EXIT_W   EXIT_E
```

수직 연결은 인접 층의 같은 쪽 계단참 사이에만 존재합니다.
`corridor`는 같은 층 이동, `stairs`는 계단 이동, `exit_access`는 비상구 연결입니다.
가정한 거리는 동서 복도 20m, 복도와 계단참 사이 5m, 층간 계단 8m, 비상구 접근 4m입니다.
**이 거리는 시뮬레이션 설계 입력이며 측정값, 대피 시간, 법규 적합성 검증 결과가 아닙니다.**
화재·연기·혼잡·통행 가능 여부는 아직 모델링하지 않았습니다.

## 통신 네트워크 그래프

`communication.json`은 `metadata`, `topology_id`, `directed`, `nodes`, `edges`로 구성합니다.
각 노드는 `id`, `location_id`, `host`, `port`를 가집니다.
`location_id`는 건물 공간의 위치 참조입니다. 이 참조로 두 그래프를 합치지 않습니다.
논리 링크는 사람이 이동할 수 있는 간선과 별개이며 실제 케이블/무선 전파를 모델링하지 않습니다.

| 노드 | 건물 위치 | 향후 TCP 주소 |
|---|---|---|
| N1 | F1_W | 127.0.0.1:9101 |
| N2 | F1_E | 127.0.0.1:9102 |
| N3 | F2_W | 127.0.0.1:9103 |
| N4 | F2_E | 127.0.0.1:9104 |
| N5 | F3_W | 127.0.0.1:9105 |
| N6 | F3_E | 127.0.0.1:9106 |

```text
N5 -------- N6
|           |
N3 -------- N4
|           |
N1 -------- N2
```

순환 `N1 → N2 → N4 → N6 → N5 → N3 → N1`과 보조 링크 `N3 ↔ N4`입니다.
포트는 이후 별도 Python 프로세스의 TCP 설정으로 사용할 예약값이며 현재 포트를 열지 않습니다.
지연·대역폭·패킷 손실률·성공률 등의 임의 성능값은 넣지 않았습니다.

통신망은 단일 노드를 제거해도 **남아 있는 노드 사이**에 경로가 유지되도록 구성했습니다.
고장 난 노드 자체의 송수신을 보장하지 않으며, 여러 노드 동시 고장이나 전원·케이블의 공통 장애는 별도 검증 대상입니다.
테스트에서 `nx.is_biconnected`와 6가지 단일 노드 제거를 검증합니다.
이는 정적 그래프의 연결성 검증입니다. 실제 장애 감지나 메시지 우회 전달 실험은 아직 수행하지 않았습니다.

## 데이터 검증과 확장 경계

Pydantic은 중복 ID, 존재하지 않는 간선 대상, 자기 연결, 중복 무방향 링크,
중복 TCP 주소, 잘못된 층간 이동, 유효하지 않은 거리, 예상하지 않은 필드를 거부합니다.
`validate_locations(building, topology)`는 두 데이터셋 사이의 공간 참조를 검증합니다.
전체 연결성 및 단일 장애 내성은 pytest에서 검사하므로 JSON 변경 후 반드시 테스트를 실행합니다.
서버의 `/health`는 토폴로지 파일을 자동으로 읽거나 검증하는 readiness API가 아닙니다.

두 JSON의 `metadata.data_origin`은 `simulation`이며 현재 로더도 이 입력만 허용합니다.
실제 실험 결과는 `data/measured/` 또는 후속 SQLite 저장소에 출처와 함께 기록해야 합니다.
가상 시나리오를 TCP로 실행해 얻는 관측치는 가상 토폴로지라는 입력 출처와 실제 프로세스에서 측정했다는 관측 출처를 함께 기록할 예정입니다.

후속 HTTP/WebSocket 계층은 서비스 호출과 이벤트 전달을 담당하고,
TCP 엔진은 별도 프로세스에서 메시지 전송을 담당하도록 분리합니다.
통신 경로 서비스는 통신 그래프, 대피 경로 서비스는 이동 그래프를 사용하도록 유지합니다.
Heartbeat 상태나 메시지 이벤트는 이후 저장소에 주입하도록 설계하며 현재 전역 장애 상태는 없습니다.

## Git 및 로컬 환경

`.venv`, `.env`, `.env.*`, IDE 설정, 캐시, 로그, SQLite 파일, 인증 키, 실제 측정 자료는 `.gitignore`에서 제외합니다.
현재 환경 변수나 인증정보가 필요하지 않아 `.env`는 생성하지 않았습니다.
로컬 Git 저장소는 `main` 브랜치로 초기화했으며 커밋이나 원격 업로드는 수행하지 않았습니다.
`.gitignore`는 이미 Git이 추적 중인 파일을 자동으로 제거하지 않으므로 외부 저장소에 옮길 때도 스테이징 목록을 확인합니다.

## 다음 단계

2단계에서는 6개 독립 Python 프로세스의 TCP 노드 실행기, JSON 메시지 프레임 규약,
연결/종료 수명주기, 기본 송수신 및 프로세스 통합 테스트를 구현합니다.
그 뒤 Heartbeat, 재탐색, ACK/재전송, 대피 경로, WebSocket, 성능 측정, React 연동 순서로 진행합니다.
React 및 디자인 작업은 현재 프로젝트에 포함하지 않았습니다.

## 참고

- [FastAPI 테스트 문서](https://fastapi.tiangolo.com/tutorial/testing/): HTTP TestClient 사용 방식
- [Starlette TestClient 문서](https://www.starlette.io/testclient/): 현재 버전에 맞춰 개발 의존성으로 `httpx2` 사용
- [NetworkX 이중 연결성 문서](https://networkx.org/documentation/stable/reference/algorithms/generated/networkx.algorithms.components.is_biconnected.html): 단일 노드 제거에 대한 연결성 조건
