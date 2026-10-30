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
