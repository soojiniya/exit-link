# 복구 테스트 5건 실패: Windows 경로 길이 감사

2026-10-21. 실제 실험·잔여 셀·승인/해제 명령은 실행하지 않았다.

## 확인된 원인

사용자 전체 검증의 원시 로그 `data/measured/stage5-tests-20261021T134954Z-be00518a/pytest-results.txt`와 summary.json을 확인했다. 결과는 319 passed / 5 failed, 263.34초다. 단독 27개 통과는 사용자 검증 결과이며 이번 수정 후의 검증 결과와 구분한다.

다섯 실패 경로를 로그에서 복원해 읽기 전용으로 점검했다.

| 실패 위치 | 최종 파일 경로 길이 | atomic 임시 파일 경로 길이 | 부모 디렉터리 존재 |
| --- | ---: | ---: | --- |
| continuation/release-audits/UUID.json | 257 | 261 | 예 |
| continuation/runs/UUID/approval.json (4건) | 256 | 260 | 예 |

`atomic_json`은 `.json` 뒤에 `.tmp`를 붙인다. 최종 파일 경로가 제한 안에 있더라도 임시 파일 경로는 260자를 넘길 수 있다.

기존 자료 밖의 별도 진단 경로에서 다음을 실제 재현했다. 부모는 미리 생성했고 매 시도에 존재함을 확인했다.

- 일반 경로 259자: 생성 성공.
- 일반 경로 260·261자: FileNotFoundError, errno=2.
- 같은 260·261자 경로에 Windows 확장 경로 접두사 적용: 생성 성공.

이 결과와 원본 로그의 경로 길이가 일치하므로 **이번 5건의 원인은 Windows의 일반 경로 길이 제한(MAX_PATH)**으로 확인했다. 디렉터리 삭제 경합이나 fixture 조기 정리로 설명할 필요가 없다. 다른 모든 상황에 경합이 없다는 일반적 보장을 주장하지는 않는다.

## 생성 및 정리 순서

- `scripts/verify_stage5.py`: 매 실행에 UTC 시각+임의 ID로 새 출력 디렉터리를 만들고 TEMP/TMP용 temp를 만든다. pytest의 `--basetemp`는 명시 경로여서 TEMP/TMP와 별도로 적용된다. 검증기 자체는 시험 도중 이 경로를 삭제하지 않는다.
- pytest 9.1.1의 `_pytest/tmpdir.py`: 명시 basetemp는 세션 초기화 때 준비한다. tmp_path는 테스트별, tmp_path_factory는 세션 동안 관리되며 이번 parent fixture는 모듈 범위다. 사용자 로그는 직렬 실행이며 xdist 플러그인은 없다.
- `tests/test_recovery_v3.py:38~58`: 가상 parent는 모듈 범위이고 continuation은 함수별 별도 tmp_path다. 실제 실험 폴더를 fixture로 사용하지 않는다.
- `scripts/recovery_v3.py:362~370`: release-audits 부모를 mkdir한 뒤 atomic_json을 호출한다.
- `scripts/recovery_v3.py:394~397`: 고유 runs/UUID를 mkdir한 뒤 같은 경로의 approval.json 기록을 to_thread로 기다린다.
- `src/exit_link/experiments/safety.py:7~15`: 같은 부모의 `.json.tmp`에 기록·flush/fsync한 다음 os.replace한다.

따라서 이번 기록 경로에서 부모 생성보다 파일 기록이 먼저 실행되는 순서 오류는 없다. 문제는 복구 프로토콜의 동시성보다 **전체 검증기의 긴 임시 디렉터리 배치와 Windows 경로 제한의 조합**이다.

## 최소 수정

1. `scripts/verify_stage5.py:14~18,41`: pytest 명령 구성을 작은 함수로 분리하고 basetemp의 끝 이름만 `pytest-temp` → `p`로 변경했다. 각 실행의 고유 출력 디렉터리는 그대로 유지한다. 10자를 줄여 이번 260·261자 경로를 250·251자로 만든다.
2. `tests/test_stage5_runner_paths.py`: 명령 옵션 보존 검사 1개, pytest 최대 기본 fixture 이름 길이와 동일한 깊이에서 release/approval 증거를 실제 atomic_json으로 기록하는 검사 2개를 추가했다. 테스트에서는 실제 승인이나 실험을 수행하지 않는다.
3. 이 보고서와 별도 진단 증거.

`scripts/recovery_v3.py`, 기존 27개 복구 테스트, `src`, 기존 프로토콜, 기존 실험 계획은 수정하지 않았다. 기존 manifest를 재서명할 이유도 없다. 스킵/xfail 추가, assertion 변경, 제한 시간·100ms 허용 오차·저널 정책 변경은 없다. 전역 Windows 설정이나 확장 경로를 기존 엔진에 적용하지 않았다.

임의로 더 깊은 프로젝트 폴더에서도 모든 경로가 안전하다는 의미는 아니다. 이번 프로젝트와 검증기 경로의 확인된 초과를 최소 변경으로 해결한 것이다.

## 재현 및 검증 증거

`data/measured/recovery-path-audit-20261021T135725Z-02bcba`에 감사 전 보호 대상 해시, 원본 실패 경로, 259/260/261자 재현 결과, 단독 테스트 시도 로그를 보존했다.

`data/measured/stage5-tests-20261021T135856Z-ddcebd79`에서 같은 새 회귀 테스트를 두 임시 배치로 실행했다.

- 기존 배치 `pytest-temp`: **2 failed, 1 passed**, 종료 코드 1. release/approval의 `.tmp` 기록 오류가 모두 재현됐다.
- 수정 배치 `p`: **3 passed**, 종료 코드 0, 0.37초. fsync/원자 교체 후 저장 내용과 임시 파일 부재를 검사했다.
- 기존 원래 실패 중 동기 release 테스트와 checkpoint 변조 검사를 별도로 실행: **2 passed**, 종료 코드 0, 14.84초. targeted.xml에 기록했다.

전체 `scripts/verify_stage5.py`를 다시 실행했지만 이번 Codex 환경에서는 WinError 10013으로 localhost 사전 검사에서 차단됐다. **pytest_started=false**, 종료 코드 1이다. `data/measured/stage5-tests-20261021T135900Z-4f83f7c5/summary.json`에 기록했다. 사용자 환경의 사전 검사 성공과 구분한다.

단독 27개도 실제 재실행을 시도했다. 기본 TEMP에서는 sandbox Temp에 pytest 디렉터리를 생성할 수 없어 **1 passed, 26 setup errors**였다. 쓰기 가능한 별도 basetemp로 모든 27개를 다시 시도했으나 첫 비동기 취소 테스트에서 진행하지 못해 120초 제한에 도달했다. 그 중간 로그에는 checkpoint 검사 FAILED 1건도 있었고, 해당 검사만 다시 실행하면 통과했다. 중단된 실행의 실패 상세 traceback은 생성되지 않아 그 추가 실패 원인은 확정하지 않는다. 이 시도를 27개 통과로 계산하지 않았다. timeout 정리의 taskkill 뒤 wait도 제한 시간에 도달했으며, 명령 종료 후 Get-Process 조회에는 Python 프로세스가 나타나지 않았다. 이 조회는 실제 실험 프로세스에 대한 전역 감사나 needs_audit 해제 근거로 사용하지 않는다.

추가 동기 진단은 **26 passed, 4 deselected**, 70.35초, 종료 코드 0이었다. 기존 복구 테스트의 동기 23개와 신규 3개만 선택한 진단 실행이며, 전체 27개 또는 전체 회귀 통과를 뜻하지 않는다. 중간 시도에서 실패 표시가 있었던 checkpoint 검사도 이 재실행에서 통과했다. 비동기 4개는 여전히 미검증이다. synchronous-final.txt/xml에 원시 결과를 보존했다. 현재 전체 수집 수는 신규 3개를 포함한 **327개**이며, 전체 통과는 로컬에서 다시 확인해야 한다. 기존 테스트에 skip/xfail 표시는 추가하지 않았다.

최종 `protected-final.json` 검사에서 원본 4,091개 파일, 기존 후속 계획 5개 파일의 내용 해시가 감사 전과 동일했다. owner 바이트도 동일하며 needs_audit다. 원래 398개 완료 체크포인트, t398 체크포인트 부재, 후속 완료 0개를 확인했다. 기존 프로토콜 Python 파일, 원본 계획의 엔진 소스 맵, 기존 manifest가 지정한 복구 도구 해시 모두 일치했다. 기존 계획 재생성·재서명은 하지 않았다.

## Windows PowerShell 재검증

실험 실행 명령은 포함하지 않는다. 프로젝트 루트에서 실행하며 새 basetemp는 테스트 전용이다. pytest는 이 경로를 초기화하므로 원본/후속 실험 디렉터리를 basetemp로 지정하지 않는다.

```powershell
$env:PYTHONUTF8 = '1'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

# 기존 복구 27개 + 새 경로 회귀 3개. 임시 fixture/모의 runner만 사용
.\.venv\Scripts\python.exe -m pytest tests/test_recovery_v3.py tests/test_stage5_runner_paths.py -v --basetemp "data/measured/rp-$stamp"

# 실제 테스트용 HTTP/WS/TCP를 포함한 전체 327개 검증
.\.venv\Scripts\python.exe scripts/verify_stage5.py

# 기존 후속 계획 읽기 전용 확인. 노드 실행/잠금 해제 없음
.\.venv\Scripts\python.exe scripts/recovery_v3.py dry-run data/measured/v3-tail-6d329cd9-20261021
```

전체 검증이 통과해도 실험을 시작하지 않는다. 실제 셀 실행 및 needs_audit 해제는 여전히 사용자 승인을 기다린다.
