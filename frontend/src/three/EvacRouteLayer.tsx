import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html, Line } from '@react-three/drei';
import * as THREE from 'three';
import type { Place, WsEvacuationPlan } from '@contracts';
import { useGeo, placePoint } from './sceneContext';

type V3 = [number, number, number];

// 진행 방향(+Z)을 가리키는 납작한 삼각 화살표
const chevronGeo = new THREE.ConeGeometry(0.32, 0.7, 3).rotateX(Math.PI / 2).scale(1, 0.35, 1);

function useRoutePoints(path: string[], places: Map<string, Place>) {
  const geo = useGeo();
  return useMemo(() => {
    const pts: V3[] = [];
    for (const id of path) {
      const p = places.get(id);
      const v = p && placePoint(id, p.floor, geo, 0.14);
      if (v) pts.push(v);
    }
    return pts;
  }, [path, places, geo]);
}

function Chevrons({ pts, color }: { pts: V3[]; color: string }) {
  const curve = useMemo(() => new THREE.CurvePath<THREE.Vector3>(), []);
  useMemo(() => {
    curve.curves.length = 0;
    for (let i = 0; i < pts.length - 1; i++) curve.add(new THREE.LineCurve3(new THREE.Vector3(...pts[i]), new THREE.Vector3(...pts[i + 1])));
  }, [pts, curve]);
  const len = useMemo(() => (pts.length > 1 ? curve.getLength() : 0), [curve, pts]);
  const count = Math.max(2, Math.floor(len / 2.6));
  const group = useRef<THREE.Group>(null);
  const tmp = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ clock }) => {
    if (!group.current || len === 0) return;
    const t0 = (clock.elapsedTime * 1.4) / len;
    group.current.children.forEach((c, i) => {
      const u = (t0 + i / count) % 1;
      const p = curve.getPointAt(u);
      const tan = curve.getTangentAt(u, tmp);
      c.position.copy(p);
      c.rotation.set(0, Math.atan2(tan.x, tan.z), 0);
    });
  });
  if (pts.length < 2) return null;
  return (
    <group ref={group}>
      {Array.from({ length: count }, (_, i) => (
        <mesh key={i} renderOrder={5} geometry={chevronGeo}>
          <meshBasicMaterial color={color} transparent opacity={0.95} depthTest={false} />
        </mesh>
      ))}
    </group>
  );
}

function PlanPath({ plan, places, highlighted }: { plan: WsEvacuationPlan; places: Map<string, Place>; highlighted: boolean }) {
  const geo = useGeo();
  const pts = useRoutePoints(plan.path, places);
  const dashed = useRef<{ material: { dashOffset: number } } | null>(null);
  useFrame((_, dt) => {
    if (dashed.current) dashed.current.material.dashOffset -= dt * 1.6;
  });
  const startPlace = places.get(plan.start_location);
  const start = startPlace ? placePoint(plan.start_location, startPlace.floor, geo, 0.14) : null;

  if (plan.status === 'no_route') {
    return start ? <NoRouteMarker at={start} plan={plan} /> : null;
  }
  if (pts.length < 2) return null;
  const end = pts.at(-1)!;
  const c = '#4CC38A';
  return (
    <group>
      <Line points={pts} color={c} lineWidth={highlighted ? 7 : 5} transparent opacity={0.35} depthTest={false} renderOrder={4} />
      <Line
        ref={dashed as never}
        points={pts}
        color="#9BE3BE"
        lineWidth={highlighted ? 3 : 2}
        dashed
        dashSize={0.7}
        gapSize={0.5}
        depthTest={false}
        renderOrder={5}
      />
      <Chevrons pts={pts} color={c} />
      {start && (
        <Html position={[start[0], start[1] + 0.6, start[2]]} center zIndexRange={[18, 10]} style={{ pointerEvents: 'none' }}>
          <div className="whitespace-nowrap rounded-full border border-ok/60 bg-[#16181Bdd] px-2 py-0.5 font-mono text-[10px] text-[#73C9A0]">
            출발 {plan.start_location}
          </div>
        </Html>
      )}
      <Html position={[end[0], end[1] + 1.1, end[2]]} center zIndexRange={[18, 10]} style={{ pointerEvents: 'none' }}>
        <div className="whitespace-nowrap rounded-md bg-ok px-1.5 py-0.5 text-[10px] font-semibold text-[#0f1a14]">
          {plan.exit_id} · {plan.distance_m}m
        </div>
      </Html>
    </group>
  );
}

function NoRouteMarker({ at, plan }: { at: V3; plan: WsEvacuationPlan }) {
  const ring = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (ring.current) {
      const s = 1 + 0.35 * Math.sin(clock.elapsedTime * 4);
      ring.current.scale.set(s, s, s);
    }
  });
  return (
    <group position={at}>
      <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]} renderOrder={6}>
        <ringGeometry args={[0.7, 0.95, 32]} />
        <meshBasicMaterial color="#E5484D" transparent opacity={0.9} depthTest={false} />
      </mesh>
      <Html position={[0, 0.9, 0]} center zIndexRange={[18, 10]} style={{ pointerEvents: 'none' }}>
        <div className="whitespace-nowrap rounded-md border border-fail bg-[#2a1517ee] px-1.5 py-0.5 text-[10px] font-semibold text-[#F2878A]">
          경로 없음 · {plan.start_location}
        </div>
      </Html>
    </group>
  );
}

export function EvacRouteLayer({ plans, places, highlight }: { plans: WsEvacuationPlan[]; places: Map<string, Place>; highlight?: string | null }) {
  return (
    <group>
      {plans.map((p) => (
        <PlanPath key={`${p.scenario_id}-${p.start_location}`} plan={p} places={places} highlighted={highlight === p.start_location} />
      ))}
    </group>
  );
}
