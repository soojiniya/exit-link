/**
 * building-layout.json(시각화용 가상 배치) ↔ 백엔드 건물 이동 그래프 대조.
 * 앱(로딩 시 /api/v1/building과 대조)과 `npm run verify:layout`(저장소 JSON과 대조)이 같은 규칙을 씁니다.
 * 이 모듈은 경로 별칭을 쓰지 않아 Node(tsx)에서도 바로 실행됩니다.
 */

export interface GraphPlace { id: string; floor: number; kind: 'corridor' | 'stair' | 'exit'; label?: string }
export interface GraphEdge { source: string; target: string; kind: 'corridor' | 'stairs' | 'exit_access'; distance_m: number }
export interface GraphBuilding { building_id: string; floors: number[]; nodes: GraphPlace[]; edges: GraphEdge[] }
export interface GraphTopologyNode { id: string; location_id: string }

type V2 = [number, number];
type R = [number, number, number, number];
export interface LayoutLike {
  building_id: string;
  layout_origin: string;
  plate: { min: V2; max: V2 };
  places: Record<string, { position: V2; footprint: R }>;
  corridor: { rect: R };
  stair_cores: { suffix: string; rect: R }[];
  walls: { id: string; kind: string; a: V2; b: V2; openings: { at: number; width: number; floors?: number[]; place_id?: string }[] }[];
}

export interface CheckItem { group: string; name: string; ok: boolean; detail: string }
export interface LayoutReport { ok: boolean; items: CheckItem[]; passed: number; failed: number }

const EPS = 0.01;
const inRect = (p: V2, r: R, tol = EPS) => p[0] >= r[0] - tol && p[0] <= r[2] + tol && p[1] >= r[1] - tol && p[1] <= r[3] + tol;
const dist = (a: V2, b: V2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** 축 정렬 벽(a–b)과 선분(p–q)의 교점 좌표(벽 방향 성분). 교차하지 않으면 null. 끝점이 벽 위에 놓인 경우(비상구)도 교차로 봅니다. */
function crossAt(p: V2, q: V2, a: V2, b: V2): number | null {
  const vertical = a[0] === b[0];
  if (vertical) {
    const x = a[0];
    if ((p[0] - x) * (q[0] - x) > EPS * EPS || p[0] === q[0]) return null;
    const t = (x - p[0]) / (q[0] - p[0]);
    const z = p[1] + t * (q[1] - p[1]);
    return z >= Math.min(a[1], b[1]) - EPS && z <= Math.max(a[1], b[1]) + EPS ? z : null;
  }
  const z = a[1];
  if ((p[1] - z) * (q[1] - z) > EPS * EPS || p[1] === q[1]) return null;
  const t = (z - p[1]) / (q[1] - p[1]);
  const x = p[0] + t * (q[0] - p[0]);
  return x >= Math.min(a[0], b[0]) - EPS && x <= Math.max(a[0], b[0]) + EPS ? x : null;
}

export function verifyLayout(b: GraphBuilding, l: LayoutLike, topology?: GraphTopologyNode[]): LayoutReport {
  const items: CheckItem[] = [];
  const add = (group: string, name: string, ok: boolean, detail: string) => items.push({ group, name, ok, detail });
  const places = new Map(b.nodes.map((n) => [n.id, n]));

  add('기본', 'building_id', b.building_id === l.building_id, `API ${b.building_id} / 배치 ${l.building_id}`);
  add('기본', '가상 배치 표시', l.layout_origin === 'design_assumption', `layout_origin=${l.layout_origin}`);

  // 위치 ID 일치
  const missing = b.nodes.filter((n) => !l.places[n.id]).map((n) => n.id);
  const extra = Object.keys(l.places).filter((id) => !places.has(id));
  add('위치', `위치 ID ${b.nodes.length}개 대응`, !missing.length && !extra.length, missing.length || extra.length ? `배치 없음: ${missing.join(', ') || '-'} / 그래프에 없음: ${extra.join(', ') || '-'}` : '모두 일치');

  for (const n of b.nodes) {
    const p = l.places[n.id];
    if (!p) continue;
    const inPlate = n.kind === 'exit' || inRect(p.position, [l.plate.min[0], l.plate.min[1], l.plate.max[0], l.plate.max[1]]);
    let zoneOk = inRect(p.position, p.footprint);
    let zone = '';
    if (n.kind === 'corridor') {
      zoneOk &&= inRect(p.position, l.corridor.rect);
      zone = '복도 영역 안';
    } else if (n.kind === 'stair') {
      const core = l.stair_cores.find((c) => n.id.endsWith(`_${c.suffix}`));
      zoneOk &&= !!core && inRect(p.position, core.rect);
      zone = core ? `계단실 ${core.suffix} 안` : '대응 계단실 없음';
    } else {
      const door = l.walls.flatMap((w) => w.openings.map((o) => ({ w, o }))).find(({ o }) => o.place_id === n.id);
      zoneOk &&= !!door && (!door.o.floors || door.o.floors.includes(n.floor));
      zone = door ? `외벽 ${door.w.id} 개구부(${n.floor}층)` : '외벽 개구부 없음';
    }
    add('위치', n.id, inPlate && zoneOk, `(${p.position.join(', ')}) · ${zone}`);
  }

  // 이동 연결
  for (const e of b.edges) {
    const A = l.places[e.source];
    const B = l.places[e.target];
    const fa = places.get(e.source)?.floor;
    const fb = places.get(e.target)?.floor;
    const name = `${e.source}–${e.target}`;
    if (!A || !B || fa === undefined || fb === undefined) {
      add('연결', name, false, '배치 좌표 없음');
      continue;
    }
    if (e.kind === 'stairs') {
      const same = dist(A.position, B.position) < EPS;
      add('연결', name, same && Math.abs(fa - fb) === 1, `계단 ${e.distance_m}m · ${fa}층↔${fb}층 · 평면 위치 ${same ? '동일(수직 연결)' : '불일치'}`);
      continue;
    }
    const d = dist(A.position, B.position);
    const distOk = Math.abs(d - e.distance_m) <= 0.05;
    // 벽 통과 여부: 개구부(해당 층)로만 지나가야 합니다.
    const blocked: string[] = [];
    for (const w of l.walls) {
      const at = crossAt(A.position, B.position, w.a, w.b);
      if (at === null) continue;
      const through = w.openings.some((o) => (!o.floors || o.floors.includes(fa)) && at >= o.at - o.width / 2 - EPS && at <= o.at + o.width / 2 + EPS);
      if (!through) blocked.push(w.id);
    }
    add('연결', name, distOk && !blocked.length, `가정 ${e.distance_m}m / 배치 ${d.toFixed(2)}m${blocked.length ? ` · 벽 관통: ${blocked.join(', ')}` : ' · 벽 관통 없음'}`);
  }

  if (topology) {
    for (const t of topology) add('통신 노드', `${t.id} → ${t.location_id}`, !!l.places[t.location_id] && places.has(t.location_id), places.get(t.location_id)?.label ?? '위치 없음');
  }

  const failed = items.filter((i) => !i.ok).length;
  return { ok: failed === 0, items, passed: items.length - failed, failed };
}
