import { useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, Maximize2, Minimize2 } from 'lucide-react';
import type { ReplayCase } from '@/domain/replayEngine';
import { captionAt, type CaptionTone } from '@/ui/replay/cinematicDirector';
import { cx } from '@/ui/primitives';

/**
 * Network Monitor 공통 화면 조각(LIVE·REPLAY 공용). 스토어·API·WebSocket 을 쓰지 않습니다.
 * Digital Twin 과 같은 디자인 언어(유리 control bar · 얇은 테두리 · 큰 값/작은 라벨)를 씁니다.
 */

/** FOCUS: 발표용 화면 표시 옵션. LIVE/REPLAY 모드·재생 엔진과 무관하게 패널만 접습니다. */
export function FocusToggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      aria-pressed={on}
      data-testid="nm-focus"
      title={on ? '일반 화면으로(Esc)' : 'FOCUS: 보조 패널을 접고 토폴로지와 현재 이벤트만 크게'}
      className={cx('lift inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-medium transition', on ? 'border-[#7CC8FF]/60 bg-[#7CC8FF]/[0.14] text-[#DDF1FF]' : 'border-white/10 bg-white/[0.04] text-ink-2 hover:border-white/25 hover:text-ink')}
    >
      {on ? <Minimize2 size={13} /> : <Maximize2 size={13} />} FOCUS
    </button>
  );
}

/**
 * 상단 control bar 가 좁은 화면에서 두 줄이 되어도 토폴로지가 그 아래에서 시작하도록 실제 높이를 잽니다.
 * 콜백 ref 를 돌려주므로 bar 요소가 바뀌어도(로딩 → 표시) 다시 잽니다.
 */
export function useBarBottom(fallback = 70): [(el: HTMLElement | null) => void, number] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [bottom, setBottom] = useState(fallback);
  useLayoutEffect(() => {
    if (!el) return;
    const stage = el.closest('.nm-stage') ?? el.parentElement;
    const measure = () => {
      const b = el.getBoundingClientRect().bottom - (stage?.getBoundingClientRect().top ?? 0);
      setBottom(Math.max(fallback, Math.round(b + 14)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el, fallback]);
  return [setEl, bottom];
}

/** FOCUS 상태에서 Esc 로 빠져나오기 */
export function useEscapeToExit(active: boolean, exit: () => void) {
  useEffect(() => {
    if (!active) return;
    const on = (e: KeyboardEvent) => { if (e.key === 'Escape') exit(); };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [active, exit]);
}

/** 접히는 범례(기본 접힘: 토폴로지를 가리지 않음) */
export function LegendCard({ title, children, defaultOpen = false }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="glass-float pointer-events-auto max-w-[320px] rounded-2xl text-[11.5px] text-ink-2">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center justify-between gap-3 px-3.5 py-2 text-left">
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-3">{title}</span>
        <ChevronDown size={14} className={cx('text-ink-3 transition-transform', open && 'rotate-180')} />
      </button>
      {open && <div className="space-y-1.5 border-t border-white/[0.07] px-3.5 pb-3 pt-2.5">{children}</div>}
    </div>
  );
}

const TONE: Record<CaptionTone, string> = { fail: '#FF7A7F', warn: '#F2A766', ok: '#4FD39A', info: '#8FD3FF' };
const HEADLINE_MS = 3600;

/**
 * 현재 이벤트 헤드라인(REPLAY). 재생 위치 이전에 실제로 기록된 이벤트만 문구로 만듭니다(cinematicDirector.captionAt).
 * 재생 중에는 잠시 뒤 물러나고, 일시정지 중에는 계속 보입니다.
 */
export function NmHeadline({ trial, t, playing, large }: { trial: ReplayCase; t: number; playing: boolean; large: boolean }) {
  const cap = useMemo(() => captionAt(trial, t), [trial, t]);
  const key = cap ? `${trial.cell.cell}-${cap.key}` : '';
  const shownAt = useMemo(() => performance.now(), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const [, tick] = useState(0);
  useEffect(() => {
    if (!playing || !key) return;
    const left = HEADLINE_MS - (performance.now() - shownAt);
    if (left <= 0) return;
    const id = window.setTimeout(() => tick((x) => x + 1), left + 30);
    return () => window.clearTimeout(id);
  }, [playing, key, shownAt]);
  if (!cap) return null;
  const out = playing && performance.now() - shownAt > HEADLINE_MS;
  const color = TONE[cap.tone];
  return (
    <div key={key} data-testid="nm-event-headline" data-caption-en={cap.en} aria-live="polite" className={cx('cine-caption pointer-events-none', large ? 'w-[min(720px,70vw)]' : 'w-[250px]', out && 'is-out')}>
      <div className="flex items-center gap-2.5 font-mono text-[11px] font-medium uppercase tracking-[0.2em]" style={{ color }}>
        <span className="cine-rule h-px w-7" style={{ background: color, boxShadow: `0 0 10px ${color}` }} />
        <span className="truncate">{cap.en}</span>
      </div>
      <div className={cx('mt-1.5 font-semibold leading-[1.1] tracking-[-0.02em] text-ink [text-shadow:0_2px_20px_rgba(0,0,0,0.95)]', large ? (cap.weight === 3 ? 'text-[clamp(24px,2.3vw,38px)]' : 'text-[clamp(20px,1.9vw,30px)]') : 'text-[clamp(17px,1.35vw,21px)]')}>{cap.ko}</div>
      {cap.route && (
        <div className={cx('mt-1.5 flex flex-wrap items-center gap-x-2 font-mono [text-shadow:0_2px_12px_rgba(0,0,0,0.9)]', large ? 'text-[clamp(14px,1.2vw,18px)]' : 'text-[13px]')}>
          {cap.oldRoute && (
            <>
              <s className="text-[#FF9EA1]/75">{cap.oldRoute.join(' → ')}</s>
              <span className="text-ink-3">⇒</span>
            </>
          )}
          <span style={{ color: cap.tone === 'fail' ? '#FFB3B6' : cap.tone === 'ok' ? '#9EEBC6' : '#CFEAFF' }}>{cap.route.join(' → ')}</span>
        </div>
      )}
      <div className="mt-1 font-mono text-[11px] text-ink-3">+{(cap.t / 1000).toFixed(3)}s · {cap.detail}</div>
    </div>
  );
}
