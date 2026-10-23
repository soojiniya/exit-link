import { useMemo } from 'react';
import { ArrowRight } from 'lucide-react';
import { useApp } from '@/store/store';
import type { MessageFlow } from '@/domain/network';
import { messageTrace, type TraceRow } from '@/domain/messageTrace';
import { timeOf } from '@/domain/format';
import { Empty, SectionLabel, SourceBadge, cx } from '../primitives';

const STAGE: Record<MessageFlow['stage'], [string, string]> = {
  routing: ['경로 계산', '#6B727C'],
  sending: ['전송 중', '#7CC8FF'],
  delivered: ['수신됨·ACK 대기', '#7CC8FF'],
  acked: ['ACK 수신', '#3FB27F'],
  failed: ['실패', '#E5484D'],
};

export function StageTag({ stage }: { stage: MessageFlow['stage'] }) {
  const [t, c] = STAGE[stage];
  return <span className="rounded-full border px-2 py-0.5 text-[10px] font-semibold" style={{ color: c, background: `${c}1a`, borderColor: `${c}55` }}>{t}</span>;
}

/** 관측된 메시지 목록(경로 선택 이벤트가 있는 것만) */
export function FlowList({ flows, selected, onSelect }: { flows: MessageFlow[]; selected: string | null; onSelect: (id: string) => void }) {
  const deliveries = useApp((s) => s.deliveries);
  if (!flows.length) return <Empty title="관측된 메시지가 없습니다" hint="Simulation Lab 또는 관제 제어에서 안내를 전송하세요" />;
  return (
    <ul className="space-y-1">
      {[...flows].reverse().map((f) => {
        const d = deliveries[f.messageId];
        return (
          <li key={f.messageId}>
            <button onClick={() => onSelect(f.messageId)} className={cx('w-full rounded-xl border px-2.5 py-1.5 text-left transition', selected === f.messageId ? 'border-action/50 bg-action/[0.07] shadow-glow-action' : 'border-transparent hover:border-white/10 hover:bg-white/[0.04]')}>
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs">{f.route.join(' → ')}</span>
                <StageTag stage={f.stage} />
              </div>
              <div className="mt-0.5 flex items-center gap-2 font-mono text-[10px] text-ink-3">
                <span>{timeOf(f.startedAt)}</span>
                <span>{f.messageId.slice(0, 8)}</span>
                <span>시도 {f.attempt}</span>
                {f.previousRoute && <span className="text-action">경로 전환</span>}
                {d?.application_receipt && <span>적용 {d.application_receipt.disposition}</span>}
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** 장애 전후 경로 비교 */
export function RouteCompare({ flow }: { flow: MessageFlow | null }) {
  if (!flow) return null;
  if (!flow.previousRoute) {
    return (
      <div className="text-xs text-ink-3">
        이 메시지 경로 <span className="font-mono text-action">{flow.route.join(' → ')}</span> · 같은 발신·수신 쌍의 이전 메시지와 경로가 같거나 비교할 이전 메시지가 없습니다.
      </div>
    );
  }
  const removed = flow.previousRoute.filter((n) => !flow.route.includes(n));
  const added = flow.route.filter((n) => !flow.previousRoute!.includes(n));
  return (
    <div className="grid grid-cols-[1fr_auto_1fr_minmax(160px,auto)] items-center gap-3">
      <div className="rounded-lg border border-fail/30 bg-fail/5 px-3 py-2">
        <div className="text-[10px] text-[#F2878A]">{flow.previousReason === 'retry' ? '이전 시도' : '장애 전(직전 메시지)'}</div>
        <div className="font-mono text-sm text-ink-2 line-through decoration-fail/70">{flow.previousRoute.join(' → ')}</div>
      </div>
      <ArrowRight size={16} className="text-ink-3" />
      <div className="rounded-lg border border-action/40 bg-action/5 px-3 py-2">
        <div className="text-[10px] text-action">현재 경로</div>
        <div className="font-mono text-sm text-action">{flow.route.join(' → ')}</div>
      </div>
      <div className="text-[10px] leading-relaxed text-ink-3">
        제외: <span className="font-mono text-[#F2878A]">{removed.join(', ') || '—'}</span> · 추가: <span className="font-mono text-action">{added.join(', ') || '—'}</span> · route_selected 이벤트 기준
      </div>
    </div>
  );
}

const KIND_COLOR: Record<TraceRow['kind'], string> = {
  route: '#A3A9B1', send: '#7CC8FF', relay: '#7CC8FF', deliver: '#3FB27F', apply: '#3FB27F', ack_send: '#3FB27F', ack_recv: '#3FB27F', result: '#3FB27F', retry: '#E08A3C', fail: '#E5484D', other: '#6B727C',
};

/** 메시지 시퀀스 다이어그램: 노드별 생명선과 실제 로그 시각 순서의 송신·중계·수신·ACK */
export function SequenceDiagram({ messageId }: { messageId: string | null }) {
  const netEvents = useApp((s) => s.netEvents);
  const { rows, lanes } = useMemo(() => (messageId ? messageTrace(netEvents, messageId) : { rows: [], lanes: [] }), [netEvents, messageId]);
  if (!messageId) return <Empty title="메시지를 선택하세요" />;
  if (!rows.length) return <Empty title="이 메시지의 로그 이벤트가 이 세션에 없습니다" />;
  const L = 150;
  const laneW = 112;
  const RH = 24;
  const top = 34;
  const W = L + laneW * lanes.length + 140; // 마지막 생명선 오른쪽 라벨 여백
  const H = top + rows.length * RH + 12;
  const lx = (n: string) => L + laneW * lanes.indexOf(n) + laneW / 2;
  const t0 = Math.min(...rows.map((r) => Date.parse(r.at)));
  return (
    <div className="overflow-auto">
      <svg width={W} height={H} role="img" aria-label="메시지 시퀀스 다이어그램" className="font-mono">
        <defs>
          {Object.entries({ y: '#7CC8FF', g: '#3FB27F' }).map(([k, c]) => (
            <marker key={k} id={`seq-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0L10 5L0 10z" fill={c} />
            </marker>
          ))}
        </defs>
        {lanes.map((n) => (
          <g key={n}>
            <rect x={lx(n) - 26} y={4} width={52} height={20} rx={6} fill="#272B30" stroke="#3a3f46" />
            <text x={lx(n)} y={18} textAnchor="middle" fontSize={11} fill="#E8EAED">{n}</text>
            <line x1={lx(n)} x2={lx(n)} y1={26} y2={H - 4} stroke="#2F343A" strokeDasharray="3 4" />
          </g>
        ))}
        {rows.map((r, i) => {
          const y = top + i * RH + RH / 2;
          const c = KIND_COLOR[r.kind];
          const dt = Date.parse(r.at) - t0;
          const arrow = r.to && lanes.includes(r.to);
          const green = r.kind.startsWith('ack');
          return (
            <g key={r.id}>
              <text x={8} y={y + 4} fontSize={10} fill="#6B727C">{timeOf(r.at)}</text>
              <text x={L - 10} y={y + 4} fontSize={10} fill="#A3A9B1" textAnchor="end">+{dt}ms</text>
              {arrow ? (
                <>
                  <line x1={lx(r.node)} x2={lx(r.to!) + (lx(r.to!) > lx(r.node) ? -6 : 6)} y1={y} y2={y} stroke={c} strokeWidth={1.6} markerEnd={`url(#seq-${green ? 'g' : 'y'})`} />
                  <text x={(lx(r.node) + lx(r.to!)) / 2} y={y - 4} fontSize={9.5} textAnchor="middle" fill={c} fontFamily="Pretendard Variable, sans-serif">{r.label}</text>
                </>
              ) : (
                <>
                  <circle cx={lx(r.node)} cy={y} r={4.5} fill={r.ok === false ? '#E5484D' : c} />
                  <text x={lx(r.node) + 9} y={y + 3.5} fontSize={9.5} fill={r.ok === false ? '#F2878A' : '#A3A9B1'} fontFamily="Pretendard Variable, sans-serif">{r.node} · {r.label}</text>
                </>
              )}
            </g>
          );
        })}
      </svg>
      <p className="mt-1 text-[10px] text-ink-3">+ms는 첫 이벤트 이후 노드 프로세스 로그 시각 차이입니다(같은 PC의 시계).</p>
    </div>
  );
}

export function MessageHeader({ flow }: { flow: MessageFlow | null }) {
  return (
    <SectionLabel right={<SourceBadge origin="LIVE" />}>
      메시지 전달 과정 {flow && <span className="ml-1 font-mono normal-case tracking-normal text-ink-3">{flow.messageId.slice(0, 8)}</span>}
    </SectionLabel>
  );
}
