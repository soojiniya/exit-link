/** 백엔드 오류 코드(docs/stage-5-api-guide.md, api/runtime.py) → 운영자용 설명 */
const HINT: Record<string, string> = {
  token_missing: '제어 토큰이 없습니다. 상단의 읽기 전용 버튼에서 토큰을 입력하세요.',
  public_read_only: '공개 데모는 읽기 전용입니다. 실험 제어는 로컬 실험 환경에서만 가능하며, 저장된 실험 기록은 REPLAY에서 확인할 수 있습니다.',
  write_unauthorized: '토큰이 없거나 서버 토큰과 다릅니다(403).',
  local_only: '로컬 접속(127.0.0.1/localhost, 허용 Origin)만 제어할 수 있습니다(403).',
  experiments_disabled: '서버를 EXIT_LINK_ENABLE_EXPERIMENTS=1로 실행해야 실험을 제어할 수 있습니다(403).',
  experiment_exists: '이미 실행 중인 실험이 있습니다. 먼저 종료하세요(409).',
  experiment_not_running: '실행 중인 실험이 없습니다(409).',
  node_state_conflict: '노드가 이미 요청한 상태입니다(409).',
  node_not_found: '실험이 소유한 노드가 아닙니다(404).',
  delivery_in_progress: '진행 중인 안내 전송이 끝난 뒤 다시 시도하세요(409).',
  delivery_limit: '동시 안내 전송은 8개까지입니다(429).',
  revision_conflict: '다른 변경이 먼저 반영되었습니다. 최신 시나리오를 다시 불러왔으니 확인 후 다시 적용하세요(409).',
  scenario_limit: '시나리오 한도(서버 세션당 32개 또는 이벤트 2048개)에 도달했습니다(409).',
  scenario_not_found: '시나리오가 없습니다. 서버가 재시작되었을 수 있습니다(404).',
  invalid_nodes: '발신·수신 노드는 서로 다른 실제 노드여야 합니다(422).',
  invalid_domain_input: '건물에 없는 위치이거나 허용되지 않는 입력입니다(422).',
  invalid_request: '요청 형식이 계약과 다릅니다(422).',
  experiment_start_failed: '노드 프로세스 시작에 실패했습니다(503).',
  node_control_failed: '노드 프로세스 제어에 실패했습니다(503).',
  experiment_cleanup_failed: '실험 정리에 실패했습니다(503). 남은 프로세스를 확인하세요.',
  network_error: '백엔드에 연결할 수 없습니다. 서버 실행 여부를 확인하세요.',
};

export function explainError(code: string, message: string) {
  // A bind conflict alone does not identify the owner or prove delayed OS release.
  const port = /address already in use|Errno 98|10048/i.test(message) ? ' 바인딩 충돌입니다. 응답의 PID·포트 진단과 실제 점유 상태를 확인하세요.' : '';
  return HINT[code] ? `${HINT[code]}${port} — ${message}` : `${message}${port}`;
}
