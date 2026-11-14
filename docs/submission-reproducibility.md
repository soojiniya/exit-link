# 제출 재현성 및 외부 연구 원본

기준 코드: GitHub `main` 커밋 `570b8100d4ae0f95e1f0645edd23acc4078d8df0`. 이 문서는 코드 실행·화면 빌드와 연구 원본 대조를 구분합니다. 건물·화재는 가상 데이터이고, `aligned_v3`는 localhost 실제 TCP 실험입니다. 실제 재난 환경의 성능 또는 대피 안전성을 증명하지 않습니다.

## 새 clone만으로 가능한 작업

Windows PowerShell에서 프로젝트 루트를 기준으로 Python 3.12와 Node.js `^20.19.0 || >=22.12.0`을 사용합니다. Python 패키지는 `requirements.lock.txt`와 `pyproject.toml`, 프론트엔드는 `frontend/package-lock.json`을 사용합니다.

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.lock.txt
.\.venv\Scripts\python.exe -m pip install --no-deps -e .
.\.venv\Scripts\python.exe -m pytest
Set-Location frontend
npm ci
npm run verify
npm run build
```

`npm run verify`는 `typecheck`, `verify:layout`, `verify:state`, `verify:public`, `verify:responsive`를 실행합니다. Git에 포함된 `frontend/public/replay/{manifest,t000,t010,t012}.json`과 `frontend/src/data/study/aligned-v3-study.json`으로 화면·빌드를 실행할 수 있습니다. 이 파일만으로 **원시 실험 재현 또는 독립적인 원본 대조가 완료되지는 않습니다**. Python 전체 테스트에는 localhost TCP 테스트가 포함되며 바인딩이 제한된 환경에서는 통과를 주장하지 않습니다. Windows 통합 실행기 `scripts/verify_stage5.py`는 별도의 `data/measured/stage5-tests-*` 결과를 만들고 실제 TCP를 사용하므로 기본 읽기 전용 검사와 구분합니다.

## 별도 보관 원본을 복원해야 가능한 검증

`outputs/`와 `data/measured/*`는 `.gitignore`에 의해 GitHub clone에 없습니다. 원본을 보관처에서 **같은 상대 경로에 원형 그대로** 복원한 뒤 다음 명령을 실행합니다. GitHub에 원본을 새로 추가하거나, 저장된 JSON만으로 원본을 재생성하지 않습니다.

| 명령 | 필요한 복원 경로 및 파일 | 해시 기준 |
| --- | --- | --- |
| `npm run verify:study` | `outputs/final-analysis-20261022-claude-7f3a2c/`의 `OUTPUT_SHA256SUMS.txt`, `stats_overall.csv`, `stats_by_stratum.csv`, `stats_by_fault_timing.csv`, `stats_by_condition.csv`, `stats_by_position_mcnemar.csv`, `latency_conditional.csv`, `latency_by_position.csv`, `overhead_detection.csv`, `exclusions.csv`, `integrity_report.json`, `hashes_after_check.json` | `OUTPUT_SHA256SUMS.txt` SHA-256 `ff1b57378a0f72996dee58cf64438af31dd0958c043034ee56d7524237f06ad8`; 개별 파일은 이 목록과 추적된 `aligned-v3-study.json`의 `provenance.files`에 기록 |
| `npm run verify:replay` | `data/measured/v3-6d329cd9/{t000,t010,t012}/` 각각의 `trial.json`, `journal.jsonl`, `p/N1-0.jsonl`부터 `p/N6-5.jsonl`까지 | 추적된 `frontend/public/replay/t000.json`, `t010.json`, `t012.json`의 `provenance`에 파일별 SHA-256 기록 |

원본 대조에 필요한 REPLAY 셀의 대표 SHA-256(파일 바이트 기준):

| 셀 | `trial.json` | `journal.jsonl` |
| --- | --- | --- |
| t000 | `fff2135155738bcbccef51c3ee4103bf457431b225f66bf10ad4acf2c51e5f73` | `7dfda48ad08de8471340f0d0d552f077a726483bec24c45fdd58cf93de406` |
| t010 | `0f65463673c1f2b1d96547fe139d8680a1f734e2ed44925007aa532f898ebc45` | `e5eb65d3c6fe8fac9506916d2e9128cf1ef49234eb4c7b1e5bffcac99563bd9b` |
| t012 | `4f0ba77f11ea271ca3e55ab86cb264f0284b97a66f687176ce596c555dc2d916` | `1ae5b029663880f026cb105ad1d039f8d8f7538dccd9c39e939c208b69ead44a` |

위 셀 해시와 분석 파일 11개의 해시는 기존 로컬 보관 원본에서 읽기 전용으로 계산하여 추적된 provenance와 대조했습니다. 원본의 입수 경로·접근 권한은 별도로 보관해야 하며, 해당 원본이 없는 새 PC에서는 두 연구 검증 명령을 성공으로 보고할 수 없습니다.

```powershell
# 프로젝트 루트에서. 원본 복원 후 실행합니다.
Get-FileHash -Algorithm SHA256 outputs/final-analysis-20261022-claude-7f3a2c/OUTPUT_SHA256SUMS.txt
Get-FileHash -Algorithm SHA256 data/measured/v3-6d329cd9/t000/trial.json
Set-Location frontend
npm run verify:study
npm run verify:replay
```

`verify:study`는 분석 CSV 9개와 JSON 2개의 SHA-256, 정적 JSON의 모든 표 값과 무결성 메타데이터를 대조합니다. 보호 원본의 불변 여부는 복원된 `hashes_after_check.json`의 기록을 확인하는 것이며 전체 원시 셀을 재해시하지는 않습니다. `verify:replay`는 3셀의 trial·journal·노드 로그 해시 및 이벤트를 대조합니다. 두 명령 모두 읽기 전용입니다. `npm run import:study -- --force`는 추적된 정적 JSON을 **덮어쓰므로** 검증 용도로 사용하지 않습니다. 전체 480셀의 실험 재실행과 이 두 명령의 원본 대조는 서로 다른 작업입니다.

## LIVE, REPLAY, CINEMATIC 및 이력

- **LIVE:** 로컬 FastAPI·WebSocket 및 독립 TCP 노드의 현재 관측 상태. 실험 제어는 로컬에서 별도 활성화 및 토큰이 필요합니다.
- **REPLAY:** Git에 포함된 실제 TCP 실험 3셀의 변환된 정적 기록. 현재 TCP 송신이나 실시간 측정을 수행하지 않습니다.
- **CINEMATIC:** 같은 REPLAY 이벤트를 카메라·캡션·효과로 연출합니다. 새로운 측정값이 아닙니다.
- **SQLite 이력:** 로컬 백엔드에서 저장을 활성화하면 `GET /api/v1/history/status`, `/experiments`, `/experiments/{experiment_id}`, 그 하위 `/events`, `/deliveries`, `/controls`, 그리고 `/comparison`으로 과거 기록을 조회할 수 있습니다. LIVE 메모리 상태와 별도이며 공개 Render API에는 제공하지 않습니다. [SQLite 가이드](sqlite-persistence-guide.md)를 참고하세요.

## 공개 배포 설정

`render.yaml`은 Python 3.12.10에서 `pip install -e .`로 설치하고 `exit_link.public_app:app`을 실행합니다. **로컬 `requirements.lock.txt` 설치 방식과 다릅니다.** Render 서비스는 main On Commit 배포로 설정할 수 있지만 실제 대시보드 설정을 확인해야 합니다. `render.yaml`의 `EXIT_LINK_PUBLIC_ORIGIN`은 `sync: false`이므로 Render 대시보드에 직접 지정해야 합니다. 선택적 Preview Origin도 코드에서 읽지만 YAML에는 없으므로 수동으로 추가해야 합니다.

```text
EXIT_LINK_PUBLIC_ORIGIN=https://exit-link-mu.vercel.app
EXIT_LINK_PUBLIC_PREVIEW_ORIGIN=https://exit-link-git-integrate-p1-final-presentation-soojin7.vercel.app
```

둘 다 정확한 HTTPS Origin으로 지정하며 경로·끝 슬래시·와일드카드를 넣지 않습니다. Preview가 필요 없으면 두 번째 변수를 생략할 수 있습니다. Vercel 프론트엔드는 `frontend/`를 루트로 사용하고 `VITE_DEMO_MODE=1`, `VITE_PUBLIC_READONLY_API=1`, `VITE_API_ORIGIN=https://exit-link-api.onrender.com` 같은 빌드 환경변수를 배포 프로젝트에서 지정해야 공개 읽기 전용 API와 연결됩니다. 변수 값과 배포 커밋은 실제 Vercel·Render 설정에서 확인해야 하며 Git 파일만으로 운영 배포 상태를 증명할 수 없습니다. `public_app.py`에는 GET과 Origin 제한 WebSocket만 있고 실험 제어 라우트가 없습니다. Render에 로컬 제어 토큰을 설정하지 않습니다.

## P2: `loadBuilding()` 타이머 개선 설계 (이번 변경에 코드 수정 없음)

현재 `frontend/src/realtime/socket.ts`의 실패 분기는 3초 후 자기 자신을 다시 호출하지만, 타이머 ID를 보관하거나 `fetch`를 취소하지 않습니다. `frontend/src/App.tsx` 효과는 REPLAY 진입 시 WebSocket만 중단합니다. 따라서 라우트 전환·재마운트 중 기존 재시도와 새 요청이 겹칠 수 있습니다.

후속 코드 변경 시 건물 로더를 시작/중단 가능한 단일 세션으로 만들고, 세션별 `AbortController`와 재시도 타이머 ID를 보유합니다. 새 시작 전에 이전 세션의 타이머를 지우고 요청을 취소합니다. 효과 cleanup과 REPLAY 전환 때도 동일하게 정리하며, 완료 응답은 활성 세션 ID가 일치할 때만 스토어에 반영합니다. `AbortError`는 연결 오류로 표시하거나 재시도하지 않습니다. `eventStream`의 시작/중단 책임은 그대로 둡니다. 회귀 테스트는 연속 실패 후 라우트 전환, 느린 응답 뒤 취소, 재진입, 공개 모드에서 요청 중복·타이머 잔존 여부를 확인해야 합니다.
