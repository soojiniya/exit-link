import type { ReactNode } from 'react';
import type { Origin } from '@/store/types';

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ');
}

export function SectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between">
      <span className="font-mono text-[10.5px] font-medium uppercase tracking-[0.14em] text-ink-3">{children}</span>
      {right}
    </div>
  );
}

const ORIGIN_STYLE: Record<Origin, string> = {
  SIM: 'border-ice/30 bg-ice/[0.06] text-ice',
  LIVE: 'border-ok/45 bg-ok/[0.08] text-[#7CE0B2] shadow-[0_0_12px_-4px_rgba(63,194,138,0.7)]',
  CTRL: 'border-action/45 bg-action/[0.08] text-action shadow-[0_0_12px_-4px_rgba(124,200,255,0.7)]',
};
const ORIGIN_DOT: Record<Origin, string> = { SIM: 'bg-ice', LIVE: 'bg-ok', CTRL: 'bg-action' };
const ORIGIN_TEXT: Record<Origin, string> = { SIM: 'SIM', LIVE: 'LIVE TCP', CTRL: 'CONTROL' };

/** 데이터 출처 배지: SIM(가상 재난·경로), LIVE TCP(실제 관측), CONTROL(실험 제어) */
export function SourceBadge({ origin, className }: { origin: Origin; className?: string }) {
  return (
    <span
      title={origin === 'SIM' ? '가상 시뮬레이션 데이터' : origin === 'LIVE' ? '실제 TCP 프로세스 관측' : '실험 프로세스 제어'}
      className={cx('inline-flex h-[19px] shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 font-mono text-[10px] leading-none tracking-wide', ORIGIN_STYLE[origin], className)}
    >
      <span aria-hidden className={cx('h-1 w-1 rounded-full', ORIGIN_DOT[origin])} />
      {ORIGIN_TEXT[origin]}
    </span>
  );
}

export function Dot({ color, pulse, size = 8 }: { color: string; pulse?: boolean; size?: number }) {
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      {pulse && <span className="absolute inset-0 animate-ping rounded-full opacity-50" style={{ background: color }} />}
      <span className="relative rounded-full" style={{ width: size, height: size, background: color }} />
    </span>
  );
}

export function Chip({ children, tone = 'neutral', className }: { children: ReactNode; tone?: 'neutral' | 'fail' | 'warn' | 'ok' | 'action'; className?: string }) {
  const t = {
    neutral: 'bg-white/[0.04] text-ink-2 border-white/10',
    fail: 'bg-fail/10 text-[#FF9EA1] border-fail/35',
    warn: 'bg-warn/10 text-[#F4BB87] border-warn/35',
    ok: 'bg-ok/10 text-[#7CE0B2] border-ok/35',
    action: 'bg-action/10 text-action border-action/35',
  }[tone];
  return <span className={cx('inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs', t, className)}>{children}</span>;
}

export function Empty({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-white/15 bg-white/[0.02] px-3 py-4 text-center">
      <div className="text-xs text-ink-2">{title}</div>
      {hint && <div className="mt-1 text-2xs text-ink-3">{hint}</div>}
    </div>
  );
}

export function Button({
  children,
  onClick,
  variant = 'ghost',
  disabled,
  title,
  className,
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'ghost' | 'danger' | 'outline';
  disabled?: boolean;
  title?: string;
  className?: string;
  type?: 'button' | 'submit';
}) {
  const v = {
    primary: 'bg-gradient-to-b from-[#F4F8FF] to-[#C6D6EC] text-[#0A1220] font-semibold shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_6px_18px_-8px_rgba(124,200,255,0.7)] hover:brightness-110 hover:shadow-glow-action',
    ghost: 'border border-white/10 bg-white/[0.05] text-ink shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] hover:border-white/20 hover:bg-white/[0.09]',
    outline: 'border border-white/20 bg-transparent text-ink hover:border-glow/50 hover:shadow-glow-cyan',
    danger: 'border border-fail/40 bg-fail/10 text-[#FF9EA1] hover:bg-fail/20 hover:shadow-[0_0_16px_-6px_rgba(239,90,95,0.8)]',
  }[variant];
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cx('inline-flex h-8 items-center justify-center gap-1.5 rounded-full px-3.5 text-xs transition disabled:cursor-not-allowed disabled:opacity-40', v, className)}
    >
      {children}
    </button>
  );
}
