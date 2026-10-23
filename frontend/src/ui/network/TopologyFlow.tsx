import { memo, useEffect, useMemo } from 'react';
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  Position,
  ReactFlow,
  getStraightPath,
  useReactFlow,
  useStore,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { Place, WsNetworkView } from '@contracts';
import { layout } from '@/domain/layout';
import { NODE_STATUS_LABEL, STATUS_COLOR, type LinkState, type MessageFlow, type NodeState } from '@/domain/network';

const LINK_COLOR = { ok: '#3FB27F', warn: '#E08A3C', fail: '#E5484D', unknown: '#565C64' } as const;
const NB_COLOR: Record<string, string> = { up: '#3FB27F', suspect: '#E08A3C', down: '#E5484D', unknown: '#6B727C' };
const ACTION = '#7CC8FF';
/** 층 간격 · 노드 카드 크기 · 서–동 폭(가상 배치 좌표를 이 폭으로 늘림). 층 배치·연결 관계는 바꾸지 않습니다. */
const ROW = 196;
const NODE_W = 200;
const NODE_H = 90;
const SPAN = 600;
const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

type TcpNodeData = {
  state: NodeState; place?: Place; port?: number; pid?: number; selected: boolean; inRoute: boolean; bypassed: boolean; note?: string;
  /** REPLAY: 반복 맥동 대신 고정 상태 링(기록에 없는 반복 효과를 만들지 않음) */
  steady?: boolean;
  /** REPLAY: 기록된 이벤트 직후의 짧은 강조(ACK 수신·장애 확인·도착), 진행률 0~1 */
  pulse?: { kind: 'ack' | 'fault' | 'arrive'; progress: number };
};

/**
 * REPLAY 오버레이(선택). 저장된 실험 기록을 재생할 때만 넘깁니다. 없으면 LIVE 동작은 그대로입니다.
 * - 링크 강조(legs)·제외 링크·메시지 마커는 기록된 이벤트에서 계산한 값입니다(domain/replayEngine).
 * - 마커의 링크 위 위치는 기록된 송신·수신 이벤트 사이의 시각적 보간이며 실제 위치 측정값이 아닙니다.
 * - REPLAY 에서는 LIVE 의 반복 패킷 애니메이션을 쓰지 않습니다.
 */
export interface TopologyReplayOverlay {
  /** 노드 카드 아래 줄(LIVE 의 포트·PID·TCP 응답 대신) */
  nodeNote: (id: string) => string;
  /** 기록된 이웃 판정(LIVE network 대신) */
  neighborStatus: (from: string, to: string) => string | undefined;
  route: string[] | null;
  previousRoute: string[] | null;
  legs: { from: string; to: string; kind: 'data' | 'ack'; state: 'connecting' | 'inflight' | 'done' | 'failed' }[];
  excludedLinks: [string, string][];
  markers: { key: string; from: string; to: string; frac: number; kind: 'transit' | 'ack' | 'waiting' | 'connecting'; label: string; selected: boolean }[];
  /** 기록 시각에 맞춘 노드 강조(cinematicDirector.pulsesAt) */
  pulses?: { node: string; kind: 'ack' | 'fault' | 'arrive'; progress: number }[];
  /** route_changed 직후 새 경로를 따라 지나가는 빛(경로 강조, 메시지 이동 아님) */
  sweep?: { route: string[]; progress: number } | null;
  /** 선택 메시지 단계: 실패면 현재 경로를 붉은 점선으로, ACK 전에는 성공색을 쓰지 않음 */
  failed?: boolean;
}
type ReplayEdgeData = {
  onRoute: boolean;
  legs: TopologyReplayOverlay['legs'];
  excluded: boolean;
  markers: TopologyReplayOverlay['markers'];
  failed: boolean;
  /** 경로 전환 빛: 이 링크 위 진행률(0~1)과 방향(source→target 이면 true) */
  sweep?: { u: number; forward: boolean };
};
type BandData = { floor: number };
type LinkData = {
  link: LinkState;
  ab?: string;
  ba?: string;
  active: boolean;
  previous: boolean;
  /** 패킷 애니메이션: 이 링크를 지나는 홉 순번과 방향 */
  hop?: { index: number; total: number; forward: boolean; acked: boolean; failed: boolean };
  /** 링크 선택(REPLAY Playback Inspector 전용, 선택 사항) */
  picked?: boolean;
  /** REPLAY 오버레이(있을 때만) */
  replay?: ReplayEdgeData;
};

const handleStyle = { top: '50%', left: '50%', opacity: 0, width: 1, height: 1, border: 0, minWidth: 0, minHeight: 0, transform: 'translate(-50%,-50%)' };

const TcpNode = memo(function TcpNode({ data }: NodeProps<Node<TcpNodeData>>) {
  const { state, place, pid, port, selected, inRoute, bypassed, note, steady, pulse } = data;
  const c = STATUS_COLOR[state.status];
  const alarm = state.status === 'fail' || state.status === 'warn' || state.status === 'recovering';
  const pulseColor = pulse?.kind === 'ack' ? '#3FB27F' : pulse?.kind === 'fault' ? '#E5484D' : ACTION;
  return (
    <div
      className="nm-node relative rounded-[16px] border px-3.5 py-2.5"
      data-status={state.status}
      data-selected={selected || undefined}
      style={{
        width: NODE_W,
        height: NODE_H,
        background: selected ? 'linear-gradient(180deg, rgba(34,48,72,0.97), rgba(14,21,33,0.97))' : 'linear-gradient(180deg, rgba(24,33,50,0.96), rgba(11,17,27,0.96))',
        borderColor: selected ? '#EEF2F8' : inRoute ? ACTION : alarm ? c : 'rgba(255,255,255,0.13)',
        boxShadow: selected
          ? '0 0 0 1px rgba(238,242,248,0.35), 0 0 30px -6px rgba(124,200,255,0.6), inset 0 1px 0 rgba(255,255,255,0.1)'
          : inRoute
            ? `0 0 0 1px ${ACTION}55, 0 0 26px -8px ${ACTION}, inset 0 1px 0 rgba(255,255,255,0.08)`
            : alarm
              ? `0 0 24px -8px ${c}, inset 0 1px 0 rgba(255,255,255,0.08)`
              : 'inset 0 1px 0 rgba(255,255,255,0.08), 0 14px 30px -16px rgba(0,0,0,0.95)',
      }}
    >
      {alarm && <span className={`pointer-events-none absolute -inset-[4px] rounded-[19px] border ${steady ? '' : 'animate-pulse'}`} style={{ borderColor: `${c}${steady ? '99' : '88'}` }} />}
      {pulse && pulse.progress < 1 && (
        <span
          aria-hidden
          data-node-pulse={pulse.kind}
          className="pointer-events-none absolute -inset-[6px] rounded-[21px] border-2"
          style={{ borderColor: pulseColor, opacity: 1 - pulse.progress, transform: `scale(${1 + pulse.progress * (pulse.kind === 'fault' ? 0.2 : 0.12)})`, boxShadow: `0 0 22px ${pulseColor}` }}
        />
      )}
      <Handle type="target" position={Position.Top} style={handleStyle} isConnectable={false} />
      <Handle type="source" position={Position.Top} style={handleStyle} isConnectable={false} />
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: c, boxShadow: state.status === 'unknown' || state.status === 'offline' ? undefined : `0 0 8px ${c}` }} />
          <span className="font-mono text-[17px] font-semibold leading-none text-ink">{state.id}</span>
          {place && <span className="rounded-md border border-white/10 bg-white/[0.05] px-1.5 font-mono text-[10.5px] leading-[17px] text-ink-2">{place.floor}F</span>}
        </span>
        <span className="rounded-full px-2 py-[1px] text-[11.5px] font-semibold" style={{ color: state.status === 'ok' ? '#7CE0B2' : c, background: `${c}1f` }}>
          {bypassed ? '우회됨' : NODE_STATUS_LABEL[state.status]}
        </span>
      </div>
      <div className="mt-1.5 truncate text-[12px] text-ink-2">{place?.label ?? state.locationId}</div>
      {note !== undefined ? (
        <div className="mt-0.5 truncate font-mono text-[10.5px] text-ink-3" title={state.reason}>{note}</div>
      ) : (
        <div className="mt-0.5 flex justify-between font-mono text-[10.5px] text-ink-3">
          <span>:{port ?? '—'}{pid ? ` · PID ${pid}` : ''}</span>
          <span>{state.reachable === null ? '미관측' : state.reachable ? 'TCP 응답' : 'TCP 불가'}</span>
        </div>
      )}
    </div>
  );
});

const FloorBand = memo(function FloorBand({ data }: NodeProps<Node<BandData>>) {
  return (
    <div className="nm-band h-full w-full rounded-[22px] border border-white/[0.08] bg-gradient-to-r from-white/[0.035] to-white/[0.012] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
      <span className="absolute left-6 top-1/2 -translate-y-1/2 font-light leading-none tracking-[-0.04em] text-white/[0.30]">
        <span className="block text-[40px]">{data.floor}F</span>
        <span className="mt-1 block font-mono text-[10px] uppercase tracking-[0.2em] text-white/[0.28]">Floor</span>
      </span>
    </div>
  );
});

function packetAnim(hop: NonNullable<LinkData['hop']>, path: string, color: string, reverseLeg: boolean) {
  const n = hop.total;
  const span = hop.acked ? 2 * n : n;
  const seg = reverseLeg ? 2 * n - 1 - hop.index : hop.index;
  const t0 = seg / span;
  const t1 = (seg + 1) / span;
  // 방향: 경로 진행 방향이 엣지 source→target과 같으면 0→1
  const dirForward = reverseLeg ? !hop.forward : hop.forward;
  const [a, b] = dirForward ? [0, 1] : [1, 0];
  const dur = `${span * 0.75}s`;
  const keyTimes = [0, t0, t1, 1].map((x) => x.toFixed(4));
  const op = t0 === 0 ? { values: '1;0', keyTimes: `0;${t1.toFixed(4)}` } : { values: '0;1;0', keyTimes: `0;${t0.toFixed(4)};${t1.toFixed(4)}` };
  return (
    <circle r={5} fill={color} style={{ filter: `drop-shadow(0 0 4px ${color})` }}>
      <animateMotion dur={dur} repeatCount="indefinite" path={path} keyPoints={`${a};${a};${b};${b}`} keyTimes={keyTimes.join(';')} calcMode="linear" />
      <animate attributeName="opacity" dur={dur} repeatCount="indefinite" calcMode="discrete" values={op.values} keyTimes={op.keyTimes} />
    </circle>
  );
}

const REPLAY_COLOR = { data: ACTION, ack: '#3FB27F', fail: '#E5484D', wait: '#E08A3C' } as const;

/** 노드 카드에 가리지 않는 링크 구간(0~1) 안에서의 위치 */
function visibleFrac(sx: number, sy: number, tx: number, ty: number) {
  const dx = Math.abs(tx - sx) || 1e-6;
  const dy = Math.abs(ty - sy) || 1e-6;
  const len = Math.hypot(tx - sx, ty - sy) || 1;
  const toEdge = Math.min((NODE_W / 2 + 8) / dx, (NODE_H / 2 + 8) / dy) * len;
  return Math.min(0.45, toEdge / len);
}

function ReplayEdgeLayer({ source, sourceX, sourceY, targetX, targetY, r }: { source: string; sourceX: number; sourceY: number; targetX: number; targetY: number; r: ReplayEdgeData }) {
  const e = visibleFrac(sourceX, sourceY, targetX, targetY);
  const at = (from: string, f: number) => {
    const g = from === source ? f : 1 - f;
    return [sourceX + (targetX - sourceX) * g, sourceY + (targetY - sourceY) * g] as const;
  };
  const len = Math.hypot(targetX - sourceX, targetY - sourceY) || 1;
  const nx = -(targetY - sourceY) / len;
  const ny = (targetX - sourceX) / len;
  const seg = (from: string, off: number) => {
    const [x1, y1] = at(from, e);
    const [x2, y2] = at(from, 1 - e);
    const ox = nx * off * (from === source ? 1 : -1);
    const oy = ny * off * (from === source ? 1 : -1);
    return { x1: x1 + ox, y1: y1 + oy, x2: x2 + ox, y2: y2 + oy };
  };
  const [mx, my] = at(source, 0.5);
  const [ax, ay] = at(source, e);
  const [bx, by] = at(source, 1 - e);
  return (
    <>
      {r.onRoute && (
        <path
          d={`M${sourceX},${sourceY} L${targetX},${targetY}`}
          fill="none"
          stroke={r.failed ? REPLAY_COLOR.fail : ACTION}
          strokeWidth={r.failed ? 2.5 : 3.5}
          strokeDasharray={r.failed ? '5 6' : undefined}
          opacity={r.failed ? 0.5 : 0.55}
          style={r.failed ? undefined : { filter: `drop-shadow(0 0 6px ${ACTION}88)` }}
        />
      )}
      {r.sweep && (
        <path
          d={r.sweep.forward ? `M${ax},${ay} L${bx},${by}` : `M${bx},${by} L${ax},${ay}`}
          fill="none"
          stroke="#EAF8FF"
          strokeWidth={5}
          strokeLinecap="round"
          pathLength={1}
          strokeDasharray="0.32 2"
          strokeDashoffset={0.32 - r.sweep.u}
          opacity={0.95}
          style={{ filter: 'drop-shadow(0 0 8px #BFE4FF)' }}
          data-replay-sweep="1"
        />
      )}
      {r.legs.map((leg, i) => {
        const p = seg(leg.from, leg.kind === 'ack' ? 6 : -6);
        const col = leg.state === 'failed' ? REPLAY_COLOR.fail : leg.kind === 'ack' ? REPLAY_COLOR.ack : leg.state === 'connecting' ? REPLAY_COLOR.wait : REPLAY_COLOR.data;
        const moving = leg.state === 'connecting' || leg.state === 'inflight';
        const ang = Math.atan2(p.y2 - p.y1, p.x2 - p.x1);
        const head = `${p.x2},${p.y2} ${p.x2 - 12 * Math.cos(ang - 0.45)},${p.y2 - 12 * Math.sin(ang - 0.45)} ${p.x2 - 12 * Math.cos(ang + 0.45)},${p.y2 - 12 * Math.sin(ang + 0.45)}`;
        return (
          <g key={`${leg.kind}-${i}`} data-replay-leg={`${leg.kind}:${leg.from}>${leg.to}:${leg.state}`}>
            <line {...p} stroke={col} strokeWidth={4} strokeLinecap="round" strokeDasharray={moving ? '10 7' : leg.state === 'failed' ? '3 6' : undefined} style={{ filter: `drop-shadow(0 0 5px ${col}aa)`, animation: moving ? 'flow-dash 0.8s linear infinite' : undefined }} />
            <polygon points={head} fill={col} transform={`translate(${Math.cos(ang) * 2},${Math.sin(ang) * 2}) `} />
          </g>
        );
      })}
      {r.excluded && (
        <g transform={`translate(${mx},${my})`} data-replay-excluded="1">
          <circle r={13} fill="#1a0d10" stroke={REPLAY_COLOR.fail} strokeWidth={2} style={{ filter: `drop-shadow(0 0 6px ${REPLAY_COLOR.fail})` }} />
          <path d="M-5.5,-5.5 L5.5,5.5 M5.5,-5.5 L-5.5,5.5" stroke={REPLAY_COLOR.fail} strokeWidth={2.6} strokeLinecap="round" />
          <text y={27} textAnchor="middle" fontSize={11} fontFamily="JetBrains Mono, monospace" fill="#FF9EA1">제외</text>
        </g>
      )}
      {r.markers.map((m) => {
        const f = m.kind === 'transit' || m.kind === 'ack' ? e + m.frac * (1 - 2 * e) : e;
        const [x, y] = at(m.from, f);
        const col = m.kind === 'ack' ? REPLAY_COLOR.ack : m.kind === 'connecting' ? REPLAY_COLOR.wait : REPLAY_COLOR.data;
        return (
          <g key={m.key} data-replay-marker={`${m.label}:${m.kind}:${m.from}>${m.to}`} style={{ transform: `translate(${x}px, ${y}px)`, transition: 'transform 220ms linear' }} opacity={m.selected ? 1 : 0.8}>
            {m.kind === 'connecting' && <circle r={14} fill="none" stroke={col} strokeWidth={1.6} opacity={0.7} className="animate-ping" style={{ transformOrigin: 'center', transformBox: 'fill-box' }} />}
            {/* 링크 위를 움직이는 마커(송신·수신 기록 사이) = 시각적 보간 → 점선 외곽 링으로 구분 */}
            {(m.kind === 'transit' || m.kind === 'ack') && <circle r={m.selected ? 13 : 11} fill="none" stroke={col} strokeWidth={1.2} strokeDasharray="2 3" opacity={0.8} data-interpolated="1" />}
            <circle r={m.selected ? 8.5 : 7} fill={col} stroke="#0A1220" strokeWidth={2} style={{ filter: `drop-shadow(0 0 8px ${col})` }} />
            <g transform={`translate(0, ${-(m.selected ? 25 : 22)})`}>
              <rect x={-17} y={-9} width={34} height={18} rx={9} fill="rgba(10,14,20,0.92)" stroke={`${col}99`} strokeWidth={1} />
              <text y={4} textAnchor="middle" fontSize={11.5} fontWeight={600} fontFamily="JetBrains Mono, monospace" fill={col}>{m.label}</text>
            </g>
          </g>
        );
      })}
    </>
  );
}

const LinkEdge = memo(function LinkEdge({ id, source, sourceX, sourceY, targetX, targetY, data }: EdgeProps<Edge<LinkData>>) {
  const [path] = getStraightPath({ sourceX, sourceY, targetX, targetY });
  if (!data) return null;
  const { link, ab, ba, active, previous, hop } = data;
  const col = LINK_COLOR[link.status];
  const lx = (t: number) => sourceX + (targetX - sourceX) * t;
  const ly = (t: number) => sourceY + (targetY - sourceY) * t;
  return (
    <>
      <BaseEdge id={id} path={path} style={{ stroke: col, strokeWidth: link.status === 'fail' ? 3 : 2.4, strokeDasharray: link.status === 'fail' || link.status === 'unknown' ? '7 6' : undefined, opacity: active ? 0.35 : link.status === 'unknown' ? 0.6 : 0.9 }} />
      {data.picked && <path d={path} fill="none" stroke="#EEF2F8" strokeWidth={11} strokeLinecap="round" opacity={0.16} data-link-picked="1" />}
      {previous && <path d={path} fill="none" stroke="#E5484D" strokeWidth={3} strokeDasharray="4 5" opacity={0.9} />}
      {active && <path d={path} fill="none" stroke={ACTION} strokeWidth={4} strokeDasharray="10 6" style={{ animation: 'flow-dash 0.8s linear infinite' }} />}
      {hop && packetAnim(hop, path, hop.failed ? '#E5484D' : ACTION, false)}
      {hop && hop.acked && packetAnim(hop, path, '#3FB27F', true)}
      {data.replay && <ReplayEdgeLayer source={source} sourceX={sourceX} sourceY={sourceY} targetX={targetX} targetY={targetY} r={data.replay} />}
      <EdgeLabelRenderer>
        {[
          { t: 0.27, s: ab, title: `${link.a}가 본 ${link.b}` },
          { t: 0.73, s: ba, title: `${link.b}가 본 ${link.a}` },
        ].map(({ t, s, title }) =>
          s ? (
            <div
              key={t}
              title={title}
              className="nodrag nopan pointer-events-auto absolute rounded-md border bg-[#121820] px-1.5 font-mono text-[10px] leading-[16px]"
              style={{ transform: `translate(-50%,-50%) translate(${lx(t)}px,${ly(t)}px)`, color: NB_COLOR[s] ?? '#6B727C', borderColor: `${NB_COLOR[s] ?? '#6B727C'}55` }}
            >
              {s}
            </div>
          ) : null,
        )}
      </EdgeLabelRenderer>
    </>
  );
});

const nodeTypes = { tcp: TcpNode, band: FloorBand };
const edgeTypes = { link: LinkEdge };

export interface TopologyFlowProps {
  /** LIVE: WsCommunicationTopology. REPLAY: 기록의 노드 목록(포트 없음) */
  topology: { nodes: ReadonlyArray<{ id: string; location_id: string; port?: number }> };
  /** LIVE 관측. REPLAY 에서는 null 이고 replay.neighborStatus 를 씁니다. */
  network: WsNetworkView | null;
  nodes: NodeState[];
  links: LinkState[];
  places: Map<string, Place>;
  pids: Map<string, number>;
  flow: MessageFlow | null;
  selected: string | null;
  onSelect: (id: string | null) => void;
  /** REPLAY 모드 전용 오버레이. LIVE 에서는 넘기지 않습니다. */
  replay?: TopologyReplayOverlay;
  /** (선택) 링크 선택. 넘기지 않으면 링크 클릭은 아무 동작도 하지 않습니다(기존 동작). */
  selectedLink?: string | null;
  onSelectLink?: (a: string, b: string) => void;
  /**
   * (선택) 건물 정의(층·위치 이름)를 받지 못했을 때의 개략 배치. 층 띠를 그리지 않고 기록의 노드 순서대로 3열로 놓습니다.
   * 연결 관계(links)는 그대로이며, 위치는 층·좌표를 의미하지 않습니다.
   */
  unplaced?: boolean;
}

/** 통신 토폴로지. 노드 위치는 3D와 같은 가상 배치(서/동 × 층)를 따릅니다. */
export function TopologyFlow({ topology, network, nodes, links, places, pids, flow, selected, onSelect, replay, selectedLink, onSelectLink, unplaced }: TopologyFlowProps) {
  const floors = useMemo(() => (unplaced ? [] : [...new Set(topology.nodes.map((n) => places.get(n.location_id)?.floor ?? 1))].sort((a, b) => b - a)), [topology, places, unplaced]);
  const xs = topology.nodes.map((n) => layout.places[n.location_id]?.position[0] ?? 0);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const X = (x: number) => ((x - minX) / Math.max(1, maxX - minX)) * SPAN;
  const Y = (f: number) => floors.indexOf(f) * ROW;

  // ── 기본 토폴로지(위치·크기): 재생 시각과 무관하게 고정 ──────────────────────
  // React Flow 12 는 새 노드 객체에 measured 가 없으면 측정값·핸들 위치를 지우고 다시 잽니다(adoptUserNodes).
  // 재생 중에는 매 프레임 새 객체가 오므로 재측정이 끝나기 전에 또 지워져 노드가 숨겨지고(visibility:hidden) 엣지가 그려지지 않았습니다.
  // 노드 크기는 고정값이므로 width·height·measured 를 항상 넣어 재측정 없이 그대로 유지합니다.
  const BAND_W = SPAN + NODE_W + 210;
  const BAND_H = NODE_H + 72;
  const base = useMemo(() => {
    const bands: Node<BandData>[] = floors.map((f) => ({
      id: `band-${f}`, type: 'band', position: { x: -150, y: Y(f) - 36 }, data: { floor: f }, draggable: false, selectable: false, focusable: false, zIndex: -1,
      width: BAND_W, height: BAND_H, measured: { width: BAND_W, height: BAND_H }, style: { width: BAND_W, height: BAND_H },
    }));
    const shells = new Map<string, { position: { x: number; y: number }; place?: Place; port?: number }>();
    for (const t of topology.nodes) {
      const p = places.get(t.location_id);
      const pos = layout.places[t.location_id]?.position ?? [0, 0];
      // 개략 배치: 서·동 열은 배치 파일의 x, 행은 같은 열 안에서 기록의 노드 순서(층 아님)
      const col = unplaced ? (pos[0] - minX) / Math.max(1, maxX - minX) : 0;
      const k = unplaced ? topology.nodes.filter((n) => (layout.places[n.location_id]?.position[0] ?? 0) === pos[0]).indexOf(t) : 0;
      shells.set(t.id, { position: unplaced ? { x: col * SPAN, y: k * ROW } : { x: X(pos[0]), y: Y(p?.floor ?? 1) }, place: p, port: t.port });
    }
    return { bands, shells };
  }, [topology, places, floors, unplaced]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 이벤트 기반 상태(data)만 재생 시각에 따라 바뀜 ──────────────────────────
  const rfNodes = useMemo<Node[]>(() => {
    const pulse = new Map((replay?.pulses ?? []).map((p) => [p.node, p]));
    const route = flow?.route ?? replay?.route ?? null;
    const previousRoute = flow?.previousRoute ?? replay?.previousRoute ?? null;
    const bypassed = new Set((previousRoute ?? []).filter((n) => !route?.includes(n)));
    const tcp: Node<TcpNodeData>[] = [];
    for (const s of nodes) {
      const sh = base.shells.get(s.id);
      if (!sh) continue;
      tcp.push({
        id: s.id,
        type: 'tcp',
        position: sh.position,
        width: NODE_W,
        height: NODE_H,
        measured: { width: NODE_W, height: NODE_H },
        data: {
          state: s, place: sh.place, port: sh.port, pid: pids.get(s.id), selected: selected === s.id, inRoute: !!route?.includes(s.id), bypassed: bypassed.has(s.id), note: replay?.nodeNote(s.id),
          steady: !!replay,
          pulse: pulse.get(s.id) ? { kind: pulse.get(s.id)!.kind, progress: pulse.get(s.id)!.progress } : undefined,
        },
        draggable: true,
      });
    }
    return [...base.bands, ...tcp];
  }, [nodes, base, pids, selected, flow, replay]);

  const rfEdges = useMemo<Edge<LinkData>[]>(() => {
    const view = (from: string, to: string) =>
      replay ? replay.neighborStatus(from, to) : network?.nodes.find((n) => n.node_id === from && n.reachable)?.neighbors.find((x) => x.node_id === to)?.status;
    const same = (l: { from: string; to: string }, a: string, b: string) => (l.from === a && l.to === b) || (l.from === b && l.to === a);
    const hopOf = (r: string[] | undefined, a: string, b: string) => {
      if (!r) return -1;
      for (let i = 0; i < r.length - 1; i++) if ((r[i] === a && r[i + 1] === b) || (r[i] === b && r[i + 1] === a)) return i;
      return -1;
    };
    return links.map((l) => {
      const i = hopOf(flow?.route, l.a, l.b);
      const p = hopOf(flow?.previousRoute ?? undefined, l.a, l.b);
      // 경로 전환 빛: 새 경로 전체 진행률을 링크별 구간으로 나눔
      const sw = replay?.sweep;
      const si = sw ? hopOf(sw.route, l.a, l.b) : -1;
      const segN = sw ? sw.route.length - 1 : 1;
      const su = sw && si >= 0 ? sw.progress * segN * 1.15 - si : -1;
      const rr = replay
        ? {
            onRoute: hopOf(replay.route ?? undefined, l.a, l.b) >= 0,
            legs: replay.legs.filter((g) => same(g, l.a, l.b)),
            excluded: replay.excludedLinks.some(([x, y]) => same({ from: x, to: y }, l.a, l.b)),
            markers: replay.markers.filter((m) => same(m, l.a, l.b)),
            failed: !!replay.failed,
            sweep: sw && si >= 0 && su > 0 && su < 1.32 ? { u: su, forward: sw.route[si] === l.a } : undefined,
          }
        : undefined;
      const rp = replay ? hopOf(replay.previousRoute ?? undefined, l.a, l.b) >= 0 && hopOf(replay.route ?? undefined, l.a, l.b) < 0 : false;
      return {
        id: `${l.a}-${l.b}`,
        source: l.a,
        target: l.b,
        type: 'link',
        data: {
          link: l,
          ab: view(l.a, l.b),
          ba: view(l.b, l.a),
          active: i >= 0,
          previous: (p >= 0 && i < 0) || rp,
          hop:
            i >= 0 && flow
              ? { index: i, total: flow.route.length - 1, forward: flow.route[i] === l.a, acked: flow.stage === 'acked', failed: flow.stage === 'failed' }
              : undefined,
          replay: rr,
          picked: !!selectedLink && (selectedLink === `${l.a}-${l.b}` || selectedLink === `${l.b}-${l.a}`),
        },
      };
    });
  }, [links, network, flow, replay, selectedLink]);

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      colorMode="dark"
      fitView
      fitViewOptions={{ padding: 0.06 }}
      minZoom={0.35}
      maxZoom={2.2}
      nodesConnectable={false}
      elementsSelectable
      onNodeClick={(_, n) => n.type === 'tcp' && onSelect(n.id)}
      onEdgeClick={onSelectLink ? (_, e) => onSelectLink(e.source, e.target) : undefined}
      onPaneClick={() => onSelect(null)}
      style={{ background: 'transparent' }}
    >
      <Background color="#2a2e33" bgColor="transparent" gap={22} size={1} />
      <Controls showInteractive={false} position="bottom-right" />
      <AutoFit signature={`${floors.join(',')}|${nodes.length}|${unplaced ? 'u' : 'p'}`} />
    </ReactFlow>
  );
}

/**
 * 화면 크기(창 크기 변경·패널 접기·FOCUS 전환)가 바뀌면 토폴로지 전체가 보이도록 다시 맞춥니다.
 * 같은 크기에서는 사용자가 확대·이동한 상태를 그대로 둡니다.
 */
function AutoFit({ signature }: { signature: string }) {
  const rf = useReactFlow();
  const w = useStore((s) => s.width);
  const h = useStore((s) => s.height);
  useEffect(() => {
    if (!w || !h) return;
    const id = window.setTimeout(() => void rf.fitView({ padding: 0.06, duration: reducedMotion() ? 0 : 450 }), 60);
    return () => window.clearTimeout(id);
  }, [w, h, signature]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}
