import type { HazardUpdate } from '@contracts';

/**
 * 백엔드 저장소 src/exit_link/data/simulation/disaster_scenario.json(가상 시나리오)의 입력값을 그대로 옮긴 프리셋입니다.
 * 결과(경로·전송)는 프리셋에 없으며 항상 실제 API 응답으로만 표시합니다.
 */
export const WEST_STAIR_FIRE = {
  name: '가상 서쪽 계단 화재 및 출구 차단',
  source: 'disaster_scenario.json',
  starts: ['F3_W', 'F2_E'],
  steps: [
    { label: '1단계 · F2_SW 화재', hazards: { fire_locations: ['F2_SW'], dangerous_nodes: [], blocked_nodes: [], blocked_passages: [] } },
    { label: '2단계 · 두 출구 차단', hazards: { fire_locations: ['F2_SW'], dangerous_nodes: [], blocked_nodes: ['EXIT_W', 'EXIT_E'], blocked_passages: [] } },
  ] satisfies { label: string; hazards: HazardUpdate }[],
};
