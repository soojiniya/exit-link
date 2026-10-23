# EXIT-LINK

**Adaptive Emergency Communication Network** — 건물 내부 통신 노드 일부에 장애가 발생했을 때 대체 TCP 경로를 탐색하고, 대피 안내 메시지 전달과 ACK 수신을 시각적으로 확인하는 연구·시연 프로젝트입니다.

> **연구용 프로토타입입니다.** 3층 건물 배치와 위험 시나리오는 가상 데이터이며, 통신 실험은 로컬 TCP 노드 기반입니다. 실제 화재·재난 현장이나 대피 안전성을 검증한 시스템이 아닙니다.

## 주요 기능

| 화면 | 설명 |
| --- | --- |
| **Overview** | 시스템 소개, LIVE 상태와 저장된 사례·연구 결과를 구분해 표시 |
| **Digital Twin** | Three.js 기반 3D 건물·층별 표시, LIVE / REPLAY / CINEMATIC |
| **Network Monitor** | 6개 통신 노드와 링크, 전달 경로·장애·ACK 흐름 시각화 |
| **Simulation Lab** | 실험 시작, 노드 장애·복구, 안내 전송을 위한 제어 화면 (기본 비활성화) |
| **Analytics** | 저장된 비교 실험 결과, 전달 성공률과 측정 지표 |
| **Replay** | 기록된 실험 사례의 타임라인과 사건별 재생 |
| **Story** | 정상 통신 → 장애 → 우회 경로 → ACK → 연구 결과를 보여 주는 스크롤형 발표 화면 |

**저장된 재생 사례**

- `t012`: 정상 전달, ACK 3/3
- `t010`: N2 장애 후 N3 경유 우회, ACK 3/3
- `t000`: 복수 장애 조건에서 고정 경로 전달 실패, ACK 0/3

재생 사례는 저장된 기록이며 실시간 측정이 아닙니다. 통계 비교는 별도의 저장된 실험 데이터에 근거하며, 사례 3개를 성능 표본으로 합산하지 않습니다.

## 기술 구성

- **Backend:** Python, FastAPI, WebSocket, 6개 독립 TCP 노드, Heartbeat 기반 장애 감지, 자동 경로 선택, ACK·재전송·TTL·중복 방지
- **Frontend:** React 18, TypeScript, Vite, Tailwind CSS, Three.js / React Three Fiber, React Flow, Recharts
- **검증:** pytest 및 프론트엔드 타입·레이아웃·상태·연구 데이터·재생 검증
- **저장:** SQLite 기반 이력 기능 (선택 가능), 저장된 REPLAY JSON / 분석 JSON

## 로컬 실행

Windows PowerShell에서 저장소를 복제하고 **프로젝트 루트**에서 실행합니다. Python 3.12와 Node.js 20 이상을 권장합니다.

```powershell
git clone https://github.com/soojiniya/exit-link.git
cd exit-link
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.lock.txt
.\.venv\Scripts\python.exe -m pip install --no-deps -e .
```

**터미널 1 — 백엔드 (읽기 전용, 실험 제어 비활성화)**

```powershell
$env:EXIT_LINK_PERSISTENCE_ENABLED = '0'
Remove-Item Env:EXIT_LINK_ENABLE_EXPERIMENTS, Env:EXIT_LINK_CONTROL_TOKEN -ErrorAction SilentlyContinue
.\.venv\Scripts\python.exe -m uvicorn exit_link.main:app --host 127.0.0.1 --port 8000 --workers 1 --no-proxy-headers --ws-max-size 4096
```

**터미널 2 — 프론트엔드**

```powershell
cd frontend
npm ci
npm run dev
```

브라우저에서 **http://127.0.0.1:5173** 에 접속합니다. 백엔드를 실행하지 않으면 LIVE 데이터·3D 레이아웃 검증 등 일부 기능이 제한될 수 있으나, 저장된 REPLAY·STORY·연구 결과 데이터는 별도로 제공됩니다.

### 검증 및 빌드

```powershell
cd frontend
npm run verify
npm run verify:study
npm run verify:replay
npm run build
```

백엔드 테스트 및 운영 관련 상세 절차는 [프론트엔드 가이드](frontend/README.md), [Windows 검증 보고서](docs/windows-validation-report.md), [5단계 API 가이드](docs/stage-5-api-guide.md)에 있습니다.

## 저장된 비교 실험 해석

2026-10-21에 수집한 `aligned_v3` 데이터에서 **Fixed 210/714 (29.4%)**, **EXIT-LINK 487/714 (68.2%)**로 기록되어, 이 실험 조건에서 전달 성공률 차이는 **+38.8%p**입니다. 이는 로컬 실험 결과일 뿐 실제 재난 환경의 성공률이나 대피 완료율을 의미하지 않습니다. 분석 기준·제외 조건·제한 사항은 [연구 준비 문서](docs/aligned-v3-readiness.md)와 프론트엔드 Analytics 화면을 확인하세요.

## 공개 웹 데모 관련 안내

이 저장소의 **GitHub 공개 여부와 웹 데모 배포 여부는 별개**입니다. 정적 호스팅은 저장된 REPLAY / STORY / Analytics 시연에 적합하지만, 로컬의 FastAPI·TCP 노드 실험을 자동으로 호스팅하지 않습니다. 공개 배포 시 LIVE / Simulation Lab은 백엔드 미연결 또는 읽기 전용으로 표시해야 하며, 실험 제어용 토큰을 웹 빌드에 포함해서는 안 됩니다.

## 프로젝트 구조

```text
frontend/       React · 3D · 네트워크 시각화 · 저장된 사례
src/exit_link/  FastAPI · TCP · 장애 감지 · 통신·대피 경로
scripts/        실험·검증·분석 실행기
tests/          백엔드 테스트
docs/           API 스키마·실험 설계·검증 보고서
data/           공개 가능한 설명 및 샘플
```

**관련 문서:** [Frontend](frontend/README.md) · [Network Comparison Design](docs/network-comparison-design.md) · [Stage 5 Report](docs/stage-5-report.md) · [SQLite Guide](docs/sqlite-persistence-guide.md)
