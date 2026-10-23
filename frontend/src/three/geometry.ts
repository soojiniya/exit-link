import * as THREE from 'three';
import { layout, toWorld, type Rect, type WallSpec } from '@/domain/layout';

/** 박스 하나: 월드 좌표 중심과 크기 */
export interface Box { p: [number, number, number]; s: [number, number, number] }

export type WallMat = 'wall' | 'wallExterior' | 'glass' | 'frame' | 'wallTop';

const T = { exterior: 0.3, partition: 0.14, glass: 0.06 } as const;

/** 평면 축 정렬 벽 구간을 월드 박스로 */
function along(w: WallSpec, u0: number, u1: number, y0: number, y1: number, t: number): Box {
  const vertical = w.a[0] === w.b[0]; // x 고정, z 방향
  const len = u1 - u0;
  const mid = (u0 + u1) / 2;
  const [wx, wz] = vertical ? toWorld([w.a[0], mid]) : toWorld([mid, w.a[1]]);
  return { p: [wx, (y0 + y1) / 2, wz], s: vertical ? [t, y1 - y0, len] : [len, y1 - y0, t] };
}

/** 벽 사양 → 재질별 박스 목록. 개구부(문·비상구)는 floor별로 적용합니다. */
export function buildWall(w: WallSpec, floor: number, H: number): Record<WallMat, Box[]> {
  const out: Record<WallMat, Box[]> = { wall: [], wallExterior: [], glass: [], frame: [], wallTop: [] };
  const vertical = w.a[0] === w.b[0];
  const ext = w.kind === 'exterior';
  const t = T[w.kind];
  let s0 = vertical ? Math.min(w.a[1], w.b[1]) : Math.min(w.a[0], w.b[0]);
  let s1 = vertical ? Math.max(w.a[1], w.b[1]) : Math.max(w.a[0], w.b[0]);
  if (ext) {
    s0 -= t / 2;
    s1 += t / 2;
  }
  const openings = w.openings
    .filter((o) => !o.floors || o.floors.includes(floor))
    .map((o) => [o.at - o.width / 2, o.at + o.width / 2, o.place_id ? 1 : 0] as const)
    .sort((a, b) => a[0] - b[0]);
  const solids: [number, number][] = [];
  let cur = s0;
  for (const [o0, o1, isExit] of openings) {
    if (o0 > cur) solids.push([cur, o0]);
    // 실내 문 위 인방(lintel). 절단 높이가 문 높이보다 높을 때만.
    if (!isExit && H > 2.25 && w.kind !== 'glass') out.wall.push(along(w, o0, o1, 2.1, H, t));
    cur = o1;
  }
  if (cur < s1) solids.push([cur, s1]);

  for (const [u0, u1] of solids) {
    const len = u1 - u0;
    if (len < 0.02) continue;
    if (w.kind === 'glass') {
      out.frame.push(along(w, u0, u1, 0, 0.12, t * 2));
      out.glass.push(along(w, u0, u1, 0.12, H - 0.06, t));
      out.frame.push(along(w, u0, u1, H - 0.06, H, t * 2));
      const n = Math.max(1, Math.round(len / 1.5));
      for (let i = 0; i <= n; i++) {
        const u = u0 + (len * i) / n;
        out.frame.push(along(w, Math.max(u0, u - 0.03), Math.min(u1, u + 0.03), 0.12, H - 0.06, t * 2));
      }
    } else if (ext && w.windows && H > 1.6 && len > 1.6) {
      const sill = 0.9;
      const head = H - 0.28;
      out.wallExterior.push(along(w, u0, u1, 0, sill, t));
      out.wallExterior.push(along(w, u0, u1, head, H, t));
      const n = Math.max(1, Math.round(len / 3));
      const bay = len / n;
      const pier = 0.45;
      for (let i = 0; i <= n; i++) {
        const u = u0 + bay * i;
        const a = Math.max(u0, u - pier / 2);
        const b = Math.min(u1, u + pier / 2);
        out.wallExterior.push(along(w, a, b, sill, head, t));
        if (i < n) out.glass.push(along(w, u + pier / 2, u + bay - pier / 2, sill, head, 0.05));
      }
    } else {
      out[ext ? 'wallExterior' : 'wall'].push(along(w, u0, u1, 0, H, t));
    }
  }
  return out;
}

export function rectBox(r: Rect, y0: number, y1: number, inset = 0): Box {
  const [x0, z0, x1, z1] = r;
  const [cx, cz] = toWorld([(x0 + x1) / 2, (z0 + z1) / 2]);
  return { p: [cx, (y0 + y1) / 2, cz], s: [x1 - x0 - inset * 2, y1 - y0, z1 - z0 - inset * 2] };
}

// ── 장식용 가구(시각화 전용, 데이터 아님) ─────────────────────────────
export type FurnMat = 'desk' | 'deskDark' | 'chair' | 'screen' | 'sofa' | 'plant' | 'pot';

export function furnish(r: Rect, kind: 'office' | 'meeting' | 'lounge'): Record<FurnMat, Box[]> {
  const out: Record<FurnMat, Box[]> = { desk: [], deskDark: [], chair: [], screen: [], sofa: [], plant: [], pot: [] };
  const [x0, z0, x1, z1] = r;
  const P = (x: number, y: number, z: number): [number, number, number] => {
    const [wx, wz] = toWorld([x, z]);
    return [wx, y, wz];
  };
  const plant = (x: number, z: number) => {
    out.pot.push({ p: P(x, 0.2, z), s: [0.45, 0.4, 0.45] });
    out.plant.push({ p: P(x, 0.75, z), s: [0.6, 0.7, 0.6] });
  };
  if (kind === 'office') {
    const w = x1 - x0;
    const d = z1 - z0;
    const cols = Math.max(1, Math.floor((w - 1.4) / 2.6));
    const rows = Math.max(1, Math.floor((d - 1.6) / 2.8));
    const gx = (w - (cols - 1) * 2.6) / 2;
    const gz = (d - (rows - 1) * 2.8) / 2;
    for (let i = 0; i < cols; i++)
      for (let j = 0; j < rows; j++) {
        const cx = x0 + gx + i * 2.6;
        const cz = z0 + gz + j * 2.8;
        for (const side of [-1, 1]) {
          out.desk.push({ p: P(cx, 0.37, cz + side * 0.36), s: [1.5, 0.74, 0.7] });
          out.screen.push({ p: P(cx, 0.95, cz + side * 0.12), s: [0.6, 0.36, 0.05] });
          out.chair.push({ p: P(cx, 0.24, cz + side * 1.05), s: [0.55, 0.48, 0.55] });
          out.chair.push({ p: P(cx, 0.75, cz + side * 1.3), s: [0.55, 0.6, 0.08] });
        }
      }
    plant(x1 - 0.55, z0 + 0.55);
  } else if (kind === 'meeting') {
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    const L = x1 - x0 - 2.6;
    out.desk.push({ p: P(cx, 0.37, cz), s: [L, 0.74, 1.5] });
    const n = Math.floor(L / 0.95);
    for (let i = 0; i < n; i++) {
      const x = cx - L / 2 + 0.5 + i * (L - 1) / Math.max(1, n - 1);
      out.chair.push({ p: P(x, 0.24, cz - 1.15), s: [0.5, 0.48, 0.5] });
      out.chair.push({ p: P(x, 0.24, cz + 1.15), s: [0.5, 0.48, 0.5] });
    }
    out.screen.push({ p: P(x0 + 0.25, 1.3, cz), s: [0.06, 0.9, 1.8] });
    plant(x1 - 0.55, z1 - 0.55);
  } else {
    const cz = (z0 + z1) / 2;
    out.sofa.push({ p: P(x0 + 1.0, 0.3, cz), s: [0.85, 0.6, 3.0] });
    out.sofa.push({ p: P(x1 - 1.0, 0.3, cz), s: [0.85, 0.6, 3.0] });
    out.deskDark.push({ p: P((x0 + x1) / 2, 0.22, cz), s: [1.6, 0.44, 1.0] });
    out.chair.push({ p: P((x0 + x1) / 2, 0.24, z1 - 1.1), s: [0.7, 0.48, 0.7] });
    plant(x0 + 0.55, z1 - 0.55);
    plant(x1 - 0.55, z1 - 0.55);
  }
  return out;
}

// ── 계단(장식 형상: 계단실 안에서 반층까지 오르는 두 줄 계단) ────────────────
export function stairSteps(r: Rect, H: number): Box[] {
  const [x0, z0, x1, z1] = r;
  const xm = (x0 + x1) / 2;
  const run0 = z0 + 2.3;
  const run1 = z1 - 1.6;
  const n = 11;
  const depth = (run1 - run0) / n;
  const rise = 1.8 / n;
  const out: Box[] = [];
  const P = (x: number, z: number) => toWorld([x, z]);
  for (let i = 0; i < n; i++) {
    const h = Math.min(H, (i + 1) * rise);
    const z = run0 + depth * (i + 0.5);
    const [ax, az] = P((x0 + 0.45 + xm - 0.12) / 2, z);
    out.push({ p: [ax, h / 2, az], s: [xm - 0.12 - x0 - 0.45, h, depth] });
  }
  // 반층 계단참
  const lh = Math.min(H, 1.8);
  const [lx, lz] = P((x0 + x1) / 2, (run1 + z1 - 0.3) / 2);
  out.push({ p: [lx, lh / 2, lz], s: [x1 - x0 - 0.9, lh, z1 - 0.3 - run1] });
  for (let i = 0; i < n; i++) {
    const h = 1.8 + (n - i) * rise;
    if (h > H) continue;
    const z = run0 + depth * (i + 0.5);
    const [bx, bz] = P((xm + 0.12 + x1 - 0.45) / 2, z);
    out.push({ p: [bx, h / 2, bz], s: [x1 - 0.45 - xm - 0.12, h, depth] });
  }
  return out;
}

export function stairDivider(r: Rect, H: number): Box {
  const [x0, z0, x1, z1] = r;
  const [wx, wz] = toWorld([(x0 + x1) / 2, (z0 + 2.3 + z1 - 1.6) / 2]);
  return { p: [wx, H / 2, wz], s: [0.1, H, z1 - 1.6 - z0 - 2.3] };
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
export function fillInstances(mesh: THREE.InstancedMesh, boxes: Box[]) {
  boxes.forEach((b, i) => {
    _m.compose(_v.set(...b.p), _q, _s.set(...b.s));
    mesh.setMatrixAt(i, _m);
  });
  mesh.count = boxes.length;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
}

export const plate = layout.plate;
