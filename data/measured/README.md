# 실제 측정 데이터 전용

실제 프로세스의 실행 결과와 관측만 보관합니다. 가상 토폴로지 입력은 `src/exit_link/data/simulation/`에 있습니다.
향후 TCP 프로세스 실험 결과는 실행 ID, 수집 시각, 환경, 측정 방법, 입력 시나리오를 함께 기록합니다.
실험 결과는 기본적으로 Git에서 제외하며 검토한 자료만 별도 공개합니다.

`stage3-tests-*`는 실제 pytest/프로세스 로그, `stage3-experiment-*`는 실제 종료·복구 실험 결과입니다.
사전 검사에서 차단된 실행은 summary에만 그 사실을 기록하고 장애 성능값을 생성하지 않습니다.
`stage3-static-temp`는 검증용 임시 파일이며 실험 관측 데이터가 아닙니다.

`stage4-tests-*`/`stage4-experiment-*`는 대피 안내의 실제 TCP 검증입니다.
가상 재난 시나리오만 실행한 자료는 `data/simulation-runs/`에 별도로 보관합니다.

`stage5-tests-*`는 전체 pytest/사전 진단, `stage5-backend/`는 실제 HTTP·WebSocket·TCP 테스트 증거입니다.
그 아래 http-guidance.json, websocket-events.json, fault-recovery.json, no-route.json은 실제 실행 결과입니다.
owned-clusters/<실험ID>/에는 6개 프로세스의 원본 로그와 정리 결과 evidence.json이 있습니다.
일반 API 실행 시 소유 실험 자료는 `stage5/<실험ID>/`에 저장합니다.
stage5-api-*/stage5-initial-*/pytest-temp 등은 테스트용 임시 상태이며 센서·성능 실험 자료로 해석하지 않습니다.
