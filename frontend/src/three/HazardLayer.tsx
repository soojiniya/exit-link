import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { Ban, Flame, TriangleAlert } from 'lucide-react';
import type { Place, WsHazardUpdate } from '@contracts';
import { layout, toWorld } from '@/domain/layout';
import { useGeo, placePoint } from './sceneContext';

type Kind = 'fire' | 'danger' | 'blocked';
const COLOR: Record<Kind, string> = { fire: '#E5484D', danger: '#E08A3C', blocked: '#B23A3E' };

function stripeTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(178,58,62,0.35)';
  g.fillRect(0, 0, 64, 64);
  g.strokeStyle = 'rgba(229,72,77,0.9)';
  g.lineWidth = 10;
  for (let i = -64; i < 128; i += 22) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i + 64, 64);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function Zone({ id, place, kind }: { id: string; place: Place; kind: Kind }) {
  const geo = useGeo();
  const spec = layout.places[id];
  const vol = useRef<THREE.MeshStandardMaterial>(null);
  const glow = useRef<THREE.MeshBasicMaterial>(null);
  const tex = useMemo(() => (kind === 'blocked' ? stripeTexture() : null), [kind]);
  const [x0, z0, x1, z1] = spec.footprint;
  const [cx, cz] = toWorld([(x0 + x1) / 2, (z0 + z1) / 2]);
  const w = x1 - x0;
  const d = z1 - z0;
  const y = geo.yOf(place.floor);
  const h = kind === 'blocked' ? 0.5 : geo.wallH * 0.98;
  const em = geo.emphasis(place.floor);
  if (tex) tex.repeat.set(w / 1.2, d / 1.2);
  const edges = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d)), [w, h, d]);

  useFrame(({ clock }) => {
    const k = 0.5 + 0.5 * Math.sin(clock.elapsedTime * (kind === 'fire' ? 3.2 : 2));
    if (vol.current) vol.current.opacity = (kind === 'fire' ? 0.2 + 0.12 * k : 0.14 + 0.06 * k) * em;
    if (glow.current) glow.current.opacity = (kind === 'fire' ? 0.35 + 0.3 * k : 0.25) * em;
  });

  const Icon = kind === 'fire' ? Flame : kind === 'danger' ? TriangleAlert : Ban;
  const label = kind === 'fire' ? '화재' : kind === 'danger' ? '위험' : '차단';
  return (
    <group position={[cx, y, cz]}>
      <mesh position={[0, 0.045, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={2}>
        <planeGeometry args={[w, d]} />
        {tex ? (
          <meshBasicMaterial map={tex} transparent opacity={0.9 * em} depthWrite={false} />
        ) : (
          <meshBasicMaterial ref={glow} color={COLOR[kind]} transparent opacity={0.4} depthWrite={false} />
        )}
      </mesh>
      {kind !== 'blocked' && (
        <>
          <mesh position={[0, h / 2, 0]} renderOrder={3}>
            <boxGeometry args={[w, h, d]} />
            <meshStandardMaterial ref={vol} color={COLOR[kind]} emissive={COLOR[kind]} emissiveIntensity={0.6} transparent opacity={0.25} depthWrite={false} roughness={1} />
          </mesh>
          <lineSegments geometry={edges} position={[0, h / 2, 0]}>
            <lineBasicMaterial color={COLOR[kind]} transparent opacity={0.7 * em} />
          </lineSegments>
        </>
      )}
      {kind === 'fire' && <pointLight position={[0, 1.2, 0]} color="#ff5a3c" intensity={14 * em} distance={9} decay={2} />}
      <Html position={[0, h + 0.5, 0]} center zIndexRange={[20, 10]} style={{ pointerEvents: 'none', opacity: em < 1 ? 0.55 : 1 }}>
        <div
          className="flex items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[11px] font-medium shadow-lg"
          style={{ background: 'rgba(22,24,27,0.88)', borderColor: COLOR[kind], color: kind === 'danger' ? '#EDAA6B' : '#F2878A' }}
        >
          <Icon size={12} /> {label} · <span className="font-mono">{id}</span>
        </div>
      </Html>
    </group>
  );
}

function PassageBarrier({ a, b, places }: { a: string; b: string; places: Map<string, Place> }) {
  const geo = useGeo();
  const pa = places.get(a);
  const pb = places.get(b);
  if (!pa || !pb) return null;
  const A = placePoint(a, pa.floor, geo, 0);
  const B = placePoint(b, pb.floor, geo, 0);
  if (!A || !B) return null;
  const m: [number, number, number] = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2];
  return (
    <group position={m}>
      {[Math.PI / 4, -Math.PI / 4].map((r) => (
        <mesh key={r} position={[0, 0.6, 0]} rotation={[0, 0, r]}>
          <boxGeometry args={[1.4, 0.16, 0.16]} />
          <meshStandardMaterial color="#E5484D" emissive="#E5484D" emissiveIntensity={0.5} />
        </mesh>
      ))}
    </group>
  );
}

export function HazardLayer({ hazards, places }: { hazards: WsHazardUpdate; places: Map<string, Place> }) {
  const zones: { id: string; kind: Kind }[] = [
    ...hazards.blocked_nodes.map((id) => ({ id, kind: 'blocked' as const })),
    ...hazards.dangerous_nodes.map((id) => ({ id, kind: 'danger' as const })),
    ...hazards.fire_locations.map((id) => ({ id, kind: 'fire' as const })),
  ];
  return (
    <group>
      {zones.map(({ id, kind }) => {
        const p = places.get(id);
        return p && layout.places[id] ? <Zone key={`${kind}-${id}`} id={id} place={p} kind={kind} /> : null;
      })}
      {hazards.blocked_passages.map((p) => (
        <PassageBarrier key={`${p.source}-${p.target}`} a={p.source} b={p.target} places={places} />
      ))}
    </group>
  );
}
