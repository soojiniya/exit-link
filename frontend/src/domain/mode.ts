/**
 * 공개 데모(VITE_DEMO_MODE=1) 여부. 공개 데모는 저장된 기록을 보여 주는 읽기 전용 환경입니다.
 * 쓰기 요청 차단은 api/client.ts, 화면 구성은 pages/SimulationLab.tsx가 이 값을 사용합니다.
 */
let publicDemo = (import.meta.env?.VITE_DEMO_MODE as string | undefined) === '1';

export const isPublicDemo = () => publicDemo;

/** 단위 테스트 전용: 빌드 환경 변수 없이 공개/로컬 모드를 전환합니다. */
export const setPublicDemoForTest = (value: boolean) => {
  publicDemo = value;
};

/** 공개 데모에서 쓰기 관련 버튼·문구 대신 보여 주는 읽기 전용 안내(토큰을 요구하는 문구를 쓰지 않습니다). */
export const PUBLIC_READONLY_HINT = '공개 화면은 읽기 전용입니다 — 제어 요청을 보내지 않습니다';
