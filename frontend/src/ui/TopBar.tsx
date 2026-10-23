import { useEffect, useState, type ReactNode } from 'react';
import { KeyRound, Lock, SlidersHorizontal } from 'lucide-react';
import { useApp } from '@/store/store';
import { ago } from '@/domain/format';
import { Dot, cx } from './primitives';
import type { ConnStatus } from '@/store/types';

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

const CONN: Record<ConnStatus, { label: string; color: string }> = {
  idle: { label: '대기', color: '#6B727C' },
  connecting: { label: '연결 중', color: '#E08A3C' },
  open: { label: '실시간 연결', color: '#3FB27F' },
  reconnecting: { label: '재연결 중', color: '#E5484D' },
  resyncing: { label: '동기화 중', color: '#E08A3C' },
};

function Pill({ children, title, hideBelowLg }: { children: ReactNode; title?: string; hideBelowLg?: boolean }) {
  return (
    <div title={title} className={`h-7 items-center gap-2 whitespace-nowrap rounded-full border border-white/10 bg-white/[0.035] px-3 text-2xs text-ink-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] ${hideBelowLg ? 'hidden lg:flex' : 'flex'}`}>
      {children}
    </div>
  );
}

export function TopBar() {
  const now = useNow();
  const conn = useApp((s) => s.conn);
  const connError = useApp((s) => s.connError);
  const network = useApp((s) => s.network);
  const experiment = useApp((s) => s.experiment);
  const hasToken = useApp((s) => s.hasToken);
  const scenarios = useApp((s) => s.scenarios);
  const order = useApp((s) => s.scenarioOrder);
  const activeId = useApp((s) => s.activeScenarioId);
  const setActive = useApp((s) => s.setActiveScenario);
  const setControlOpen = useApp((s) => s.setControlOpen);

  const c = CONN[conn];
  const obs = network?.observation_status;
  const obsColor = obs === 'observed' ? '#3FB27F' : obs === 'error' ? '#E5484D' : '#6B727C';
  const expColor = experiment?.status === 'running' ? '#3FB27F' : experiment?.status === 'failed' ? '#E5484D' : experiment?.status === 'stopped' ? '#6B727C' : '#E08A3C';

  return (
    <header className="glass-chrome relative z-20 flex h-14 shrink-0 items-center gap-4 border-b px-4">
      <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-glow/30 to-transparent" />
      <div className="flex shrink-0 items-center gap-2.5 whitespace-nowrap pr-4">
        <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
          <rect width="32" height="32" rx="8" fill="#121A27" stroke="rgba(255,255,255,0.14)" />
          <path d="M8 23l8-14 8 14" stroke="#7CC8FF" strokeWidth="2.6" fill="none" strokeLinejoin="round" style={{ filter: 'drop-shadow(0 0 3px rgba(124,200,255,0.7))' }} />
          <circle cx="16" cy="9" r="2.2" fill="#7CC8FF" />
        </svg>
        <span className="text-[15px] font-semibold tracking-wide text-ink">EXIT-LINK</span>
        <span className="hidden font-mono text-[10px] tracking-[0.2em] text-ink-3 xl:inline">COMMAND CENTER</span>
      </div>

      <div className="flex min-w-0 items-center gap-2">
        <span className="text-2xs uppercase tracking-[0.08em] text-ink-3">시나리오</span>
        {order.length === 0 ? (
          <span className="text-xs text-ink-3">없음 — 제어 패널에서 생성</span>
        ) : (
          <select
            value={activeId ?? ''}
            onChange={(e) => setActive(e.target.value || null)}
            className="h-7 max-w-[260px] rounded-full border border-white/10 bg-white/[0.04] px-3 font-mono text-xs text-ink outline-none transition hover:border-white/20 focus:border-glow/60"
          >
            {order.map((id, i) => (
              <option key={id} value={id}>
                #{i + 1} · {id.slice(0, 8)} · rev {scenarios[id]?.state.revision}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="ml-auto flex items-center gap-2">
        <Pill title={connError ?? `WebSocket ${c.label}`}>
          <Dot color={c.color} pulse={conn === 'open'} /> WS {c.label}
        </Pill>
        <Pill title={network?.monitor_error ?? '마지막 실제 TCP 관측 시각'}>
          <Dot color={obsColor} /> TCP 관측{' '}
          {obs === 'observed' ? ago(network?.observed_at, now) : obs === 'error' ? '오류' : obs === 'not_observed' ? '미관측' : '—'}
        </Pill>
        <Pill hideBelowLg title={experiment?.last_error ?? (experiment?.enabled ? '실험 제어 활성' : '실험 제어 비활성(EXIT_LINK_ENABLE_EXPERIMENTS)')}>
          <Dot color={expColor} /> 실험 {experiment ? experiment.status : '—'}
          {network && <span className="font-mono text-ink-3">{network.configuration_source === 'owned_experiment' ? 'owned' : 'project'}</span>}
        </Pill>
        <button
          onClick={() => setControlOpen(true)}
          className={cx(
            'flex h-7 items-center gap-1.5 rounded-full border px-3 text-2xs transition',
            hasToken ? 'border-action/45 bg-action/10 text-action shadow-glow-action hover:bg-action/15' : 'border-white/10 bg-white/[0.04] text-ink-2 hover:border-white/25 hover:text-ink',
          )}
          title="제어 패널 열기"
        >
          {hasToken ? <KeyRound size={13} /> : <Lock size={13} />}
          {hasToken ? '제어 가능' : '읽기 전용'}
          <SlidersHorizontal size={13} className="ml-1" />
        </button>
      </div>
    </header>
  );
}
