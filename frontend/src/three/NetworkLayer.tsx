import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html, Line } from '@react-three/drei';
import * as THREE from 'three';
import type { Place, WsCommunicationTopology } from '@contracts';
import { NODE_STATUS_LABEL, STATUS_COLOR, type LinkState, type MessageFlow, type NodeState } from '@/domain/network';
import { useGeo, placePoint } from './sceneContext';

const LINK_COLOR = { ok: '#3FB27F', warn: '#E08A3C', fail: '#E5484D', unknown: '#6B727C' } as const;
const ACTION = '#7CC8FF';

/** 노드 사이 통신 링크 곡선(같은 층은 위로 볼록, 층간은 높이 차를 따라). REPLAY 레이어도 같은 곡선을 씁니다. */
export function linkCurve(a: THREE.Vector3, b: THREE.Vector3) {
  const mid = a.clone().add(b).multiplyScalar(0.5);
  const sameLevel = Math.abs(a.y - b.y) < 0.01;
  mid.y += sameLevel ? 1.1 + a.distanceTo(b) * 0.03 : 0.6;
  return new THREE.QuadraticBezierCurve3(a, mid, b);
}

export interface NetworkLayerProps {
  topology: WsCommunicationTopology;
  nodes: NodeState[];
  links: LinkState[];
  places: Map<string, Place>;
  flow: MessageFlow | null;
  selected: string | null;
  onSelect: (id: string) => void;
}

export function NetworkLayer({ topology, nodes, links, places, flow, selected, onSelect }: NetworkLayerProps) {
  const geo = useGeo();
  const pos = useMemo(() => {
    const m = new Map<string, THREE.Vector3>();
    for (const n of topology.nodes) {
      const p = places.get(n.location_id);
      const v = p && placePoint(n.location_id, p.floor, geo, geo.nodeLift);
      if (v) m.set(n.id, new THREE.Vector3(...v));
    }
    return m;
  }, [topology, places, geo]);
  const floorOf = (id: string) => places.get(topology.nodes.find((n) => n.id === id)?.location_id ?? '')?.floor ?? 1;

  const curves = useMemo(() => {
    const m = new Map<string, THREE.QuadraticBezierCurve3>();
    for (const e of topology.edges) {
      const a = pos.get(e.source);
      const b = pos.get(e.target);
      if (a && b) {
        m.set(`${e.source}|${e.target}`, linkCurve(a, b));
        m.set(`${e.target}|${e.source}`, linkCurve(b, a));
      }
    }
    return m;
  }, [topology, pos]);

  const routeEdges = (r: string[] | null | undefined) => {
    const out: THREE.Curve<THREE.Vector3>[] = [];
    if (!r) return out;
    for (let i = 0; i < r.length - 1; i++) {
      const c = curves.get(`${r[i]}|${r[i + 1]}`);
      if (c) out.push(c);
    }
    return out;
  };
  const active = routeEdges(flow?.route);
  const prev = routeEdges(flow?.previousRoute);
  const bypassed = new Set((flow?.previousRoute ?? []).filter((n) => !(flow?.route ?? []).includes(n)));

  return (
    <group>
      {/* 논리 링크 */}
      {links.map((l) => {
        const c = curves.get(`${l.a}|${l.b}`);
        if (!c) return null;
        const pts = c.getPoints(28);
        const col = LINK_COLOR[l.status];
        const em = Math.max(geo.emphasis(floorOf(l.a)), geo.emphasis(floorOf(l.b)));
        return (
          <Line
            key={`${l.a}-${l.b}`}
            points={pts}
            color={col}
            lineWidth={l.status === 'fail' ? 2.2 : 1.6}
            transparent
            opacity={(l.status === 'unknown' ? 0.35 : 0.7) * (0.45 + 0.55 * em)}
            dashed={l.status === 'fail' || l.status === 'unknown'}
            dashSize={0.35}
            gapSize={0.25}
          />
        );
      })}

      {/* 경로 전환 전 경로(빨간 점선) */}
      {prev.map((c, i) => (
        <Line key={`p${i}`} points={c.getPoints(28)} color="#E5484D" lineWidth={3} dashed dashSize={0.3} gapSize={0.22} transparent opacity={0.9} depthTest={false} renderOrder={7} />
      ))}
      {/* 현재 메시지 경로(노란색) */}
      {active.map((c, i) => (
        <Line key={`a${i}`} points={c.getPoints(28)} color={ACTION} lineWidth={4.5} transparent opacity={0.95} depthTest={false} renderOrder={8} />
      ))}
      {flow && active.length > 0 && <Packet curves={active} flow={flow} />}

      {/* 노드 */}
      {nodes.map((n) => {
        const p = pos.get(n.id);
        if (!p) return null;
        const f = floorOf(n.id);
        return (
          <NodeBeacon
            key={n.id}
            node={n}
            at={p}
            floorY={geo.yOf(f)}
            floorLabel={`${f}F`}
            emphasis={geo.emphasis(f)}
            selected={selected === n.id}
            inRoute={!!flow?.route.includes(n.id)}
            bypassed={bypassed.has(n.id)}
            onSelect={onSelect}
          />
        );
      })}
    </group>
  );
}

export function NodeBeacon({
  node, at, floorY, emphasis, selected, inRoute, bypassed, onSelect, floorLabel, steady = false,
}: {
  floorLabel: string; node: NodeState; at: THREE.Vector3; floorY: number; emphasis: number; selected: boolean; inRoute: boolean; bypassed: boolean; onSelect: (id: string) => void;
  /** REPLAY 전용: 상태 링을 반복 맥동 대신 고정 표시(기록에 없는 반복 효과를 만들지 않음). LIVE 는 기본값(false) 그대로. */
  steady?: boolean;
}) {
  const halo = useRef<THREE.Mesh>(null);
  const color = STATUS_COLOR[node.status];
  const alarming = node.status === 'fail' || node.status === 'warn' || node.status === 'recovering';
  useFrame(({ clock }) => {
    if (!halo.current) return;
    const k = alarming && !steady ? 0.5 + 0.5 * Math.sin(clock.elapsedTime * (node.status === 'fail' ? 5 : 3)) : 0;
    const s = steady && alarming ? 1.2 : 1 + k * 0.6;
    halo.current.scale.set(s, s, s);
    (halo.current.material as THREE.MeshBasicMaterial).opacity = alarming ? 0.45 * (1 - k * 0.6) : selected ? 0.35 : 0;
  });
  const pin = useMemo(() => [new THREE.Vector3(at.x, floorY + 0.05, at.z), at.clone().setY(at.y - 0.35)], [at, floorY]);
  return (
    <group>
      <Line points={pin} color={color} lineWidth={1} transparent opacity={0.5 * emphasis} />
      <mesh position={[at.x, floorY + 0.06, at.z]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.35, 0.5, 32]} />
        <meshBasicMaterial color={color} transparent opacity={0.7 * emphasis} />
      </mesh>
      <group position={at}>
        <mesh
          castShadow
          onClick={(e) => {
            e.stopPropagation();
            onSelect(node.id);
          }}
          onPointerOver={() => (document.body.style.cursor = 'pointer')}
          onPointerOut={() => (document.body.style.cursor = '')}
        >
          <cylinderGeometry args={[0.42, 0.42, 0.26, 28]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={node.status === 'offline' || node.status === 'unknown' ? 0.05 : 0.55} roughness={0.4} />
        </mesh>
        <mesh position={[0, 0.16, 0]}>
          <cylinderGeometry args={[0.24, 0.24, 0.06, 24]} />
          <meshStandardMaterial color="#1E2125" roughness={0.5} />
        </mesh>
        <mesh ref={halo} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.55, 0.72, 40]} />
          <meshBasicMaterial color={selected && !alarming ? '#E8EAED' : color} transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
        {(emphasis >= 1 || inRoute || selected || alarming) && (
        <Html position={[0, 0.75, 0]} center zIndexRange={[30, 20]} style={{ pointerEvents: 'none', opacity: emphasis >= 1 ? 1 : 0.7 }}>
          <div
            className="flex items-center gap-1.5 whitespace-nowrap rounded-md border px-1.5 py-[3px] shadow-lg"
            style={{ background: 'rgba(22,24,27,0.9)', borderColor: inRoute ? ACTION : selected ? '#E8EAED' : '#2F343A' }}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
            <span className="font-mono text-[11px] font-medium text-ink">{node.id}</span>
            {emphasis < 1 && <span className="font-mono text-[10px] text-ink-3">{floorLabel}</span>}
            <span className="text-[10px]" style={{ color: node.status === 'ok' ? '#A3A9B1' : color }}>
              {bypassed ? '우회됨' : NODE_STATUS_LABEL[node.status]}
            </span>
          </div>
        </Html>
        )}
      </group>
    </group>
  );
}

/** 메시지 패킷: 전송 중에는 노란 패킷이 경로를 따라 이동, ACK 수신 후에는 초록 패킷이 발신지로 귀환 */
function Packet({ curves, flow }: { curves: THREE.Curve<THREE.Vector3>[]; flow: MessageFlow }) {
  const ref = useRef<THREE.Mesh>(null);
  const mat = useRef<THREE.MeshBasicMaterial>(null);
  const path = useMemo(() => {
    const cp = new THREE.CurvePath<THREE.Vector3>();
    curves.forEach((c) => cp.add(c));
    return cp;
  }, [curves]);
  useFrame(({ clock }) => {
    if (!ref.current || !mat.current) return;
    const age = (Date.now() - Date.parse(flow.updatedAt)) / 1000;
    let u: number;
    let color = ACTION;
    let visible = true;
    if (flow.stage === 'acked') {
      // ACK 귀환 애니메이션을 몇 차례 보여준 뒤 멈춥니다.
      visible = age < 8;
      u = 1 - ((clock.elapsedTime * 0.6) % 1);
      color = '#3FB27F';
    } else if (flow.stage === 'failed') {
      u = 0.5;
      color = '#E5484D';
    } else {
      u = (clock.elapsedTime * 0.6) % 1;
    }
    ref.current.visible = visible;
    ref.current.position.copy(path.getPointAt(u));
    mat.current.color.set(color);
  });
  return (
    <mesh ref={ref} renderOrder={9}>
      <sphereGeometry args={[0.22, 16, 16]} />
      <meshBasicMaterial ref={mat} color={ACTION} depthTest={false} />
    </mesh>
  );
}
