import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { layout, toWorld, PLATE_W, PLATE_D } from '@/domain/layout';
import { M } from './materials';
import { buildWall, fillInstances, furnish, rectBox, stairDivider, stairSteps, type Box, type FurnMat, type WallMat } from './geometry';

const unitBox = new THREE.BoxGeometry(1, 1, 1);
/** 슬래브 윗면 윤곽(림) — 모든 층이 같은 지오메트리를 재사용합니다. */
const slabRim = (() => {
  const w = (PLATE_W + 0.3) / 2;
  const d = (PLATE_D + 0.3) / 2;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-w, 0, -d, w, 0, -d, w, 0, -d, w, 0, d, w, 0, d, -w, 0, d, -w, 0, d, -w, 0, -d], 3));
  return g;
})();

export function BoxInstances({ boxes, material, cast = true, receive = true }: { boxes: Box[]; material: THREE.Material; cast?: boolean; receive?: boolean }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const cap = Math.max(1, boxes.length);
  useLayoutEffect(() => {
    if (ref.current) fillInstances(ref.current, boxes);
  }, [boxes]);
  return <instancedMesh key={cap} ref={ref} args={[unitBox, material, cap]} castShadow={cast} receiveShadow={receive} frustumCulled={false} />;
}

function mergeRecords<K extends string>(list: Record<K, Box[]>[]): Record<K, Box[]> {
  const out = {} as Record<K, Box[]>;
  for (const r of list) for (const k of Object.keys(r) as K[]) (out[k] ??= []).push(...r[k]);
  return out;
}

const WALL_MAT: Record<WallMat, THREE.Material> = { wall: M.wall, wallExterior: M.wallExterior, glass: M.glass, frame: M.frame, wallTop: M.wallTop };
const FURN_MAT: Record<FurnMat, THREE.Material> = { desk: M.desk, deskDark: M.deskDark, chair: M.chair, screen: M.screen, sofa: M.sofa, plant: M.plant, pot: M.pot };

export interface FloorProps {
  floor: number;
  /** 벽 절단 높이 */
  H: number;
  ghost?: boolean;
  furniture?: boolean;
  /** 비상구 상태: 실제 HazardUpdate.blocked_nodes 기준 */
  blockedExits?: Set<string>;
}

/** 한 층의 건축 모형. 바닥·복도·계단실은 building.json 위치와 연결되고, 사무실·가구는 장식(시각화 전용)입니다. */
export function FloorModel({ floor, H, ghost = false, furniture = true, blockedExits }: FloorProps) {
  const walls = useMemo(() => mergeRecords(layout.walls.map((w) => buildWall(w, floor, H))), [floor, H]);
  const furn = useMemo(() => mergeRecords(layout.decor_rooms.map((r) => furnish(r.rect, r.furnish))), []);
  const stairs = useMemo(() => layout.stair_cores.flatMap((c) => stairSteps(c.rect, H)), [H]);
  const dividers = useMemo(() => layout.stair_cores.map((c) => stairDivider(c.rect, H)), [H]);
  const floors = useMemo(
    () => ({
      corridor: [rectBox(layout.corridor.rect, 0, 0.03)],
      room: layout.decor_rooms.map((r) => rectBox(r.rect, 0, 0.02)),
      stair: layout.stair_cores.map((c) => rectBox(c.rect, 0, 0.025)),
    }),
    [],
  );

  if (ghost) {
    const all = [...walls.wall, ...walls.wallExterior, ...walls.glass, ...walls.frame];
    return (
      <group>
        <mesh position={[0, -0.15, 0]} material={M.ghostSlab}>
          <boxGeometry args={[PLATE_W, 0.3, PLATE_D]} />
        </mesh>
        <BoxInstances boxes={all} material={M.ghost} cast={false} receive={false} />
      </group>
    );
  }

  return (
    <group>
      {/* 슬래브 */}
      <mesh position={[0, -0.18, 0]} receiveShadow castShadow material={M.slab}>
        <boxGeometry args={[PLATE_W + 0.3, 0.36, PLATE_D + 0.3]} />
      </mesh>
      <lineSegments geometry={slabRim} material={M.rimEdge} position={[0, 0.005, 0]} renderOrder={2} />
      <BoxInstances boxes={floors.room} material={M.room} cast={false} />
      <BoxInstances boxes={floors.corridor} material={M.corridor} cast={false} />
      <BoxInstances boxes={floors.stair} material={M.stairFloor} cast={false} />
      {(Object.keys(walls) as WallMat[]).map((k) => (
        <BoxInstances key={k} boxes={walls[k]} material={WALL_MAT[k]} cast={k !== 'glass'} />
      ))}
      <BoxInstances boxes={stairs} material={M.step} />
      <BoxInstances boxes={dividers} material={M.wall} />
      {furniture && (Object.keys(furn) as FurnMat[]).map((k) => <BoxInstances key={k} boxes={furn[k]} material={FURN_MAT[k]} />)}
      {floor === 1 && <ExitPortals H={H} blocked={blockedExits} />}
    </group>
  );
}

/** 1층 외부 비상구: building.json의 EXIT_W / EXIT_E 위치 */
function ExitPortals({ H, blocked }: { H: number; blocked?: Set<string> }) {
  return (
    <>
      {layout.walls.flatMap((w) =>
        w.openings
          .filter((o) => o.place_id)
          .map((o) => {
            const id = o.place_id!;
            const isBlocked = blocked?.has(id) ?? false;
            const vertical = w.a[0] === w.b[0];
            const [wx, wz] = vertical ? toWorld([w.a[0], o.at]) : toWorld([o.at, w.a[1]]);
            const out = Math.sign(wx) || 1; // 바깥 방향(x)
            const signY = Math.min(H, 2.3) + 0.25;
            return (
              <group key={id} position={[wx, 0, wz]}>
                {/* 바깥 출입 데크 */}
                <mesh position={[out * 1.1, -0.1, 0]} receiveShadow material={M.sidewalk}>
                  <boxGeometry args={[2.2, 0.2, o.width + 1.2]} />
                </mesh>
                {/* 비상구 표지 */}
                <mesh position={[out * 0.22, signY, 0]} material={isBlocked ? M.exitSignBlocked : M.exitSign}>
                  <boxGeometry args={[0.08, 0.34, 1.0]} />
                </mesh>
                <pointLight position={[out * 0.8, 1.2, 0]} color={isBlocked ? '#E5484D' : '#3FB27F'} intensity={6} distance={4.5} decay={2} />
                {/* 문턱 발광선 */}
                <mesh position={[0, 0.04, 0]} rotation={[-Math.PI / 2, 0, 0]}>
                  <planeGeometry args={[0.35, o.width]} />
                  <meshBasicMaterial color={isBlocked ? '#E5484D' : '#3FB27F'} transparent opacity={0.85} />
                </mesh>
              </group>
            );
          }),
      )}
    </>
  );
}

/** 대지·나무(장식) */
export function Site() {
  const trees = useMemo(
    () => [
      [-21.5, -11.5], [-23, -4], [-22, 8.5], [21.5, -11.5], [23, -3.5], [22.5, 11.5], [-8, -13.2], [9, 13.4],
    ] as [number, number][],
    [],
  );
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.42, 0]} receiveShadow material={M.ground}>
        <planeGeometry args={[260, 260]} />
      </mesh>
      <mesh position={[0, -0.39, 0]} receiveShadow material={M.site}>
        <boxGeometry args={[PLATE_W + 22, 0.06, PLATE_D + 12]} />
      </mesh>
      <mesh position={[0, -0.35, 0]} receiveShadow material={M.sidewalk}>
        <boxGeometry args={[PLATE_W + 6, 0.06, PLATE_D + 4]} />
      </mesh>
      {trees.map(([x, z], i) => (
        <group key={i} position={[x, -0.36, z]}>
          <mesh position={[0, 0.5, 0]} castShadow material={M.trunk}>
            <cylinderGeometry args={[0.1, 0.14, 1, 6]} />
          </mesh>
          <mesh position={[0, 1.9, 0]} castShadow material={M.tree}>
            <icosahedronGeometry args={[1.05 + (i % 3) * 0.15, 0]} />
          </mesh>
        </group>
      ))}
    </group>
  );
}
