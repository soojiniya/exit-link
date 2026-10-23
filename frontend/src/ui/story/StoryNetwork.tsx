import { memo, useMemo } from 'react';
import { linkViewsAt, messageProgressAt, nodeViewsAt, type ReplayCase } from '@/domain/replayEngine';
import { pulsesAt, routeSweepAt } from '@/ui/replay/cinematicDirector';
import { layout } from '@/domain/layout';
import { focusMessage } from './storyScenes';

/**
 * STORY 네트워크 비주얼(2D SVG). 상태는 모두 공통 REPLAY 엔진(domain/replayEngine)과 cinematicDirector 가 계산한 값입니다.
 * - Network Monitor(TopologyFlow)와 같은 색·선 규칙: cyan=데이터·경로, green=ACK, amber=연결 시도·이웃 판정, red=장애·실패, gray=기록 없음.
 * - 노드·연결은 기록의 topology 그대로. 위치는 서·동 열(배치 파일 x)과 기록의 노드 순서로 정한 개략 배치이며 층·좌표가 아닙니다.
 * - 메시지 마커의 링크 위 위치는 기록된 송신·수신 사이의 시각적 보간입니다(점선 외곽 링).
 * - 확대·이동·휠 가로채기가 없습니다(스크롤 스토리용). 애니메이션 루프가 없고 t 가 바뀔 때만 다시 그립니다.
 */
const W = 600;
const H = 560;
const NW = 156;
const NH = 66;
const C = { data: '#7CC8FF', ack: '#3FC28A', wait: '#E9954A', fail: '#EF5A5F', idle: '#5B6472' } as const;
const LINK = { ok: '#3FB27F', warn: '#E08A3C', fail: '#E5484D', unknown: '#4A515B' } as const;
const NODE = { fail: { c: C.fail, label: '장애 확인' }, warn: { c: C.wait, label: '이웃 판정' }, unknown: { c: '#7C8799', label: '상태 기록 없음' } } as const;

export interface StoryNetworkProps {
  trial: ReplayCase;
  t: number;
  /** 고정 메시지(message_id) 또는 null(재생 위치 이전 마지막 기록 이벤트의 메시지) */
  focus: string | null;
  /** 움직임 줄이기: 짧은 강조(펄스·경로 전환 빛)를 그리지 않음 */
  still?: boolean;
  /** 메시지 상태 없이 토폴로지만(히어로) */
  idle?: boolean;
  label: string;
  className?: string;
}

function positions(trial: ReplayCase) {
  const nodes = trial.topology?.nodes ?? [];
  const xs = [...new Set(nodes.map((n) => layout.places[n.location_id ?? '']?.position[0] ?? 0))].sort((a, b) => a - b);
  const cols = new Map<number, string[]>();
  for (const n of nodes) {
    const x = layout.places[n.location_id ?? '']?.position[0] ?? 0;
    cols.set(x, [...(cols.get(x) ?? []), n.id]);
  }
  const rows = Math.max(1, ...[...cols.values()].map((v) => v.length));
  const pos = new Map<string, { x: number; y: number; loc: string }>();
  for (const n of nodes) {
    const x = layout.places[n.location_id ?? '']?.position[0] ?? 0;
    const ci = xs.indexOf(x);
    const k = cols.get(x)!.indexOf(n.id);
    const cx = xs.length > 1 ? 110 + (ci / (xs.length - 1)) * (W - 220) : W / 2;
    // 기록 순서상 앞 노드를 아래에(다른 화면과 같은 읽기 방향). 층 정보가 아닙니다.
    const cy = rows > 1 ? H - 70 - (k / (rows - 1)) * (H - 140) : H / 2;
    pos.set(n.id, { x: cx, y: cy, loc: n.location_id ?? '' });
  }
  return pos;
}

const same = (a: string, b: string, x: string, y: string) => (a === x && b === y) || (a === y && b === x);
const onRoute = (r: string[] | null | undefined, a: string, b: string) => !!r && r.some((n, i) => i < r.length - 1 && same(n, r[i + 1], a, b));

export const StoryNetwork = memo(function StoryNetwork({ trial, t, focus, still, idle, label, className }: StoryNetworkProps) {
  const pos = useMemo(() => positions(trial), [trial]);
  const nodes = useMemo(() => (idle ? (trial.topology?.nodes ?? []).map((n) => ({ id: n.id, status: 'unknown' as const })) : nodeViewsAt(trial, t)), [trial, t, idle]);
  const links = useMemo(() => (idle ? (trial.topology?.edges ?? []).map(([a, b]) => ({ a, b, status: 'unknown' as const })) : linkViewsAt(trial, t)), [trial, t, idle]);
  const progress = useMemo(() => (idle ? [] : trial.messages.map((m) => messageProgressAt(trial, m, t))), [trial, t, idle]);
  const fid = idle ? null : focusMessage(trial, { focus }, t);
  const sel = progress.find((p) => p.messageId === fid) ?? null;
  const pulses = idle || still ? [] : pulsesAt(trial, t);
  const sweep = idle || still || !sel ? null : routeSweepAt(trial, t, sel.messageId);

  // 노드 카드 가장자리까지 잘라낸 선분
  const seg = (a: string, b: string, off = 0) => {
    const p = pos.get(a)!;
    const q = pos.get(b)!;
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const len = Math.hypot(dx, dy) || 1;
    const e = Math.min((NW / 2 + 8) / (Math.abs(dx) || 1e-6), (NH / 2 + 8) / (Math.abs(dy) || 1e-6));
    const f = Math.min(0.45, e);
    const nx = (-dy / len) * off;
    const ny = (dx / len) * off;
    return { x1: p.x + dx * f + nx, y1: p.y + dy * f + ny, x2: q.x - dx * f + nx, y2: q.y - dy * f + ny, f };
  };
  const at = (a: string, b: string, u: number) => {
    const s = seg(a, b);
    return { x: s.x1 + (s.x2 - s.x1) * u, y: s.y1 + (s.y2 - s.y1) * u };
  };

  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className={className} data-story-net="1">
      <defs>
        <filter id="sn-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
      </defs>

      {/* 연결(기록의 topology.edges) — 상태는 기록된 이웃 판정만. 색 변화는 부드럽게 전환 */}
      {links.map((l) => {
        const s = seg(l.a, l.b);
        const col = LINK[l.status];
        return <line key={`b-${l.a}-${l.b}`} {...s} className="sn-t" style={{ stroke: col, opacity: l.status === 'unknown' ? 0.7 : 0.9 }} strokeWidth={l.status === 'unknown' ? 1.6 : 2.4} strokeDasharray={l.status === 'unknown' || l.status === 'fail' ? '6 6' : undefined} data-story-link={`${l.a}-${l.b}:${l.status}`} />;
      })}

      {/*
        경로 층: 링크마다 '이전 시도 경로'·'현재 경로' 선을 항상 두고 투명도만 바꿉니다.
        경로가 바뀌면 이전 경로는 붉은 점선으로 낮아지고 새 경로가 cyan 으로 차오릅니다(나타남·사라짐이 끊기지 않음).
        어떤 선을 켤지는 공통 엔진이 기록에서 계산한 route / previousRoute 만으로 정합니다.
      */}
      {links.map((l) => {
        const prev = !!sel?.previousRoute && onRoute(sel.previousRoute, l.a, l.b) && !onRoute(sel.route, l.a, l.b);
        return <line key={`pr-${l.a}-${l.b}`} {...seg(l.a, l.b)} className="sn-t" style={{ stroke: C.fail, opacity: prev ? 0.55 : 0 }} strokeWidth={3} strokeDasharray="4 6" data-story-prev={prev ? `${l.a}-${l.b}` : undefined} />;
      })}
      {links.map((l) => {
        const on = !!sel?.route && onRoute(sel.route, l.a, l.b);
        const failed = sel?.stage === 'failed';
        return <line key={`r-${l.a}-${l.b}`} {...seg(l.a, l.b)} className="sn-t" style={{ stroke: failed ? C.fail : C.data, opacity: on ? (failed ? 0.25 : 0.22) : 0 }} strokeWidth={7} strokeLinecap="round" data-story-route={on ? `${l.a}-${l.b}` : undefined} />;
      })}

      {/* 경로 전환 빛(route_changed 기록 직후, 경로 강조 · 메시지 이동 아님) */}
      {sweep && sweep.route.slice(0, -1).map((a, i) => {
        const b = sweep.route[i + 1];
        const n = sweep.route.length - 1;
        const u = sweep.progress * n * 1.15 - i;
        if (u <= 0 || u >= 1.3) return null;
        const s = seg(a, b);
        return <line key={`sw-${i}`} {...s} stroke="#EAF8FF" strokeWidth={5} strokeLinecap="round" pathLength={1} strokeDasharray="0.3 2" strokeDashoffset={0.3 - u} filter="url(#sn-glow)" data-story-sweep="1" />;
      })}

      {/* 기록된 구간(legs): 링크·방향·종류(데이터/ACK)마다 자리를 고정하고, 기록된 구간만 보이게(투명도 전환) */}
      {links.flatMap((l) => (['data', 'ack'] as const).flatMap((kind) => [[l.a, l.b], [l.b, l.a]].map(([from, to]) => {
        const g = sel?.legs.find((x) => x.kind === kind && x.from === from && x.to === to);
        const st = g?.state ?? 'done';
        const s = seg(from, to, kind === 'ack' ? 7 : -7);
        const col = st === 'failed' ? C.fail : kind === 'ack' ? C.ack : st === 'connecting' ? C.wait : C.data;
        const moving = !!g && (st === 'connecting' || st === 'inflight');
        const ang = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
        const head = `${s.x2},${s.y2} ${s.x2 - 12 * Math.cos(ang - 0.45)},${s.y2 - 12 * Math.sin(ang - 0.45)} ${s.x2 - 12 * Math.cos(ang + 0.45)},${s.y2 - 12 * Math.sin(ang + 0.45)}`;
        return (
          <g key={`g-${kind}-${from}-${to}`} className="sn-t" style={{ opacity: g ? 1 : 0 }} data-story-leg={g ? `${kind}:${from}>${to}:${st}` : undefined}>
            <line {...s} className={moving && !still ? 'sn-t sn-flow' : 'sn-t'} style={{ stroke: col, filter: g ? `drop-shadow(0 0 5px ${col}aa)` : undefined }} strokeWidth={3.5} strokeLinecap="round" strokeDasharray={moving ? '10 7' : st === 'failed' ? '3 6' : undefined} />
            <polygon points={head} className="sn-t" style={{ fill: col }} />
          </g>
        );
      })))}

      {/* 제외 링크(route_changed 의 excluded_links): 링크마다 표식을 두고 기록 시점 이후에만 나타남 */}
      {links.map((l) => {
        const ex = !!sel?.excludedLinks.some(([a, b]) => same(a, b, l.a, l.b));
        const m = at(l.a, l.b, 0.5);
        return (
          <g key={`x-${l.a}-${l.b}`} transform={`translate(${m.x},${m.y})`} data-story-excluded={ex ? `${sel!.excludedLinks.find(([a, b]) => same(a, b, l.a, l.b))!.join('-')}` : undefined}>
            <g className="sn-t sn-pop" style={{ opacity: ex ? 1 : 0, transform: ex ? 'scale(1)' : 'scale(0.6)' }}>
              <circle r={14} fill="#170b0e" stroke={C.fail} strokeWidth={2} />
              <path d="M-5.5,-5.5 L5.5,5.5 M5.5,-5.5 L-5.5,5.5" stroke={C.fail} strokeWidth={2.6} strokeLinecap="round" />
              <text y={30} textAnchor="middle" fontSize={12} fill="#FF9EA1" fontFamily="JetBrains Mono, monospace">제외</text>
            </g>
          </g>
        );
      })}

      {/* 노드 */}
      {nodes.map((n, i) => {
        const p = pos.get(n.id);
        if (!p) return null;
        const st = NODE[n.status];
        const inRoute = !!sel?.route?.includes(n.id);
        const pulse = pulses.find((x) => x.node === n.id);
        const pc = pulse ? (pulse.kind === 'fault' ? C.fail : pulse.kind === 'ack' ? C.ack : C.data) : '';
        return (
          <g key={n.id} transform={`translate(${p.x - NW / 2},${p.y - NH / 2})`} className="sn-node" style={{ ['--d' as string]: `${i * 70}ms` }} data-node={n.id} data-node-status={n.status}>
            <rect x={-7} y={-7} width={NW + 14} height={NH + 14} rx={20} className="sn-t" style={{ fill: C.fail, opacity: n.status === 'fail' ? 0.1 : 0 }} />
            {pulse && pulse.progress < 1 && (
              <rect x={-6} y={-6} width={NW + 12} height={NH + 12} rx={19} fill="none" stroke={pc} strokeWidth={2} opacity={1 - pulse.progress} transform={`translate(${NW / 2},${NH / 2}) scale(${1 + pulse.progress * 0.12}) translate(${-NW / 2},${-NH / 2})`} data-story-pulse={pulse.kind} />
            )}
            <rect width={NW} height={NH} rx={15} fill="rgba(14,20,31,0.94)" className="sn-t" style={{ stroke: n.status !== 'unknown' ? st.c : inRoute ? C.data : 'rgba(255,255,255,0.14)', strokeWidth: n.status !== 'unknown' || inRoute ? 1.6 : 1 }} />
            <circle cx={18} cy={22} r={4.5} className="sn-t" style={{ fill: st.c, opacity: n.status === 'unknown' ? 0.6 : 1 }} />
            <text x={30} y={28} fontSize={20} fontWeight={600} fill="#EEF2F8" fontFamily="JetBrains Mono, monospace">{n.id}</text>
            <text x={NW - 12} y={27} fontSize={11} textAnchor="end" fill={n.status === 'unknown' ? '#8D98AB' : st.c}>{st.label}</text>
            <text x={14} y={51} fontSize={11} fill="#7F8A9C" fontFamily="JetBrains Mono, monospace">{p.loc}</text>
          </g>
        );
      })}

      {/* 메시지 마커(보간 위치는 점선 외곽 링) */}
      {progress.filter((p) => p.marker).map((p) => {
        const mk = p.marker!;
        if (!pos.has(mk.from) || !pos.has(mk.to)) return null;
        const u = mk.kind === 'transit' || mk.kind === 'ack' ? mk.frac : 0;
        const q = at(mk.from, mk.to, u);
        const col = mk.kind === 'ack' ? C.ack : mk.kind === 'connecting' ? C.wait : C.data;
        const isSel = p.messageId === sel?.messageId;
        return (
          <g key={p.messageId} transform={`translate(${q.x},${q.y})`} opacity={isSel ? 1 : 0.75} className="sn-marker" data-story-marker={`M${p.position}:${mk.kind}:${mk.from}>${mk.to}`}>
            {mk.interpolated && <circle r={isSel ? 14 : 12} fill="none" stroke={col} strokeWidth={1.2} strokeDasharray="2 3" />}
            <circle r={isSel ? 8.5 : 7} fill={col} stroke="#0A1220" strokeWidth={2} filter="url(#sn-glow)" />
            <g transform={`translate(0,${-(isSel ? 26 : 23)})`}>
              <rect x={-18} y={-10} width={36} height={20} rx={10} fill="rgba(8,12,18,0.92)" stroke={`${col}99`} />
              <text y={4.5} textAnchor="middle" fontSize={12} fontWeight={600} fill={col} fontFamily="JetBrains Mono, monospace">M{p.position}</text>
            </g>
          </g>
        );
      })}
    </svg>
  );
});
