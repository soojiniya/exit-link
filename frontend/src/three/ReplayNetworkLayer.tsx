import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html, Line } from '@react-three/drei';
import * as THREE from 'three';
import type { Place } from '@contracts';
import type { LinkState, NodeState } from '@/domain/network';
import type { MessageStage, ReplayLeg, ReplayMarker } from '@/domain/replayEngine';
import type { Pulse } from '@/ui/replay/cinematicDirector';
import { NodeBeacon, linkCurve } from './NetworkLayer';
import { placePoint, prefersReducedMotion, useGeo } from './sceneContext';

/**
 * Digital Twin · REPLAY 통신 레이어.
 * - 노드 위치: LIVE NetworkLayer 와 같은 변환(location_id → building-layout.json 평면 좌표, 층 → geo.yOf, 높이 geo.nodeLift).
 * - 링크 곡선: LIVE 와 같은 linkCurve. 다른 층 사이 링크는 실제 높이 차를 따라 올라갑니다.
 * - 상태·구간·마커는 모두 공통 재생 엔진(domain/replayEngine)이 기록에서 계산한 값을 그대로 그립니다.
 * - 마커의 곡선 위 위치는 시각적 보간입니다(기록된 송신·수신 이벤트 사이). 실제 측정된 연속 위치가 아닙니다.
 * - 경로 위 빛 흐름은 선택 메시지가 실제 전송 구간(sending·waiting·delivered)일 때만, 재생 중일 때만 움직입니다.
 *   ACK 뒤에는 고정된 경로로, 실패 뒤에는 흐린 빨간 점선으로 바뀌고 이동 효과를 멈춥니다.
 * - 펄스(ACK·장애·도착)와 경로 전환 빛은 기록된 이벤트 시각부터 정해진 기록 시간 동안만 나타납니다.
 */
const BLUE = '#7CC8FF';
const GREEN = '#3FB27F';
const ORANGE = '#E08A3C';
const RED = '#E5484D';
const LINK_COLOR = { ok: GREEN, warn: ORANGE, fail: RED, unknown: '#6B727C' } as const;
const FLOWING: MessageStage[] = ['sending', 'waiting', 'delivered'];

export interface TwinReplayOverlay {
  topology: { nodes: { id: string; location_id: string }[]; edges: [string, string][] };
  nodes: NodeState[];
  links: LinkState[];
  /** 선택 메시지의 현재 시도 경로·직전 시도 경로·제외 링크·구간 */
  route: string[] | null;
  previousRoute: string[] | null;
  excludedLinks: [string, string][];
  legs: ReplayLeg[];
  /** 메시지 마커(엔진 계산값) + 표시용 라벨 */
  markers: (ReplayMarker & { label: string; selected: boolean })[];
  selectedNode: string | null;
  onSelectNode: (id: string) => void;
  /** 기록 시각에 맞춘 짧은 강조(ACK 수신·장애 확인·목적지 도착), 진행률 0~1 */
  pulses?: Pulse[];
  /** 선택 메시지 단계(엔진 해석값) — 경로 표현(흐름·고정·실패)을 정합니다 */
  stage?: MessageStage;
  /** 재생 중인지(일시정지면 모든 반복 움직임을 멈춤) */
  playing?: boolean;
  /** route_changed 기록 직후 새 경로를 따라 흐르는 빛(경로 강조) */
  sweep?: { route: string[]; progress: number } | null;
}

// ── 공용 자원(한 번만 생성해 재사용) ──
let glowTex: THREE.Texture | null = null;
function glowTexture() {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.3, 'rgba(255,255,255,0.32)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}
const coneGeo = new THREE.ConeGeometry(0.15, 0.38, 12);
const chevronGeo = new THREE.ConeGeometry(0.12, 0.3, 3);
const ringGeo = new THREE.RingGeometry(0.55, 0.68, 48);
const thinRingGeo = new THREE.RingGeometry(0.62, 0.68, 48);
const discGeo = new THREE.CircleGeometry(0.6, 40);
const UP = new THREE.Vector3(0, 1, 0);

function Glow({ color, size, opacity = 0.55 }: { color: string; size: number; opacity?: number }) {
  return (
    <sprite scale={[size, size, size]} renderOrder={9}>
      <spriteMaterial map={glowTexture()} color={color} transparent opacity={opacity} depthTest={false} depthWrite={false} blending={THREE.AdditiveBlending} />
    </sprite>
  );
}

export function ReplayNetworkLayer({ overlay, places, cinematic = false }: { overlay: TwinReplayOverlay; places: Map<string, Place>; cinematic?: boolean }) {
  const geo = useGeo();
  const { topology, nodes, links, route, previousRoute, excludedLinks, legs, markers } = overlay;
  const stage = overlay.stage;
  const playing = !!overlay.playing;
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
    for (const [a, b] of topology.edges) {
      const pa = pos.get(a);
      const pb = pos.get(b);
      if (pa && pb) {
        m.set(`${a}|${b}`, linkCurve(pa, pb));
        m.set(`${b}|${a}`, linkCurve(pb, pa));
      }
    }
    return m;
  }, [topology, pos]);
  const onRoute = (r: string[] | null, a: string, b: string) => {
    if (!r) return false;
    for (let i = 0; i < r.length - 1; i++) if ((r[i] === a && r[i + 1] === b) || (r[i] === b && r[i + 1] === a)) return true;
    return false;
  };
  /** 경로 방향 그대로의 구간 곡선 목록 */
  const routeCurves = (r: string[] | null) => {
    const out: { a: string; b: string; c: THREE.QuadraticBezierCurve3 }[] = [];
    if (!r) return out;
    for (let i = 0; i < r.length - 1; i++) {
      const c = curves.get(`${r[i]}|${r[i + 1]}`);
      if (c) out.push({ a: r[i], b: r[i + 1], c });
    }
    return out;
  };
  const bypassed = new Set((previousRoute ?? []).filter((n) => !(route ?? []).includes(n)));
  /** 곡선 위 일부 구간 점(노드 원통에 가리지 않도록 양끝 8% 제외), lift 는 ACK 구간을 살짝 위로 띄움 */
  const segPoints = (c: THREE.Curve<THREE.Vector3>, lift = 0) =>
    Array.from({ length: 25 }, (_, i) => c.getPointAt(0.08 + (0.84 * i) / 24).add(new THREE.Vector3(0, lift, 0)));

  const failed = stage === 'failed';
  const acked = stage === 'acked';
  const flowing = !!stage && FLOWING.includes(stage);
  const sweep = overlay.sweep ?? null;
  const prevOpacity = sweep ? 0.9 - 0.55 * sweep.progress : cinematic ? 0.35 : 0.5;

  // 마커 라벨 겹침 방지: 같은 화면 근처(1.3 이내)에 먼저 놓인 마커가 있으면 라벨을 한 칸 위로
  const stacks = useMemo(() => {
    const placed: THREE.Vector3[] = [];
    const out = new Map<string, number>();
    for (const m of [...markers].sort((x, y) => Number(y.selected) - Number(x.selected) || x.position - y.position)) {
      const c = curves.get(`${m.from}|${m.to}`);
      if (!c) continue;
      const moving = m.kind === 'transit' || m.kind === 'ack';
      const p = c.getPointAt(moving ? 0.08 + m.frac * 0.84 : 0.14);
      const n = placed.filter((q) => q.distanceTo(p) < 1.3).length;
      out.set(m.messageId, n);
      placed.push(p);
    }
    return out;
  }, [markers, curves]);

  return (
    <group>
      {/* 논리 링크(기록된 이웃 판정 색, 기록 없음은 회색 점선) */}
      {links.map((l) => {
        const c = curves.get(`${l.a}|${l.b}`);
        if (!c) return null;
        const em = Math.max(geo.emphasis(floorOf(l.a)), geo.emphasis(floorOf(l.b)));
        return (
          <Line
            key={`${l.a}-${l.b}`}
            points={c.getPoints(28)}
            color={LINK_COLOR[l.status]}
            lineWidth={l.status === 'fail' ? 2.2 : 1.4}
            transparent
            opacity={(l.status === 'unknown' ? 0.28 : 0.6) * (0.45 + 0.55 * em)}
            dashed={l.status !== 'ok'}
            dashSize={0.35}
            gapSize={0.25}
          />
        );
      })}

      {/* 직전 시도 경로(기록된 route_changed 가 있을 때만): 전환 순간 또렷 → 점점 물러남 */}
      {topology.edges.filter(([a, b]) => onRoute(previousRoute, a, b) && !onRoute(route, a, b)).map(([a, b]) => {
        const c = curves.get(`${a}|${b}`);
        return c ? <Line key={`prev-${a}-${b}`} points={c.getPoints(28)} color={RED} lineWidth={2.4} dashed dashSize={0.28} gapSize={0.22} transparent opacity={prevOpacity} depthTest={false} renderOrder={6} /> : null;
      })}

      {/* 현재 시도 경로: 전송 중=빛 흐름 · ACK 뒤=고정 · 실패=흐린 빨간 점선 · 그 밖(연결 시도·대기)=흐린 점선 */}
      {routeCurves(route).map(({ a, b, c }) => {
        const key = `route-${a}-${b}`;
        if (failed) return <Line key={key} points={c.getPoints(28)} color={RED} lineWidth={1.8} dashed dashSize={0.22} gapSize={0.22} transparent opacity={0.45} depthTest={false} renderOrder={6} />;
        const crossFloor = floorOf(a) !== floorOf(b);
        return (
          <group key={key}>
            <Line points={c.getPoints(28)} color={BLUE} lineWidth={acked ? 2.4 : 1.6} transparent opacity={acked ? 0.75 : flowing ? 0.45 : 0.35} dashed={!acked && !flowing} dashSize={0.3} gapSize={0.24} depthTest={false} renderOrder={6} />
            {flowing && <FlowLine curve={c} strong={cinematic} playing={playing} />}
            {(acked || flowing) && [0.32, 0.58].map((u) => <Chevron key={u} curve={c} u={u} color={acked ? '#BFE4FF' : BLUE} />)}
            {crossFloor && (
              <Html position={c.getPointAt(0.5).add(new THREE.Vector3(0, 0.35, 0)).toArray()} center zIndexRange={[24, 14]} style={{ pointerEvents: 'none' }}>
                <div data-twin-floor-change={`${a}>${b}`} className="whitespace-nowrap rounded-full border border-[#7CC8FF]/50 bg-[#0a1420]/85 px-1.5 py-[1px] font-mono text-[10px] text-[#BFE4FF]">
                  {floorOf(a)}F {floorOf(b) > floorOf(a) ? '↑' : '↓'} {floorOf(b)}F
                </div>
              </Html>
            )}
          </group>
        );
      })}

      {/* 경로 전환 순간의 빛(경로 강조 — 메시지 이동 표시가 아님) */}
      {sweep && <RouteSweep segments={routeCurves(sweep.route).map((x) => x.c)} progress={sweep.progress} />}

      {/* 기록된 구간 */}
      {legs.map((leg, i) => {
        const c = curves.get(`${leg.from}|${leg.to}`);
        if (!c) return null;
        const col = leg.state === 'failed' ? RED : leg.kind === 'ack' ? GREEN : leg.state === 'connecting' ? ORANGE : BLUE;
        const dashed = leg.state !== 'done';
        return (
          <group key={`leg-${i}`} userData={{ replayLeg: `${leg.kind}:${leg.from}>${leg.to}:${leg.state}` }}>
            <Line points={segPoints(c, leg.kind === 'ack' ? 0.32 : 0)} color={col} lineWidth={leg.state === 'done' ? 4.2 : 3.4} dashed={dashed} dashSize={0.26} gapSize={0.18} transparent opacity={0.95} depthTest={false} renderOrder={8} />
            <Arrow curve={c} color={col} lift={leg.kind === 'ack' ? 0.32 : 0} />
          </group>
        );
      })}
      {/* 기록된 제외 링크 */}
      {excludedLinks.map(([a, b]) => {
        const c = curves.get(`${a}|${b}`);
        if (!c) return null;
        return (
          <Html key={`x-${a}-${b}`} position={c.getPointAt(0.5).toArray()} center zIndexRange={[25, 15]} style={{ pointerEvents: 'none' }}>
            <div data-twin-replay-excluded={`${a}-${b}`} className="flex items-center gap-1 whitespace-nowrap rounded-full border border-[#E5484D]/70 bg-[#1a0d10]/90 px-1.5 py-[1px] font-mono text-[10px] text-[#FF9EA1]">✕ 제외 {a}-{b}</div>
          </Html>
        );
      })}

      {/* 기록 시각에 맞춘 짧은 강조 */}
      {(overlay.pulses ?? []).map((p) => {
        const at = pos.get(p.node);
        return at ? <PulseFx key={`${p.kind}-${p.node}`} at={at} kind={p.kind} progress={p.progress} /> : null;
      })}

      {/* 메시지 마커 */}
      {markers.map((m) => {
        const c = curves.get(`${m.from}|${m.to}`);
        return c ? <MessageMarker key={m.messageId} curve={c} marker={m} stack={stacks.get(m.messageId) ?? 0} playing={playing} /> : null;
      })}

      {/* 노드(LIVE 와 같은 NodeBeacon, 재생에서는 상태 링을 고정 표시) */}
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
            selected={overlay.selectedNode === n.id}
            inRoute={!!route?.includes(n.id)}
            bypassed={bypassed.has(n.id)}
            onSelect={overlay.onSelectNode}
            steady
          />
        );
      })}
    </group>
  );
}

/** 현재 경로 위를 흐르는 빛(점선 오프셋 이동). 일시정지·움직임 줄이기에서는 멈춥니다. */
function FlowLine({ curve, strong, playing }: { curve: THREE.Curve<THREE.Vector3>; strong: boolean; playing: boolean }) {
  const ref = useRef<{ material: THREE.Material & { dashOffset: number } } | null>(null);
  const pts = useMemo(() => curve.getPoints(40), [curve]);
  const still = useMemo(prefersReducedMotion, []);
  useFrame((_, dt) => {
    const m = ref.current?.material;
    if (m && !still && playing) m.dashOffset -= dt * (strong ? 1.5 : 1.1);
  });
  return (
    <Line
      ref={ref as never}
      points={pts}
      color="#D6F1FF"
      lineWidth={strong ? 3 : 2.2}
      dashed
      dashSize={0.5}
      gapSize={1.6}
      transparent
      opacity={strong ? 0.9 : 0.7}
      depthTest={false}
      renderOrder={7}
    />
  );
}

/** 경로 전환 빛: 새 경로 시작점부터 끝까지 짧은 광선이 한 번 지나갑니다(progress 는 기록 시간 기준). */
function RouteSweep({ segments, progress }: { segments: THREE.Curve<THREE.Vector3>[]; progress: number }) {
  const path = useMemo(() => {
    const cp = new THREE.CurvePath<THREE.Vector3>();
    segments.forEach((c) => cp.add(c));
    return cp;
  }, [segments]);
  if (!segments.length) return null;
  const head = Math.min(1, progress * 1.15);
  const tail = Math.max(0, head - 0.22);
  const pts = Array.from({ length: 16 }, (_, i) => path.getPointAt(tail + ((head - tail) * i) / 15));
  const fade = 1 - Math.max(0, (progress - 0.8) / 0.2);
  return (
    <group userData={{ twinRouteSweep: true }}>
      <Line points={pts} color="#EAF8FF" lineWidth={5} transparent opacity={0.9 * fade} depthTest={false} renderOrder={12} />
      <group position={pts[pts.length - 1]}>
        <Glow color="#BFE4FF" size={1.6} opacity={0.75 * fade} />
      </group>
    </group>
  );
}

/** 바닥에 퍼지는 링(기록 시각 기준 진행률). 장애는 두 겹 파동, ACK 는 초록 링 + 짧은 라벨, 도착은 작은 파랑 링 */
function PulseFx({ at, kind, progress }: { at: THREE.Vector3; kind: Pulse['kind']; progress: number }) {
  const color = kind === 'ack' ? GREEN : kind === 'fault' ? RED : BLUE;
  const ring = (p: number, scale: number, alpha: number, k: number) =>
    p >= 0 && p <= 1 ? (
      <mesh key={k} geometry={k ? thinRingGeo : ringGeo} rotation={[-Math.PI / 2, 0, 0]} scale={0.6 + p * scale} renderOrder={11}>
        <meshBasicMaterial color={color} transparent opacity={alpha * (1 - p)} depthTest={false} side={THREE.DoubleSide} />
      </mesh>
    ) : null;
  return (
    <group position={at} userData={{ twinPulse: kind }}>
      {kind === 'fault' && (
        <>
          {ring(Math.min(1, progress / 0.6), 2.4, 0.9, 0)}
          {ring((progress - 0.3) / 0.7, 2.8, 0.6, 1)}
          <mesh geometry={discGeo} rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} renderOrder={10}>
            <meshBasicMaterial color={RED} transparent opacity={0.22 * (1 - progress)} depthTest={false} side={THREE.DoubleSide} />
          </mesh>
          <Glow color={RED} size={2.2} opacity={0.45 * (1 - progress)} />
        </>
      )}
      {kind === 'ack' && (
        <>
          {ring(progress, 1.5, 0.85, 0)}
          <Glow color={GREEN} size={1.8} opacity={0.5 * (1 - progress)} />
          {progress < 0.85 && (
            <Html position={[0, 1.05, 0]} center zIndexRange={[45, 35]} style={{ pointerEvents: 'none' }}>
              <div data-twin-replay-pulse="ack" className="whitespace-nowrap rounded-full border border-[#3FB27F]/70 bg-[#0b1a13]/90 px-2 py-[1px] font-mono text-[11px] text-[#8FE6BE]" style={{ opacity: 1 - progress }}>ACK ✓</div>
            </Html>
          )}
        </>
      )}
      {kind === 'arrive' && ring(progress, 1.0, 0.7, 1)}
    </group>
  );
}

function Arrow({ curve, color, lift }: { curve: THREE.Curve<THREE.Vector3>; color: string; lift: number }) {
  const { at, quat } = useMemo(() => {
    const at = curve.getPointAt(0.86).add(new THREE.Vector3(0, lift, 0));
    const dir = curve.getTangentAt(0.86).normalize();
    return { at, quat: new THREE.Quaternion().setFromUnitVectors(UP, dir) };
  }, [curve, lift]);
  return (
    <mesh geometry={coneGeo} position={at} quaternion={quat} renderOrder={9}>
      <meshBasicMaterial color={color} depthTest={false} />
    </mesh>
  );
}

/** 경로 방향 표시(작은 삼각 화살표) */
function Chevron({ curve, u, color }: { curve: THREE.Curve<THREE.Vector3>; u: number; color: string }) {
  const { at, quat } = useMemo(() => {
    const at = curve.getPointAt(u);
    return { at, quat: new THREE.Quaternion().setFromUnitVectors(UP, curve.getTangentAt(u).normalize()) };
  }, [curve, u]);
  return (
    <mesh geometry={chevronGeo} position={at} quaternion={quat} renderOrder={8}>
      <meshBasicMaterial color={color} transparent opacity={0.85} depthTest={false} />
    </mesh>
  );
}

const TRAIL = [0.035, 0.07, 0.105];
/**
 * 마커: 엔진이 정한 곡선·비율로 이동. 화면에서는 곡선 위 비율을 부드럽게 따라갑니다(시각 효과).
 * 이동 중(transit·ack)에는 뒤쪽에 짧은 꼬리를 그려 방향을 보여 줍니다. 대기·연결 시도는 정지 표시.
 */
function MessageMarker({ curve, marker, stack, playing }: { curve: THREE.Curve<THREE.Vector3>; marker: ReplayMarker & { label: string; selected: boolean }; stack: number; playing: boolean }) {
  const ref = useRef<THREE.Group>(null);
  const ring = useRef<THREE.Mesh>(null);
  const trail = useRef<(THREE.Mesh | null)[]>([]);
  const uRef = useRef<{ curve: THREE.Curve<THREE.Vector3> | null; u: number }>({ curve: null, u: 0 });
  const clock = useRef(0);
  const moving = marker.kind === 'transit' || marker.kind === 'ack';
  const target = moving ? 0.08 + marker.frac * 0.84 : 0.14;
  const lift = marker.kind === 'ack' ? 0.32 : 0;
  const color = marker.kind === 'ack' ? GREEN : marker.kind === 'connecting' ? ORANGE : BLUE;
  const still = useMemo(prefersReducedMotion, []);
  const tmp = useMemo(() => new THREE.Vector3(), []);
  useFrame((_, dt) => {
    const g = ref.current;
    if (!g) return;
    const st = uRef.current;
    if (st.curve !== curve || still) st.u = target;
    else st.u += (target - st.u) * (1 - Math.exp(-dt * 14));
    st.curve = curve;
    curve.getPointAt(THREE.MathUtils.clamp(st.u, 0, 1), tmp);
    g.position.set(tmp.x, tmp.y + lift, tmp.z);
    trail.current.forEach((m, i) => {
      if (!m) return;
      const u = st.u - TRAIL[i];
      m.visible = moving && u > 0.06;
      if (m.visible) {
        curve.getPointAt(u, tmp);
        m.position.set(tmp.x - g.position.x, tmp.y + lift - g.position.y, tmp.z - g.position.z);
      }
    });
    if (playing && !still) clock.current += dt;
    if (ring.current) {
      const k = marker.kind === 'connecting' ? 0.5 + 0.5 * Math.sin(clock.current * 6) : 0;
      ring.current.scale.setScalar(1 + k * 0.8);
      (ring.current.material as THREE.MeshBasicMaterial).opacity = marker.kind === 'connecting' ? 0.6 * (1 - k * 0.6) : 0;
    }
  });
  const r = marker.selected ? 0.26 : 0.2;
  return (
    <group ref={ref} userData={{ replayMarker: `${marker.label}:${marker.kind}:${marker.from}>${marker.to}` }}>
      <mesh renderOrder={10}>
        <sphereGeometry args={[r, 18, 18]} />
        <meshBasicMaterial color={color} depthTest={false} transparent opacity={marker.selected ? 1 : 0.8} />
      </mesh>
      <Glow color={color} size={marker.selected ? 1.4 : 1.05} opacity={marker.selected ? 0.6 : 0.4} />
      {TRAIL.map((_, i) => (
        <mesh key={i} ref={(m) => (trail.current[i] = m)} renderOrder={9} visible={false}>
          <sphereGeometry args={[r * (0.75 - i * 0.18), 10, 10]} />
          <meshBasicMaterial color={color} depthTest={false} transparent opacity={0.5 - i * 0.14} />
        </mesh>
      ))}
      <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]} renderOrder={10}>
        <ringGeometry args={[0.32, 0.42, 28]} />
        <meshBasicMaterial color={color} transparent opacity={0} depthTest={false} side={THREE.DoubleSide} />
      </mesh>
      <Html position={[0, 0.5 + stack * 0.42, 0]} center zIndexRange={[40, 30]} style={{ pointerEvents: 'none' }}>
        <div
          data-twin-replay-marker={`${marker.label}:${marker.kind}:${marker.from}>${marker.to}`}
          className={marker.selected ? 'whitespace-nowrap rounded-md border px-1.5 py-[1px] font-mono text-[11px] font-semibold' : 'whitespace-nowrap rounded-md border px-1 font-mono text-[10px]'}
          style={{ color, borderColor: `${color}88`, background: 'rgba(10,14,20,0.88)', opacity: marker.selected ? 1 : 0.72 }}
        >
          {marker.label}
          {marker.kind === 'waiting' ? ' 중계 대기' : marker.kind === 'connecting' ? ' 연결 시도' : ''}
        </div>
      </Html>
    </group>
  );
}
