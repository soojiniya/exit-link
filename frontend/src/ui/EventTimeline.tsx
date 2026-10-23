import { useMemo, useState } from 'react';
import { useApp } from '@/store/store';
import type { Severity, TimelineItem } from '@/store/types';
import { timeOf } from '@/domain/format';
import { SourceBadge } from './primitives';

const SEV_COLOR: Record<Severity, string> = { info: '#6B727C', ok: '#3FB27F', warn: '#E08A3C', fail: '#E5484D', action: '#7CC8FF' };

const FILTERS: { key: string; label: string; test: (t: TimelineItem) => boolean }[] = [
  { key: 'all', label: '전체', test: () => true },
  { key: 'fault', label: '장애·복구', test: (t) => (t.kind === 'network.event' && /장애|복구|연결 확인|프로세스 시작/.test(t.title)) || t.kind === 'experiment.changed' },
  { key: 'route', label: '경로 전환', test: (t) => t.title.startsWith('통신 경로') || t.kind === 'route.changed' },
  { key: 'msg', label: '전송·ACK', test: (t) => t.kind === 'guidance.result' || /송신|중계|수신|ACK|전송 결과|적용/.test(t.title) },
  { key: 'sim', label: '재난', test: (t) => t.origin === 'SIM' },
];

export function EventTimeline({ onPick }: { onPick?: (t: TimelineItem) => void }) {
  const timeline = useApp((s) => s.timeline);
  const [f, setF] = useState('all');
  const items = useMemo(() => {
    const test = FILTERS.find((x) => x.key === f)!.test;
    return timeline.filter(test).slice(-120).reverse();
  }, [timeline, f]);

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="통신 이벤트 및 경로 전환 기록">
      <div className="flex items-center gap-3 px-4 pb-2 pt-3">
        <span className="font-mono text-[10.5px] font-medium uppercase tracking-[0.14em] text-ink-3">이벤트 · 경로 전환 기록</span>
        <div className="seg" role="tablist" aria-label="이벤트 필터">
          {FILTERS.map((x) => (
            <button
              key={x.key}
              role="tab"
              aria-selected={f === x.key}
              onClick={() => setF(x.key)}
            >
              {x.label}
            </button>
          ))}
        </div>
        <span className="ml-auto hidden text-2xs text-ink-3 lg:inline">이 세션에서 수신한 {timeline.length}건 · 실시간 스트림 기준</span>
      </div>
      <div className="panel-scroll min-h-0 flex-1 px-2 pb-2">
        {items.length === 0 ? (
          <div className="px-2 py-6 text-center text-2xs text-ink-3">아직 수신한 이벤트가 없습니다. 실험을 시작하거나 시나리오·안내 전송을 실행하면 여기에 쌓입니다.</div>
        ) : (
          <table className="w-full border-separate border-spacing-0 text-xs">
            <tbody>
              {items.map((t) => (
                <tr key={t.id} onClick={() => onPick?.(t)} className="group cursor-pointer">
                  <td className="w-[78px] rounded-l-md py-1.5 pl-2 font-mono text-2xs text-ink-3 group-hover:bg-white/[0.045]">{timeOf(t.at)}</td>
                  <td className="w-[92px] py-1.5 group-hover:bg-white/[0.045]"><SourceBadge origin={t.origin} /></td>
                  <td className="w-4 py-1.5 group-hover:bg-white/[0.045]">
                    <span className="block h-1.5 w-1.5 rounded-full" style={{ background: SEV_COLOR[t.severity] }} />
                  </td>
                  <td className="py-1.5 pr-3 text-ink group-hover:bg-white/[0.045]">{t.title}</td>
                  <td className="hidden rounded-r-md py-1.5 pr-2 text-right text-2xs text-ink-3 group-hover:bg-white/[0.045] lg:table-cell">{t.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
