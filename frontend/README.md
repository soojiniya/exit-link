# EXIT-LINK Frontend — Dark Digital Twin Command Center

React 18 + TypeScript + Vite + Tailwind + Three.js(React Three Fiber) 기반 관제 화면입니다.
기존 FastAPI 백엔드(`/api/v1`, `ws://127.0.0.1:8000/ws/v1/events`)에 그대로 연결하며 백엔드 코드는 수정하지 않습니다.

## 실행

1. 백엔드 실행 (프로젝트 루트, PowerShell — 루트 README와 같음)

   ```powershell
   $env:EXIT_LINK_CONTROL_TOKEN = & .\.venv\Scripts\python.exe -c "import secrets; print(secrets.token_urlsafe(32))"
   $env:EXIT_LINK_ENABLE_EXPERIMENTS = '1'
   $env:EXIT_LINK_CONTROL_TOKEN   # 화면의 '관제 제어'에 붙여넣을 토큰
   .\.venv\Scripts\python.exe -m uvicorn exit_link.main:app --host 127.0.0.1 --port 8000 --workers 1 --no-proxy-headers --ws-max-size 4096
   ```

2. 프론트엔드 실행 (별도 PowerShell, Node.js 20 이상 — `node -v`로 확인)

   ```powershell
   Set-Location 'C:\Users\User\Documents\Codex\2026-10-20\exit-link-fastapi-python-tcp-socket\outputs\exit-link\frontend'
   npm install          # 의존성이 바뀌었을 때마다 한 번
   npm run dev          # http://127.0.0.1:5173
   ```

   프로덕션 빌드를 확인하려면 `npm run build` 후 `npm run preview`(같은 5173 포트)를 실행합니다.
   PowerShell 실행 정책으로 `npm`이 막히면 `npm.cmd run dev`처럼 `.cmd`를 붙여 실행합니다.

3. 브라우저에서 **http://127.0.0.1:5173** 을 엽니다. 백엔드 Origin 허용 목록에 맞춰 포트 5173을 고정했습니다.
   주소창에 `localhost:5173`을 써도 됩니다.

- 토큰 없이도 조회는 됩니다(읽기 전용). 상단 오른쪽 **읽기 전용 → 관제 제어**에서 토큰을 넣으면 실험·시나리오·안내 전송을 실행할 수 있습니다.
- 토큰은 탭 메모리에만 있으며 localStorage·소스·빌드에 저장하지 않습니다. 새로고침하면 다시 입력해야 합니다.
- 다른 백엔드 주소를 쓰려면 `VITE_API_ORIGIN=http://127.0.0.1:8000` 환경 변수를 지정합니다.

## 검사·빌드

```powershell
npm run typecheck       # tsc --noEmit (../docs/contracts/stage5/types.ts 포함)
npm run build           # typecheck + vite build → dist/
npm run verify          # typecheck + 좌표 38개 + 상태/연동 경합 회귀 검사
npm run verify:state    # HTTP 상태·빠른 복구·오래된 경로·스트림 교체·계측 분류 회귀 검사
npm run verify:layout   # building-layout.json ↔ 백엔드 building.json·communication.json 대조
npx tsx scripts/verify-layout.ts --api http://127.0.0.1:8000   # 실행 중인 서버 응답과 대조
```

Windows로 저장소를 옮긴 뒤에는 Linux의 node_modules를 재사용하지 말고 `npm.cmd ci`로 lockfile 의존성을 설치합니다.
EPERM으로 차단되면 점유 프로세스/폴더 쓰기 권한을 확인하며, 이를 코드 테스트 통과로 처리하지 않습니다.
백엔드 루트의 `scripts/verify_windows.py`가 Windows 전체 검증 결과를 별도 파일에 기록합니다.
[Windows 검증 보고서](../docs/windows-validation-report.md), [SQLite 설계안(미구현)](../docs/sqlite-persistence-design.md)을 참고합니다.

`verify:layout`은 위치 ID 14개, 이동 연결 15개(가정 거리 = 배치 거리, 계단은 같은 평면 위치의 층간 연결,
선분이 벽을 지날 때는 해당 층의 문·비상구 개구부로만 통과), 통신 노드 위치 6개를 확인하고 실패 시 종료 코드 1을 돌려줍니다.
앱도 로딩 시 같은 규칙(`src/domain/layoutCheck.ts`)으로 `/api/v1/building`을 대조합니다.

## 화면

| 페이지 | 상태 | 내용 |
|---|---|---|
| Digital Twin | 구현 | 3D 건물, 화재·위험·대피 경로, 통신 노드·경로 전환, 상세 패널, 이벤트 기록 |
| Network Monitor | 구현 | React Flow 토폴로지(링크 양끝 이웃 판정 up/suspect/down), 메시지 패킷·ACK 귀환 애니메이션, 장애 전후 경로 비교, 메시지 시퀀스 다이어그램, 노드 상세(이웃·Advertisement·이벤트 로그), TCP 재관측 |
| Simulation Lab | 구현 | 시나리오 생성·선택, 화재·위험·차단 위치와 통로·계단 차단 편집(전체 교체), 출발지 추가, TCP 노드 장애·복구, 안내 전송(TTL·재시도·타임아웃 선택), 장애 → 감지 → 대체 경로 → 전달 → 복구 추적, 실험 단계 기록 |
| Overview | 구현 | KPI(정상·장애·미관측 노드, 위험 구역, 대피 경로, ACK 전달), 노드 상태 분포, 현재 시나리오, 최근 전송 결과 차트, 최근 장애·경로 전환, 각 화면 바로가기 |
| Analytics | 구현 | 장애 감지 시간(detection_since_first_failure_ms), 복구 시간(재시작→복구 확인, 단절 구간), 전달 성공·실패와 적용 상태, 지연·재전송, 장애 전후 경로, 노드별 장애 판정, 실험별 비교. 모든 차트에 표 보기 제공 |

### 기록 범위와 "데이터 없음"

Overview·Analytics는 백엔드 메모리에 있는 값만 씁니다: 전송 결과 최근 512건, 이벤트 최근 512개, 시나리오 32개.
백엔드를 재시작하면 초기화되며 과거 실험 파일(`data/measured`)을 읽는 API는 없습니다.
표본이 없는 지표는 0이 아니라 "데이터 없음"으로 표시합니다. 실험별 비교는 `experiment.changed` 이벤트로 실험 구간을 만들고,
구간을 알 수 없는(보관 창 밖) 결과는 "구간 미상"으로 따로 묶습니다.

관제 제어 패널(상단 오른쪽)과 Simulation Lab은 같은 컴포넌트와 요청 모듈(`src/api/actions.ts`)을 공유합니다.
모든 쓰기 요청과 결과(HTTP 상태, 오류 코드, 응답 요약)는 실험 단계 기록에 남으며 탭 메모리에만 보관됩니다.

## 데모 순서 (경로 전환 확인)

1. 관제 제어 → 토큰 적용 → **실험 시작**(독립 TCP 노드 6개)
2. **프리셋: 서쪽 계단 화재** → F2_SW 화재, F3_W·F2_E 대피 경로 계산
3. 안내 전송 `N1 → N4` → 노란 경로와 패킷, ACK 귀환 확인
4. N2 **장애** → 타임라인에 `장애 의심 → 장애 확정`
5. 다시 안내 전송 → 우상단 **통신 경로 전환** 배너(이전 경로 빨간 점선, 새 경로 노란색)
6. N2 **복구** → `복구 중`(주황) → Heartbeat 재확인 후 정상

## 데이터 원칙

| 표시 | 출처 | 배지 |
|---|---|---|
| 화재·위험 구역, 대피 경로 | 백엔드 시나리오(가상) | SIM |
| 노드 상태, 링크, 메시지 경로, ACK, 적용 상태 | 실제 TCP 프로세스 관측 | LIVE TCP |
| 실험 프로세스 시작·종료·장애 주입 | 백엔드 실험 제어 | CONTROL |
| 벽·사무실·가구·나무, 좌표 | `src/data/building-layout.json` | 가상 배치(실측 아님) |

- 응답 구조는 `docs/contracts/stage5/types.ts`를 `@contracts` 별칭으로 직접 import 합니다(복사본 없음).
- 관측되지 않은 수치는 만들지 않습니다. `not_observed`, 관측 오류, `no_route`, 미확인 receipt는 각각 따로 표시합니다.
- 노드가 모두 응답하지 않고 실험도 꺼져 있으면 장애(빨강)가 아니라 **미실행**(회색)으로 표시합니다.

## 3D 배치 파일 (검토용 초안)

`src/data/building-layout.json`은 3D 표현만을 위한 가상 좌표입니다(`layout_origin: design_assumption`, `status: draft_for_review`).
위치 ID 14개와 연결 15개는 백엔드 `building.json` 그대로이며, 새 위치나 연결을 만들지 않습니다.
화면 로딩 시 `/api/v1/building`과 대조해 ID가 하나라도 어긋나면 3D를 그리지 않고 오류를 표시합니다.

| 위치 | 평면 좌표 (m_assumed) | 근거 |
|---|---|---|
| F*_W (복도 서) | (8, 9) | |
| F*_E (복도 동) | (28, 9) | W–E 20m |
| F*_SW (서쪽 계단참) | (8, 14) | W–SW 5m |
| F*_SE (동쪽 계단참) | (28, 14) | E–SE 5m |
| EXIT_W | (4, 9), 1층 서쪽 외벽 | W–EXIT 4m |
| EXIT_E | (32, 9), 1층 동쪽 외벽 | E–EXIT 4m |

- 건물 외곽 28m × 18m, 층고 3.6m, 중앙 복도 폭 3m. 계단 연결(8m)은 같은 평면 위치의 층간 연결로 그립니다.
- 사무실 A~D·회의실·라운지(`decor_rooms`)와 가구는 **장식**이며 경로 계산·위험 판정에 쓰이지 않습니다. 화면 왼쪽 아래 `사무 공간·가구` 토글로 끌 수 있습니다.

## 본 실험 결과(저장된 정적 데이터)

Analytics 맨 위의 **본 실험 결과 | Fixed vs EXIT-LINK** 구역은 최종 분석 폴더
`outputs/final-analysis-20261022-claude-7f3a2c/`를 해시 검증 후 변환한 정적 JSON(`src/data/study/aligned-v3-study.json`)만 읽습니다.
백엔드·WebSocket·스토어와 연결하지 않으므로 백엔드가 꺼져 있어도 표시되며, 실시간으로 갱신되지 않습니다
(화면 표시: `저장된 실험 결과 · aligned_v3 · 2026-10-21 측정 · 실시간 아님`). 아래의 기존 실시간 지표(LIVE TCP)와 섞이지 않습니다.

```powershell
npm run verify:study            # JSON ↔ 분석 CSV 전 값 대조, 해시·무결성 확인 (읽기 전용)
npm run import:study -- --force # 분석 폴더가 바뀌었을 때만 JSON 재생성 (해시·무결성 불일치 시 중단)
```

- 변환은 값을 바꾸지 않습니다(CSV 문자열 → 숫자/null/불리언 형 변환만). 반올림은 화면 표시 단계에서만 합니다.
- 사용 파일: `stats_overall.csv`, `stats_by_stratum.csv`, `stats_by_fault_timing.csv`, `stats_by_condition.csv`,
  `stats_by_position_mcnemar.csv`, `latency_conditional.csv`, `latency_by_position.csv`, `overhead_detection.csv`,
  `exclusions.csv`, `integrity_report.json`, `hashes_after_check.json` — 각 파일의 SHA-256이 `OUTPUT_SHA256SUMS.txt`와 같아야 합니다.
- 분석 폴더에는 쓰지 않습니다. 화면 구성: `src/ui/study/StudyResults.tsx`, 데이터 타입: `src/domain/study.ts`.
