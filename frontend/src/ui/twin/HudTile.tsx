import type { ReactNode } from 'react';
import { cx } from '@/ui/primitives';

/**
 * Digital Twin HUD 공통 조각. 3D 위에 떠 있는 얇은 유리 층으로, 큰 값 + 작은 라벨의 2단 위계를 씁니다.
 * 색: 정상 cyan/blue · ACK green · suspect amber · down/실패 red · 미관측 gray (tone 으로만 지정)
 */
export type HudTone = 'neutral' | 'info' | 'ok' | 'warn' | 'fail' | 'idle';
const TONE: Record<HudTone, { dot: string; text: string; ring: string }> = {
  neutral: { dot: '#B7C0CE', text: 'text-ink', ring: 'rgba(255,255,255,0.10)' },
  info: { dot: '#7CC8FF', text: 'text-[#BFE4FF]', ring: 'rgba(124,200,255,0.30)' },
  ok: { dot: '#3FC28A', text: 'text-[#8FE6BE]', ring: 'rgba(63,194,138,0.32)' },
  warn: { dot: '#E9954A', text: 'text-[#F6C79A]', ring: 'rgba(233,149,74,0.34)' },
  fail: { dot: '#EF5A5F', text: 'text-[#FFA9AC]', ring: 'rgba(239,90,95,0.36)' },
  idle: { dot: '#7C8799', text: 'text-ink-2', ring: 'rgba(255,255,255,0.08)' },
};

export function HudTile({ label, value, sub, tone = 'neutral', testId, large }: { label: string; value: ReactNode; sub?: ReactNode; tone?: HudTone; testId?: string; large?: boolean }) {
  const t = TONE[tone];
  return (
    <div
      data-testid={testId}
      className="hud-tile glass-float spotlight min-w-0 rounded-2xl px-3.5 py-2.5"
      style={{ boxShadow: `inset 0 1px 0 rgba(255,255,255,0.07), 0 0 0 1px ${t.ring}, 0 18px 40px -26px rgba(0,0,0,0.9)` }}
    >
      <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.14em] text-ink-3">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: t.dot, boxShadow: tone === 'idle' ? undefined : `0 0 8px ${t.dot}` }} />
        {label}
      </div>
      <div className={cx('mt-0.5 truncate font-semibold tracking-[-0.01em]', large ? 'text-[19px] leading-6' : 'text-[15.5px] leading-[22px]', t.text)}>{value}</div>
      {sub && <div className="hud-sub mt-0.5 truncate text-[12px] text-ink-3">{sub}</div>}
    </div>
  );
}
