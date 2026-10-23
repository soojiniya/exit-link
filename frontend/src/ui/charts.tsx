import { useState, type ReactNode } from 'react';
import { Table2, BarChart3 } from 'lucide-react';
import type { Origin } from '@/store/types';
import { SourceBadge, cx } from './primitives';

/**
 * 차트 토큰. 상태 3색은 어두운 배경(#1E2125)에서 validate_palette.js로 검사했습니다
 * (밝기·채도·대비 통과, CVD 인접 ΔE 7.6 → 범례·간격·표 보기를 함께 제공).
 * 성공/실패 2색(파랑/적색)은 CVD ΔE 20.2로 통과합니다.
 */
export const CH = {
  good: '#4A8FE0',
  warn: '#B5841B',
  bad: '#D84560',
  single: '#7F9CC4',
  grid: 'rgba(255,255,255,0.07)',
  axis: '#8D98AB',
  surface: '#0D131D',
};

export const axisProps = {
  tick: { fill: CH.axis, fontSize: 11, fontFamily: 'JetBrains Mono, monospace' },
  axisLine: { stroke: CH.grid },
  tickLine: false,
} as const;

export function ChartCard({
  title,
  subtitle,
  origin,
  children,
  table,
  className,
  right,
}: {
  title: string;
  subtitle?: ReactNode;
  origin?: Origin;
  children: ReactNode;
  table?: ReactNode;
  className?: string;
  right?: ReactNode;
}) {
  const [showTable, setShowTable] = useState(false);
  return (
    <section className={cx('glass flex min-w-0 flex-col rounded-2xl p-5', className)}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[14px] font-semibold tracking-[-0.005em] text-ink">{title}</h2>
          {subtitle && <div className="mt-1 text-2xs leading-relaxed text-ink-3">{subtitle}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {right}
          {origin && <SourceBadge origin={origin} />}
          {table && (
            <button
              onClick={() => setShowTable((v) => !v)}
              className="rounded-lg border border-white/10 bg-white/[0.04] p-1.5 text-ink-3 transition hover:border-glow/40 hover:text-ink hover:shadow-glow-cyan"
              title={showTable ? '차트 보기' : '표 보기'}
              aria-label={showTable ? '차트 보기' : '표 보기'}
            >
              {showTable ? <BarChart3 size={13} /> : <Table2 size={13} />}
            </button>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1">{showTable && table ? <div className="panel-scroll glass-inset max-h-[260px] rounded-xl px-3 py-1">{table}</div> : children}</div>
    </section>
  );
}

export function NoData({ title = '데이터 없음', hint, height = 180 }: { title?: string; hint?: ReactNode; height?: number }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-white/15 bg-[repeating-linear-gradient(135deg,transparent_0_10px,rgba(255,255,255,0.018)_10px_20px)] px-4 text-center" style={{ height }}>
      <div className="text-xs text-ink-2">{title}</div>
      {hint && <div className="mt-1 max-w-[360px] text-2xs leading-relaxed text-ink-3">{hint}</div>}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string; dashed?: boolean }[] }) {
  return (
    <div className="flex flex-wrap gap-3 text-2xs text-ink-2">
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-[3px]" style={{ background: i.color, boxShadow: `0 0 8px -1px ${i.color}` }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

/** Recharts 툴팁 콘텐츠(다크 표면, 텍스트는 텍스트 색) */
export function TipBox({ title, rows }: { title?: ReactNode; rows: { label: string; value: ReactNode; color?: string }[] }) {
  return (
    <div className="glass-float rounded-xl px-3 py-2 text-2xs">
      {title && <div className="mb-1 font-mono text-ink">{title}</div>}
      {rows.map((r) => (
        <div key={r.label} className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5 text-ink-3">
            {r.color && <span className="h-2 w-2 rounded-sm" style={{ background: r.color }} />}
            {r.label}
          </span>
          <span className="font-mono text-ink">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

export function SimpleTable({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <table className="w-full text-xs">
      <thead className="sticky top-0 bg-[#0c121b]/95 text-left text-[10.5px] text-ink-3 backdrop-blur">
        <tr>{head.map((h) => <th key={h} className="py-1.5 pr-2 font-medium tracking-wide">{h}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-t border-white/[0.06] transition-colors hover:bg-white/[0.03]">
            {r.map((c, j) => <td key={j} className="py-1.5 pr-2 font-mono text-[11px] text-ink-2">{c}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function StatTile({ label, value, sub, origin, tone, accent }: { label: string; value: ReactNode; sub?: ReactNode; origin?: Origin; tone?: 'ok' | 'warn' | 'fail' | 'muted'; accent?: string }) {
  const color = tone === 'ok' ? '#5FD6A2' : tone === 'warn' ? '#F0A866' : tone === 'fail' ? '#FF7A7E' : tone === 'muted' ? '#8D98AB' : '#F4F7FB';
  return (
    <div className="glass group flex min-w-0 flex-col overflow-hidden rounded-2xl px-4 py-3.5 transition hover:border-white/15" style={accent ? { borderColor: `${accent}40`, boxShadow: `inset 0 1px 0 rgba(255,255,255,0.07), 0 18px 40px -24px rgba(0,0,0,0.85), 0 0 28px -14px ${accent}` } : undefined}>
      <span aria-hidden className="pointer-events-none absolute inset-x-4 top-0 h-px" style={{ background: `linear-gradient(90deg, transparent, ${accent ?? 'rgba(255,255,255,0.25)'}, transparent)` }} />
      {accent && <span aria-hidden className="pointer-events-none absolute -right-10 -top-12 h-28 w-28 rounded-full opacity-25 blur-2xl" style={{ background: accent }} />}
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-2xs font-medium text-ink-2">{label}</span>
        {origin && <SourceBadge origin={origin} />}
      </div>
      {typeof value === 'string' && /[가-힣]/.test(value) ? (
        <div className="mt-2.5 text-base font-medium leading-none" style={{ color }}>{value}</div>
      ) : (
        <div className="mt-2 font-mono text-[28px] font-medium leading-none tracking-[-0.02em]" style={{ color, textShadow: tone && tone !== 'muted' ? `0 0 22px ${color}55` : '0 0 22px rgba(169,199,255,0.18)' }}>{value}</div>
      )}
      {sub && <div className="mt-2 truncate text-2xs text-ink-3" title={typeof sub === 'string' ? sub : undefined}>{sub}</div>}
    </div>
  );
}
