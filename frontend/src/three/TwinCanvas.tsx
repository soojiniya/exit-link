import { useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { ContactShadows, OrbitControls, OrthographicCamera } from '@react-three/drei';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type { BuildingView, Place, WsCommunicationTopology, WsHazardUpdate, WsEvacuationPlan } from '@contracts';
import type { FloorSel } from '@/store/types';
import type { LinkState, MessageFlow, NodeState } from '@/domain/network';
import { FloorModel, Site } from './BuildingModel';
import { HazardLayer } from './HazardLayer';
import { EvacRouteLayer } from './EvacRouteLayer';
import { NetworkLayer } from './NetworkLayer';
import { ReplayNetworkLayer, type TwinReplayOverlay } from './ReplayNetworkLayer';
import { GeoCtx, makeGeo, placePoint, prefersReducedMotion, viewApi, type FrameOptions } from './sceneContext';
import { PLATE_D, PLATE_W } from '@/domain/layout';
import type { ShotStyle } from '@/ui/replay/cinematicDirector';

export interface Layers { hazards: boolean; evac: boolean; network: boolean; decor: boolean }

export interface TwinCanvasProps {
  building: BuildingView;
  floor: FloorSel;
  layers: Layers;
  hazards: WsHazardUpdate | null;
  plans: WsEvacuationPlan[];
  topology: WsCommunicationTopology | null;
  nodes: NodeState[];
  links: LinkState[];
  flow: MessageFlow | null;
  selectedNode: string | null;
  highlightStart: string | null;
  onSelectNode: (id: string | null) => void;
  /** REPLAY 모드 전용: 저장된 기록 재생 레이어. 넘기면 LIVE 통신 레이어 대신 그립니다(LIVE 에서는 넘기지 않음). */
  replay?: TwinReplayOverlay;
  /** 시연(CINEMATIC) 연출: 현재 경로 빛 흐름·이전 경로 약화 등을 조금 더 강하게 */
  cinematic?: boolean;
  /** 마우스 휠 확대 허용(시연 모드에서는 실수 방지를 위해 끔). 기본 true */
  wheelZoom?: boolean;
  /**
   * CINEMATIC 카메라 샷(자동 연출 또는 발표자 버튼). key 가 바뀔 때만 한 번 이동합니다.
   * 카메라만 움직이며 재생 시각·메시지 상태에는 관여하지 않습니다.
   */
  shot?: { key: string; style: ShotStyle; nodes: string[] } | null;
  /** 화면 가장자리 UI 가 덮는 영역(px). 샷을 이 영역 밖 가운데에 맞춥니다. */
  insets?: FrameOptions['insets'];
  /** 사용자가 직접 카메라를 조작(드래그 회전·이동)하면 호출 — 자동 연출이 우선권을 넘깁니다. */
  onUserCamera?: () => void;
}

/** 샷 종류별 구도: 아이소 기준 회전·높이·여유·확대 상한 */
const SHOT_FRAME: Record<ShotStyle, FrameOptions> = {
  overview: { azimuth: 0, elevation: 0, padding: 1.2, maxZoomMul: 1.05 },
  focus: { azimuth: -0.14, elevation: 0.04, padding: 3.2, maxZoomMul: 1.9 },
  fault: { azimuth: 0.16, elevation: -0.04, padding: 3.4, maxZoomMul: 2.1 },
  reroute: { azimuth: -0.42, elevation: 0.2, padding: 3.0, maxZoomMul: 1.9 },
  failed: { azimuth: 0.1, elevation: 0.08, padding: 3.2, maxZoomMul: 1.8 },
};
/** 자동 연출 이동 속도(감쇠 계수). 작을수록 느리고 부드럽게 멈춥니다. */
const SHOT_RATE = 2.3;


const ISO_DIR = new THREE.Vector3(-0.62, 0.86, 1).normalize();

function CameraRig({ floor, wheelZoom = true, onUserCamera }: { floor: FloorSel; wheelZoom?: boolean; onUserCamera?: () => void }) {
  const { camera, size } = useThree();
  const controls = useRef<OrbitControlsImpl>(null);
  const targetY = floor === 'ALL' ? 6.2 : 0;
  const fitZoom = useMemo(
    () => (floor === 'ALL' ? Math.min(size.width / 50, size.height / 44) : Math.min(size.width / 44, size.height / 31)),
    [floor, size.width, size.height],
  );
  const goal = useRef<{ zoom: number; target: THREE.Vector3; pos: THREE.Vector3; rate?: number } | null>(null);

  const reset = () => {
    const target = new THREE.Vector3(0, targetY, 0);
    goal.current = { zoom: fitZoom, target, pos: target.clone().add(ISO_DIR.clone().multiplyScalar(90)) };
  };
  useEffect(() => {
    viewApi.reset = reset;
    viewApi.zoomBy = (f: number) => {
      const cam = camera as THREE.OrthographicCamera;
      goal.current = { zoom: THREE.MathUtils.clamp(cam.zoom * f, 6, 120), target: controls.current!.target.clone(), pos: cam.position.clone() };
    };
    // 노드 선택 시: 현재 보는 방향은 유지한 채 노드 위치로 부드럽게 이동하고 조금 확대합니다.
    viewApi.focus = (p: [number, number, number]) => {
      const cam = camera as THREE.OrthographicCamera;
      const c = controls.current;
      if (!c) return;
      const target = new THREE.Vector3(...p);
      const offset = cam.position.clone().sub(c.target);
      goal.current = { zoom: THREE.MathUtils.clamp(Math.max(cam.zoom, fitZoom * 1.35), 6, 120), target, pos: target.clone().add(offset) };
    };
    // 점들을 한 화면에: 아이소 방향을 조금 돌리고(azimuth)·낮춘(elevation) 시선에서, UI 가 덮지 않는 영역 가운데에 맞춥니다.
    viewApi.frame = (points, o = {}) => {
      if (!points.length) return;
      const sph = new THREE.Spherical().setFromVector3(ISO_DIR);
      sph.theta += o.azimuth ?? 0;
      sph.phi = THREE.MathUtils.clamp(sph.phi + (o.elevation ?? 0), 0.3, 1.25);
      const dir = new THREE.Vector3().setFromSpherical(sph).normalize();
      const xAxis = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), dir).normalize();
      const yAxis = new THREE.Vector3().crossVectors(dir, xAxis).normalize();
      const pts = points.map((p) => new THREE.Vector3(...p));
      const c0 = pts.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const p of pts) {
        const d = p.clone().sub(c0);
        const px = d.dot(xAxis);
        const py = d.dot(yAxis);
        x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py);
      }
      const center = c0.clone().addScaledVector(xAxis, (x0 + x1) / 2).addScaledVector(yAxis, (y0 + y1) / 2);
      const pad = o.padding ?? 2;
      const ins = o.insets ?? { left: 0, top: 0, right: 0, bottom: 0 };
      // 작은 화면에서도 맞춤 영역이 너무 좁아지지 않도록 가장자리 여백을 화면 크기의 일부로 제한
      const l = Math.min(ins.left, size.width * 0.3), r = Math.min(ins.right, size.width * 0.15);
      const t = Math.min(ins.top, size.height * 0.2), b = Math.min(ins.bottom, size.height * 0.15);
      const freeW = Math.max(120, size.width - l - r);
      const freeH = Math.max(120, size.height - t - b);
      const zoom = THREE.MathUtils.clamp(Math.min(freeW / (x1 - x0 + pad * 2), freeH / (y1 - y0 + pad * 2)), 6, Math.min(120, fitZoom * (o.maxZoomMul ?? 2)));
      // 맞춤 영역 가운데가 화면 가운데에서 벗어난 만큼 시선 중심을 옮김(화면 오른쪽 = +x, 화면 아래 = −y)
      const target = center.clone().addScaledVector(xAxis, -((l - r) / 2) / zoom).addScaledVector(yAxis, ((t - b) / 2) / zoom);
      goal.current = { zoom, target, pos: target.clone().addScaledVector(dir, 90), rate: o.rate };
    };
  });
  // 층 전환·크기 변경 시 아이소 시점으로 부드럽게 이동
  useEffect(reset, [targetY, fitZoom]); // eslint-disable-line react-hooks/exhaustive-deps

  useFrame((_, dt) => {
    const g = goal.current;
    const c = controls.current;
    if (!g || !c) return;
    const cam = camera as THREE.OrthographicCamera;
    // 지수 감쇠(ease-out): 처음엔 빠르게, 도착할수록 천천히. 움직임 줄이기 설정이면 즉시 이동.
    const k = prefersReducedMotion() ? 1 : 1 - Math.exp(-Math.min(dt, 0.1) * (g.rate ?? 6));
    cam.zoom += (g.zoom - cam.zoom) * k;
    c.target.lerp(g.target, k);
    cam.position.lerp(g.pos, k);
    cam.updateProjectionMatrix();
    c.update();
    if (Math.abs(cam.zoom - g.zoom) < 0.01 && cam.position.distanceTo(g.pos) < 0.01) goal.current = null;
  });

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping
      dampingFactor={0.12}
      minZoom={6}
      maxZoom={120}
      minPolarAngle={0.25}
      maxPolarAngle={1.32}
      screenSpacePanning
      enableZoom={wheelZoom}
      onStart={() => {
        goal.current = null;
        onUserCamera?.();
      }}
    />
  );
}

function Scene(p: TwinCanvasProps) {
  const geo = useMemo(() => makeGeo(p.floor), [p.floor]);
  const places = useMemo(() => new Map<string, Place>(p.building.building.nodes.map((n) => [n.id, n])), [p.building]);
  const blockedExits = useMemo(() => new Set(p.hazards?.blocked_nodes ?? []), [p.hazards]);
  const floors = p.building.building.floors;
  // 노드 선택 → 카메라 초점 이동(LIVE·REPLAY 공통, 같은 좌표 변환)
  const nodeLocations = p.replay ? p.replay.topology.nodes : p.topology?.nodes;
  useEffect(() => {
    if (!p.selectedNode) return;
    const n = nodeLocations?.find((x) => x.id === p.selectedNode);
    const place = n && places.get(n.location_id);
    const v = n && place && placePoint(n.location_id, place.floor, geo, geo.nodeLift);
    if (v) viewApi.focus(v);
  }, [p.selectedNode]); // eslint-disable-line react-hooks/exhaustive-deps

  // CINEMATIC 샷: key 가 바뀌거나(새 장면) 화면·층 구성이 바뀔 때만 한 번 이동합니다(매 프레임 계산 없음).
  const { width, height } = useThree((s) => s.size);
  useEffect(() => {
    const shot = p.shot;
    if (!shot) return;
    const pts: [number, number, number][] = [];
    const visibleFloors = floors.filter((f) => geo.sel === 'ALL' || f <= geo.sel);
    if (shot.style === 'overview' || !shot.nodes.length) {
      // 건물 판(보이는 층의 바닥 ~ 벽 높이) 모서리
      const lo = Math.min(...visibleFloors.map((f) => geo.yOf(f)));
      const hi = Math.max(...visibleFloors.map((f) => geo.yOf(f))) + geo.wallH;
      for (const y of [lo, hi]) for (const x of [-PLATE_W / 2, PLATE_W / 2]) for (const z of [-PLATE_D / 2, PLATE_D / 2]) pts.push([x, y, z]);
    } else {
      for (const id of shot.nodes) {
        const n = nodeLocations?.find((x) => x.id === id);
        const place = n && places.get(n.location_id);
        const top = n && place && placePoint(n.location_id, place.floor, geo, geo.nodeLift + 0.9);
        const base = n && place && placePoint(n.location_id, place.floor, geo, 0);
        if (top) pts.push(top);
        if (base) pts.push(base);
      }
    }
    viewApi.frame(pts, { ...SHOT_FRAME[shot.style], insets: p.insets, rate: SHOT_RATE });
  }, [p.shot?.key, geo, width, height]); // eslint-disable-line react-hooks/exhaustive-deps

  // 그림자 맵은 장면 구성이 바뀔 때만 다시 계산합니다(건물·노드는 움직이지 않으므로 매 프레임 계산 불필요).
  const shadowVersion = `${geo.sel}|${p.layers.decor}|${p.layers.network}|${p.layers.hazards}|${p.replay ? 'R' : 'L'}|${p.topology?.nodes.length ?? 0}`;

  return (
    <GeoCtx.Provider value={geo}>
      <StudioEnvironment />
      <ShadowOnDemand version={shadowVersion} />
      {/* 부드러운 하늘·바닥 반사광 + 따뜻한 주광(그림자) + 차가운 보조광 + 뒤쪽 림 라이트(그림자 없음) */}
      <hemisphereLight args={['#dfe7f1', '#0b0c0e', 0.4]} />
      <directionalLight
        position={[-22, 38, 18]}
        intensity={2.0}
        color="#FFF5EA"
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
        shadow-camera-left={-30}
        shadow-camera-right={30}
        shadow-camera-top={30}
        shadow-camera-bottom={-30}
        shadow-camera-near={1}
        shadow-camera-far={120}
      />
      <directionalLight position={[26, 18, -20]} intensity={0.28} color="#b8c7d9" />
      <directionalLight position={[30, 14, -36]} intensity={0.85} color="#9CCBFF" />

      <group position={[0, geo.sel === 'ALL' ? 0 : 0, 0]}>
        <group position={[0, geo.sel === 'ALL' ? 0 : geo.yOf(1), 0]}>
          <Site />
        </group>
        {floors.map((f) => {
          if (geo.sel !== 'ALL' && f > geo.sel) return null;
          const ghost = geo.sel !== 'ALL' && f < geo.sel;
          if (ghost && f !== (geo.sel as number) - 1) return null;
          return (
            <group key={f} position={[0, geo.yOf(f), 0]}>
              <FloorModel floor={f} H={geo.wallH} ghost={ghost} furniture={p.layers.decor} blockedExits={blockedExits} />
            </group>
          );
        })}
        {p.layers.hazards && p.hazards && <HazardLayer hazards={p.hazards} places={places} />}
        {p.layers.evac && <EvacRouteLayer plans={p.plans} places={places} highlight={p.highlightStart} />}
        {p.layers.network && p.replay && <ReplayNetworkLayer overlay={p.replay} places={places} cinematic={!!p.cinematic} />}
        {p.layers.network && !p.replay && p.topology && (
          <NetworkLayer
            topology={p.topology}
            nodes={p.nodes}
            links={p.links}
            places={places}
            flow={p.flow}
            selected={p.selectedNode}
            onSelect={(id) => p.onSelectNode(id)}
          />
        )}
      </group>
      <ContactShadows position={[0, geo.sel === 'ALL' ? -0.34 : geo.yOf(1) - 0.34, 0]} scale={70} blur={2.4} opacity={0.55} far={12} resolution={1024} color="#000000" />
    </GeoCtx.Provider>
  );
}

/**
 * 절차적 실내 환경광(RoomEnvironment → PMREM). 외부 HDR 파일을 내려받지 않고 한 번만 만듭니다.
 * 유리·광택 면이 은은하게 반사되도록 낮은 세기로 씁니다.
 */
function StudioEnvironment() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const room = new RoomEnvironment();
    const tex = pmrem.fromScene(room, 0.04).texture;
    scene.environment = tex;
    scene.environmentIntensity = 0.32;
    return () => {
      scene.environment = null;
      tex.dispose();
      pmrem.dispose();
      (room as unknown as { dispose?: () => void }).dispose?.();
    };
  }, [gl, scene]);
  return null;
}

/** 그림자 맵 자동 갱신을 끄고, version 이 바뀐 뒤 몇 프레임만 다시 그립니다(저사양 GPU 부담 감소). */
function ShadowOnDemand({ version }: { version: string }) {
  const gl = useThree((s) => s.gl);
  const left = useRef(0);
  useEffect(() => {
    gl.shadowMap.autoUpdate = false;
    left.current = 24;
  }, [gl, version]);
  useFrame(() => {
    if (left.current > 0) {
      gl.shadowMap.needsUpdate = true;
      left.current -= 1;
    }
  });
  return null;
}

export function TwinCanvas(p: TwinCanvasProps) {
  return (
    <Canvas
      shadows
      dpr={[1, 2]}
      gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.0, preserveDrawingBuffer: false, powerPreference: 'high-performance' }}
      onPointerMissed={() => p.onSelectNode(null)}
      style={{ background: 'transparent' }}
    >
      <OrthographicCamera makeDefault position={ISO_DIR.clone().multiplyScalar(90).toArray()} zoom={18} near={-200} far={400} />
      <CameraRig floor={p.floor} wheelZoom={p.wheelZoom ?? true} onUserCamera={p.onUserCamera} />
      <Scene {...p} />
    </Canvas>
  );
}
