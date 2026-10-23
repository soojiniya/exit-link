import type { BuildingView, Place, WalkEdge } from '@contracts';
import rawLayout from '@/data/building-layout.json';
import { verifyLayout, type GraphTopologyNode, type LayoutReport } from './layoutCheck';

/**
 * 3D 시각화 전용 배치(building-layout.json) 타입과 검증.
 * 배치는 백엔드 building.json의 위치 ID만 참조하며 새 위치·연결을 만들지 않습니다.
 */
export type Rect = [number, number, number, number]; // [x0, z0, x1, z1] in m_assumed
export type Vec2 = [number, number];

export interface LayoutPlace { position: Vec2; footprint: Rect }
export interface WallOpening { at: number; width: number; floors?: number[]; place_id?: string }
export interface WallSpec { id: string; kind: 'exterior' | 'partition' | 'glass'; a: Vec2; b: Vec2; windows?: boolean; openings: WallOpening[] }
export interface StairCoreSpec { suffix: 'SW' | 'SE'; rect: Rect; door: { axis: 'x'; at: number; z: number; width: number } }
export interface DecorRoom { id: string; label: string; rect: Rect; furnish: 'office' | 'meeting' | 'lounge' }

export interface BuildingLayout {
  schema_version: string;
  building_id: string;
  layout_origin: 'design_assumption';
  status: string;
  description: string;
  unit: 'm_assumed';
  floor_height: number;
  plate: { min: Vec2; max: Vec2 };
  places: Record<string, LayoutPlace>;
  corridor: { rect: Rect };
  stair_cores: StairCoreSpec[];
  walls: WallSpec[];
  decor_rooms: DecorRoom[];
}

export const layout = rawLayout as unknown as BuildingLayout;

/** 실제 /building 응답과 배치 파일을 대조합니다. 하나라도 어긋나면 3D 대신 오류를 표시합니다. */
export function checkLayout(view: BuildingView, l: BuildingLayout = layout, topology?: GraphTopologyNode[]): LayoutReport {
  return verifyLayout(view.building, l, topology);
}

// ── 좌표 변환 ───────────────────────────────────────────────
const cx = (layout.plate.min[0] + layout.plate.max[0]) / 2;
const cz = (layout.plate.min[1] + layout.plate.max[1]) / 2;
export const PLATE_W = layout.plate.max[0] - layout.plate.min[0];
export const PLATE_D = layout.plate.max[1] - layout.plate.min[1];

/** 평면 좌표(m_assumed) → 3D 월드 좌표. 건물 중심이 원점입니다. */
export const toWorld = (p: Vec2): [number, number] => [p[0] - cx, p[1] - cz];
export const rectCenter = (r: Rect): [number, number] => toWorld([(r[0] + r[2]) / 2, (r[1] + r[3]) / 2]);
export const rectSize = (r: Rect): [number, number] => [r[2] - r[0], r[3] - r[1]];

export function placeWorld(id: string): [number, number] | null {
  const p = layout.places[id];
  return p ? toWorld(p.position) : null;
}

export type PlaceIndex = Map<string, Place>;
export const indexPlaces = (view: BuildingView): PlaceIndex => new Map(view.building.nodes.map((n) => [n.id, n]));

export function edgeKey(a: string, b: string) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
export const indexEdges = (view: BuildingView) => new Map<string, WalkEdge>(view.building.edges.map((e) => [edgeKey(e.source, e.target), e]));
