import { createContext, useContext } from 'react';
import type { FloorSel } from '@/store/types';
import { layout, placeWorld } from '@/domain/layout';

export interface SceneGeo {
  sel: FloorSel;
  /** 층 바닥 높이(월드 Y) */
  yOf: (floor: number) => number;
  /** 층 강조 정도: 선택 층 1, 그 외 0.35 */
  emphasis: (floor: number) => number;
  wallH: number;
  nodeLift: number;
}

export function makeGeo(sel: FloorSel): SceneGeo {
  if (sel === 'ALL') {
    return { sel, yOf: (f) => (f - 1) * 6.2, emphasis: () => 1, wallH: 1.15, nodeLift: 2.2 };
  }
  return {
    sel,
    yOf: (f) => (f - sel) * layout.floor_height,
    emphasis: (f) => (f === sel ? 1 : 0.35),
    wallH: 2.4,
    nodeLift: 3.15,
  };
}

export const GeoCtx = createContext<SceneGeo>(makeGeo(2));
export const useGeo = () => useContext(GeoCtx);

/** 위치 ID → 월드 좌표(바닥 위 h) */
export function placePoint(id: string, floor: number, geo: SceneGeo, h = 0.08): [number, number, number] | null {
  const w = placeWorld(id);
  return w ? [w[0], geo.yOf(floor) + h, w[1]] : null;
}

/** 화면 맞춤 연출 옵션(CINEMATIC 자동 카메라·발표자 버튼) */
export interface FrameOptions {
  /** 기본 아이소 방향에서 Y축 회전(rad) */
  azimuth?: number;
  /** 기본 방향에서 극각 변화(rad, +면 더 낮은 시선 → 높이 차가 잘 보임) */
  elevation?: number;
  /** 대상 주변 여유(월드 단위) */
  padding?: number;
  /** 맞춤 배율 상한(층 맞춤 배율의 몇 배까지 확대할지) */
  maxZoomMul?: number;
  /** 화면 가장자리 UI 가 덮는 영역(px) — 이 영역을 피해 가운데 맞춤 */
  insets?: { left: number; top: number; right: number; bottom: number };
  /** 이동 속도(감쇠 계수, 클수록 빠름) */
  rate?: number;
}

/** 캔버스 밖 버튼(확대/축소/아이소 복귀)·자동 연출이 카메라를 조작하기 위한 핸들 */
export const viewApi: {
  zoomBy: (f: number) => void;
  reset: () => void;
  focus: (p: [number, number, number]) => void;
  frame: (points: [number, number, number][], o?: FrameOptions) => void;
} = {
  zoomBy: () => undefined,
  reset: () => undefined,
  focus: () => undefined,
  frame: () => undefined,
};

/** 사용자가 움직임 줄이기를 설정했는지(카메라·연출 전환을 즉시 적용) */
export const prefersReducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
