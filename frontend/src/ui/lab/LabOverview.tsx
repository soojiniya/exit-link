import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Archive, ArrowRight, ArrowUpRight, Clapperboard, Info } from 'lucide-react';
import { useApp } from '@/store/store';
import { useActiveScenario, useNetworkDerived } from '@/store/selectors';
import { timeOf } from '@/domain/format';
import { STRATA } from '@/domain/study';
import { loadManifest, loadReplayCase } from '@/domain/replayEngine';
import { caseFacts, type CaseFacts } from '@/ui/overview/recordedCases';
import { HudTile, type HudTone } from '@/ui/twin/HudTile';
import { Chip, SourceBadge, cx } from '../primitives';
import type { LabRecord, Origin, TimelineItem } from '@/store/types';

/**
 * Simulation Lab 상단 상태 · 진행 단계 · 결과 타임라인 · 저장된 실험 기록.
 * 모든 값은 스토어(실제 응답·WebSocket 수신값)와 저장된 정적 기록에서만 계산하며, 이 파일은 쓰기 요청을 하지 않습니다.
 */

/** 공통: 현재 실험 환경(LIVE)에서 파생한 값 */
export function useLabEnv() {
  const hasToken = useApp((s) => s.hasToken);
  const conn = useApp((s) => s.conn);
  const labLog = useApp((s) => s.labLog);
  const timeline = useApp((s) => s.timeline);
  const deliveries = useApp((s) => s.deliveryOrder.length);
  const scenarioCount = useApp((s) => s.scenarioOrder.length);
  const scenario = useActiveScenario();
  const { network, experiment, nodes } = useNetworkDerived();
  const observed = network?.observation_status === 'observed';
  const reachable = nodes.filter((n) => n.reachable === true).length;
  const allOffline = observed && nodes.length > 0 && nodes.every((n) => n.status === 'offline');
  return { hasToken, conn, labLog, timeline, deliveries, scenarioCount, scenario, network, experiment, nodes, observed, reachable, allOffline };
}
type Env = ReturnType<typeof useLabEnv>;

// ── A. 상태 헤더 ─────────────────────────────────────────────
export function LabStatusStrip({ env }: { env: Env }) {
  const { experiment, hasToken, network, observed, reachable, allOffline, nodes, scenario } = env;
  const st = experiment?.status;
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-5" data-testid="lab-status">
      <HudTile
        label="실험 상태"
        value={!experiment ? '정보 없음' : st === 'running' ? '실행 중' : st === 'starting' ? '시작 중' : st === 'stopping' ? '종료 중' : st === 'failed' ? '실패' : '정지'}
        sub={!experiment ? '백엔드 스냅샷 대기' : experiment.experiment_id ? `실험 ${experiment.experiment_id.slice(0, 8)}` : '실행 중인 실험 없음'}
        tone={st === 'running' ? 'ok' : st === 'starting' || st === 'stopping' ? 'warn' : st === 'failed' ? 'fail' : 'idle'}
        testId="lab-st-experiment"
      />
      <HudTile
        label="실험 실행"
        value={!experiment ? '확인 불가' : experiment.enabled ? '허용됨' : '비활성화'}
        sub={!experiment ? '백엔드 연결 필요' : experiment.enabled ? '서버 설정으로 허용' : '서버 설정 · 조회만 가능(오류 아님)'}
        tone={!experiment ? 'idle' : experiment.enabled ? 'info' : 'idle'}
        testId="lab-st-enabled"
      />
      <HudTile label="제어 권한" value={hasToken ? '토큰 적용됨' : '미설정'} sub={hasToken ? '이 탭 메모리에만 보관' : '쓰기 요청 불가'} tone={hasToken ? 'info' : 'idle'} testId="lab-st-token" />
      <HudTile
        label="TCP 노드"
        value={!network ? '관측 대기' : !observed ? '미관측' : allOffline ? '미실행' : `${reachable} / ${nodes.length} 응답`}
        sub={!network ? '백엔드 스냅샷 대기' : allOffline ? '노드 프로세스 미실행 · 장애 아님' : observed ? `관측 ${timeOf(network.observed_at)}` : network.observation_status}
        tone={!observed || allOffline ? 'idle' : nodes.some((n) => n.status === 'fail') ? 'fail' : reachable === nodes.length ? 'ok' : 'warn'}
        testId="lab-st-nodes"
      />
      <HudTile
        label="활성 시나리오"
        value={scenario ? `${scenario.state.scenario_id.slice(0, 8)} · rev ${scenario.state.revision}` : '없음'}
        sub={scenario ? `대피 경로 ${scenario.plans.length}개 · 가상(SIM)` : '시나리오를 생성하거나 선택'}
        tone={scenario ? 'info' : 'idle'}
        testId="lab-st-scenario"
      />
    </div>
  );
}

// ── B. 진행 단계 ─────────────────────────────────────────────
type StepState = 'ready' | 'active' | 'idle' | 'blocked' | 'attention';
const STEP_STYLE: Record<StepState, { label: string; color: string; tone: HudTone }> = {
  ready: { label: '준비됨', color: '#4FD39A', tone: 'ok' },
  active: { label: '진행 중', color: '#7CC8FF', tone: 'info' },
  idle: { label: '대기', color: '#B7C0CE', tone: 'neutral' },
  blocked: { label: '비활성', color: '#7C8799', tone: 'idle' },
  attention: { label: '확인 필요', color: '#E9954A', tone: 'warn' },
};
export interface LabStep { key: string; no: string; title: string; state: StepState; detail: string; target: string }

/** 단계 상태는 실제 상태(토큰·서버 설정·실험 상태·시나리오·기록 수)에서만 계산합니다. 임의의 '완료'는 만들지 않습니다. */
export function labSteps(e: Env): LabStep[] {
  const enabled = !!e.experiment?.enabled;
  const st = e.experiment?.status;
  const running = st === 'running';
  const records = e.labLog.length + e.timeline.length + e.deliveries;
  return [
    {
      key: 'env', no: '01', title: '환경 및 권한 확인', target: 'lab-sec-env',
      state: !e.experiment ? 'blocked' : e.hasToken && enabled ? 'ready' : e.hasToken ? 'attention' : 'blocked',
      detail: !e.experiment ? '백엔드 연결 필요' : e.hasToken && enabled ? '토큰 적용 · 실험 허용' : e.hasToken ? '토큰 적용 · 실험 실행은 서버에서 비활성화' : '제어 토큰 미설정',
    },
    {
      key: 'scenario', no: '02', title: '시나리오 구성', target: 'lab-sec-scenario',
      state: e.scenario ? 'ready' : e.hasToken ? 'idle' : 'blocked',
      detail: e.scenario ? `활성 ${e.scenario.state.scenario_id.slice(0, 8)} · rev ${e.scenario.state.revision}` : e.hasToken ? '시나리오 없음 · 생성 가능' : '토큰이 있어야 생성 가능',
    },
    {
      key: 'run', no: '03', title: '실험 실행', target: 'lab-sec-run',
      state: running || st === 'starting' || st === 'stopping' ? 'active' : st === 'failed' ? 'attention' : enabled && e.hasToken ? 'idle' : 'blocked',
      detail: running ? `실행 중 · 노드 ${e.experiment?.nodes.filter((n) => n.running).length ?? 0}개` : st === 'failed' ? e.experiment?.last_error ?? '실험 실패 기록' : !enabled ? '서버에서 실험 실행 비활성화' : e.hasToken ? '시작 가능(실제 프로세스 6개)' : '토큰 필요',
    },
    {
      key: 'control', no: '04', title: '장애 및 메시지 제어', target: 'lab-sec-control',
      state: running && e.hasToken ? 'idle' : 'blocked',
      detail: running && e.hasToken ? (e.scenario ? '장애 주입·안내 전송 가능' : '장애 주입 가능 · 안내 전송은 시나리오 필요') : '실험 실행 중에만 가능',
    },
    {
      key: 'results', no: '05', title: '결과 및 로그 확인', target: 'lab-sec-results',
      state: records ? 'ready' : 'idle',
      detail: records ? `기록 ${records}건(이 탭 요청 ${e.labLog.length} · 수신 이벤트 ${e.timeline.length} · 전송 결과 ${e.deliveries})` : '아직 기록 없음',
    },
  ];
}

export function LabStepper({ steps }: { steps: LabStep[] }) {
  return (
    <ol className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-5" aria-label="실험 진행 단계" data-testid="lab-steps">
      {steps.map((s, i) => {
        const v = STEP_STYLE[s.state];
        return (
          <li key={s.key} className="relative">
            <button
              type="button"
              onClick={() => document.getElementById(s.target)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              data-testid={`lab-step-${s.key}`}
              data-state={s.state}
              className="lift spotlight glass group flex h-full w-full flex-col rounded-2xl px-4 py-3 text-left hover:border-white/20"
              style={{ boxShadow: `inset 0 1px 0 rgba(255,255,255,0.06), 0 0 0 1px ${v.color}${s.state === 'blocked' || s.state === 'idle' ? '22' : '44'}` }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[12px] text-ink-3">{s.no}</span>
                <span className="flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ color: v.color, background: `${v.color}18` }}>
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: v.color }} />
                  {v.label}
                </span>
              </div>
              <div className="mt-1.5 text-[15px] font-medium text-ink">{s.title}</div>
              <div className="mt-0.5 text-[12px] leading-snug text-ink-3">{s.detail}</div>
            </button>
            {i < steps.length - 1 && <span aria-hidden className="absolute -right-[7px] top-1/2 hidden h-px w-3 bg-white/15 xl:block" />}
          </li>
        );
      })}
    </ol>
  );
}

// ── 현재 실험 환경(체크리스트) ─────────────────────────────
export function EnvChecklist({ env }: { env: Env }) {
  const { experiment, hasToken, network, observed, allOffline, reachable, nodes, scenario, conn } = env;
  const items: { k: string; v: string; tone: HudTone }[] = [
    { k: '백엔드 연결', v: conn === 'open' ? '연결됨' : conn === 'reconnecting' ? '연결 끊김 · 재연결 중' : '연결 대기', tone: conn === 'open' ? 'ok' : conn === 'reconnecting' ? 'fail' : 'idle' },
    { k: '실험 실행', v: !experiment ? '확인 불가' : experiment.enabled ? '허용됨' : '비활성화', tone: experiment?.enabled ? 'info' : 'idle' },
    { k: 'TCP 노드', v: !network ? '관측 대기' : !observed ? '미관측' : allOffline ? '미실행' : `${reachable}/${nodes.length} 응답`, tone: !observed || allOffline ? 'idle' : reachable === nodes.length ? 'ok' : 'warn' },
    { k: '활성 시나리오', v: scenario ? `rev ${scenario.state.revision}` : '없음', tone: scenario ? 'info' : 'idle' },
    { k: '제어 권한', v: hasToken ? '토큰 적용됨' : '미설정', tone: hasToken ? 'info' : 'idle' },
  ];
  const color: Record<HudTone, string> = { ok: '#4FD39A', info: '#8FD3FF', warn: '#F2A766', fail: '#FF7A7E', idle: '#8D98AB', neutral: '#E8ECF2' };
  return (
    <div className="mt-5 rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4" data-testid="lab-env">
      <div className="mb-2 font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-3">현재 실험 환경</div>
      <dl className="divide-y divide-white/[0.05]">
        {items.map((i) => (
          <div key={i.k} className="flex items-center justify-between py-1.5 text-[13px]">
            <dt className="text-ink-3">{i.k}</dt>
            <dd className="flex items-center gap-2" style={{ color: color[i.tone] }}>
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: color[i.tone] }} />
              {i.v}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-[11.5px] leading-relaxed text-ink-3">회색은 미실행·미관측·비활성 상태이며 장애가 아닙니다. 빨간색은 실제로 확인된 장애·실패에만 씁니다.</p>
    </div>
  );
}

// ── 비활성화 안내 ───────────────────────────────────────────
export function DisabledNotice({ env }: { env: Env }) {
  if (env.experiment?.enabled) return null;
  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-white/[0.08] bg-white/[0.025] px-5 py-4 md:flex-row md:items-center md:justify-between" data-testid="lab-disabled-notice">
      <div className="flex items-start gap-3">
        <Info size={17} className="mt-0.5 shrink-0 text-ink-3" />
        <div>
          <div className="text-[14px] text-ink">
            {env.experiment ? '현재 실험 실행이 비활성화되어 있습니다. 기존에 측정된 실험 기록은 REPLAY에서 확인할 수 있습니다.' : '백엔드 실험 상태를 아직 받지 못했습니다. 저장된 실험 기록은 REPLAY에서 확인할 수 있습니다.'}
          </div>
          <div className="mt-0.5 text-[12.5px] text-ink-3">
            서버 설정(<code className="font-mono">EXIT_LINK_ENABLE_EXPERIMENTS</code>)에 따른 정상 상태이며 장애나 오류가 아닙니다. 이 화면은 실험을 시작하거나 메시지를 보내지 않습니다.
          </div>
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        <button type="button" onClick={() => document.getElementById('lab-sec-recorded')?.scrollIntoView({ behavior: 'smooth', block: 'start' })} className="lift inline-flex h-9 items-center gap-1.5 rounded-full border border-[#A9C7FF]/35 bg-[#A9C7FF]/[0.08] px-3.5 text-[12.5px] text-[#DCE8FF]">
          <Archive size={13} /> 저장된 실험 기록
        </button>
        <Link to="/twin?mode=replay&case=t010" className="lift inline-flex h-9 items-center gap-1.5 rounded-full border border-white/12 bg-white/[0.04] px-3.5 text-[12.5px] text-ink">
          REPLAY <ArrowRight size={13} />
        </Link>
      </div>
    </div>
  );
}

// ── 구역 카드 ───────────────────────────────────────────────
export function StepCard({ id, no, title, desc, right, children, className }: { id?: string; no?: string; title: string; desc?: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section id={id} className={cx('glass scroll-mt-4 rounded-[22px] p-5', className)} aria-labelledby={id ? `${id}-t` : undefined}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            {no && <span className="font-mono text-[12px] text-ink-3">{no}</span>}
            <h2 id={id ? `${id}-t` : undefined} className="text-[17px] font-medium tracking-[-0.01em] text-ink">{title}</h2>
          </div>
          {desc && <p className="mt-0.5 text-[12.5px] text-ink-3">{desc}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

// ── D. 결과 · 기록 타임라인 ─────────────────────────────────
type Cat = 'experiment' | 'node' | 'message' | 'route' | 'ack' | 'error' | 'scenario';
const CAT: Record<Cat, { label: string; color: string }> = {
  experiment: { label: '실험', color: '#A9C7FF' },
  node: { label: '노드', color: '#B7C0CE' },
  message: { label: '메시지', color: '#7CC8FF' },
  route: { label: '경로', color: '#E9954A' },
  ack: { label: 'ACK', color: '#4FD39A' },
  error: { label: '오류·실패', color: '#FF7A7E' },
  scenario: { label: '시나리오', color: '#8D98AB' },
};
interface Row { id: string; at: string; origin: Origin; cat: Cat; title: string; detail?: string; http?: string; ok: boolean }

function catOfTimeline(t: TimelineItem): Cat {
  if (t.severity === 'fail') return 'error';
  if (t.kind === 'experiment.changed') return 'experiment';
  if (/ACK/.test(t.title)) return 'ack';
  if (t.kind === 'route.changed' || /경로/.test(t.title)) return 'route';
  if (t.kind === 'scenario.changed') return 'scenario';
  if (t.kind === 'guidance.result' || /송신|중계|수신|전송|재전송|안내/.test(t.title)) return 'message';
  return 'node';
}
function catOfLab(r: LabRecord): Cat {
  if (!r.ok || r.observed === 'bad') return 'error';
  return r.kind === 'experiment' ? 'experiment' : r.kind === 'node' || r.kind === 'network' ? 'node' : r.kind === 'guidance' ? 'message' : r.kind === 'plan' ? 'route' : 'scenario';
}

/**
 * 결과 · 기록 타임라인. 실제로 받은 것만 씁니다.
 *  - CTRL: 이 탭에서 실행한 제어 요청과 HTTP 응답(labLog)
 *  - LIVE/SIM: WebSocket 으로 수신한 이벤트(timeline)
 */
export function LabTimeline() {
  const labLog = useApp((s) => s.labLog);
  const timeline = useApp((s) => s.timeline);
  const [filter, setFilter] = useState<Cat | 'all'>('all');
  const rows = useMemo<Row[]>(() => {
    const a: Row[] = labLog.map((r) => ({
      id: `l-${r.id}`, at: r.at, origin: 'CTRL', cat: catOfLab(r), title: r.label + (r.target ? ` · ${r.target}` : ''),
      detail: r.ok ? r.summary : `${r.code ?? ''} — ${r.message ?? ''}`, http: r.ok ? '200' : String(r.status || 'ERR'), ok: r.ok && r.observed !== 'bad',
    }));
    const b: Row[] = timeline.map((t) => ({ id: `t-${t.id}`, at: t.at, origin: t.origin, cat: catOfTimeline(t), title: t.title, detail: t.detail, ok: t.severity !== 'fail' }));
    return [...a, ...b].sort((x, y) => Date.parse(y.at) - Date.parse(x.at));
  }, [labLog, timeline]);
  const shown = filter === 'all' ? rows : rows.filter((r) => r.cat === filter);
  const counts = useMemo(() => rows.reduce<Partial<Record<Cat, number>>>((m, r) => ((m[r.cat] = (m[r.cat] ?? 0) + 1), m), {}), [rows]);

  return (
    <div data-testid="lab-timeline">
      <div className="mb-3 flex flex-wrap items-center gap-1.5" role="group" aria-label="기록 필터">
        <FilterChip on={filter === 'all'} onClick={() => setFilter('all')} label={`전체 ${rows.length}`} />
        {(Object.keys(CAT) as Cat[]).map((c) => (
          <FilterChip key={c} on={filter === c} onClick={() => setFilter(c)} label={`${CAT[c].label} ${counts[c] ?? 0}`} color={CAT[c].color} disabled={!counts[c]} />
        ))}
      </div>
      {!rows.length ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-white/12 px-4 py-10 text-center" data-testid="lab-timeline-empty">
          <div className="text-[14px] text-ink-2">아직 기록이 없습니다</div>
          <p className="mt-1 max-w-[520px] text-[12.5px] leading-relaxed text-ink-3">
            이 탭에서 실행한 제어 요청과 실시간으로 받은 실험 시작·종료, 노드 상태, 메시지 전달, 경로 선택, ACK, 오류 이벤트가 시간 순으로 표시됩니다. 가상의 기록은 만들지 않습니다.
          </p>
        </div>
      ) : (
        <ol className="panel-scroll relative max-h-[420px] space-y-1.5 border-l border-white/[0.08] pl-4">
          {shown.map((r) => (
            <li key={r.id} className="relative">
              <span className="absolute -left-[21px] top-3 h-2.5 w-2.5 rounded-full border-2 border-[#0b111a]" style={{ background: CAT[r.cat].color }} />
              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-xl px-3 py-2 transition hover:bg-white/[0.03]">
                <span className="w-[66px] shrink-0 font-mono text-[11px] text-ink-3">{timeOf(r.at)}</span>
                <SourceBadge origin={r.origin} />
                <span className="text-[11px] font-medium" style={{ color: CAT[r.cat].color }}>{CAT[r.cat].label}</span>
                <span className={cx('min-w-0 flex-1 text-[13px]', r.ok ? 'text-ink' : 'text-[#FFB3B6]')}>{r.title}</span>
                {r.http && <span className={cx('font-mono text-[11px]', r.http === '200' ? 'text-ok' : 'text-[#F2878A]')}>HTTP {r.http}</span>}
                {r.detail && <span className="basis-full pl-[78px] text-[11.5px] text-ink-3">{r.detail}</span>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
function FilterChip({ on, onClick, label, color, disabled }: { on: boolean; onClick: () => void; label: string; color?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
      className={cx('lift rounded-full border px-2.5 py-1 text-[12px] disabled:cursor-not-allowed disabled:opacity-35', on ? 'border-white/30 bg-white/[0.08] text-ink' : 'border-white/10 text-ink-2 hover:border-white/20')}
    >
      {color && <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle" style={{ background: color }} />}
      {label}
    </button>
  );
}

// ── 저장된 실험 기록 ─────────────────────────────────────────
export function RecordedShortcuts() {
  const [facts, setFacts] = useState<CaseFacts[] | null>(null);
  const [problem, setProblem] = useState('');
  useEffect(() => {
    const ctl = new AbortController();
    loadManifest(ctl.signal)
      .then((m) => Promise.all(m.cases.map((e) => loadReplayCase(e, ctl.signal).then((c) => caseFacts(e, c)))))
      .then(setFacts)
      .catch((e: unknown) => { if (!ctl.signal.aborted) setProblem(String(e)); });
    return () => ctl.abort();
  }, []);
  const strata = useMemo(() => new Map(STRATA.map((s) => [s.scope, s.label])), []);
  return (
    <div data-testid="lab-recorded">
      {problem && <div role="alert" className="mb-3 rounded-xl border border-[#E9954A]/40 bg-[#E9954A]/[0.06] px-4 py-3 text-[13px] text-[#F6C79A]">저장된 실험 기록을 불러오지 못했습니다: {problem}</div>}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        {!facts && !problem && [0, 1, 2].map((i) => <div key={i} className="glass-inset h-[170px] animate-pulse rounded-2xl" />)}
        {facts?.map((f) => {
          const [cond, timing] = f.condition.split(' · ');
          const failed = f.acked < f.total;
          return (
            <article key={f.id} className="glass-inset spotlight lift group relative flex flex-col rounded-2xl p-4 hover:border-white/20" data-testid={`lab-case-${f.id}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[12px] text-ink-3">{f.id} · 저장된 기록</span>
                <span className="flex gap-1.5">
                  <Chip tone={f.method === 'Fixed' ? 'neutral' : 'action'}>{f.method}</Chip>
                  <Chip>{strata.get(`${cond}/${timing ?? 'none'}`) ?? f.condition}</Chip>
                </span>
              </div>
              <h3 className="mt-2 text-[16px] font-medium text-ink">{f.title}</h3>
              <div className="mt-2 font-mono text-[12.5px]">
                {f.reroute ? (
                  <span><s className="text-[#FF9EA1]/80">{f.reroute.from?.join('→')}</s> <span className="text-ink-3">⇒</span> <span className="text-[#BFE4FF]">{f.reroute.to.join('→')}</span></span>
                ) : (
                  <span className={failed ? 'text-[#FFB3B6]' : 'text-[#BFE4FF]'}>{f.firstRoute?.join('→') ?? '경로 기록 없음'}</span>
                )}
              </div>
              <div className="mt-1.5 text-[12px] text-ink-3">
                ACK <span className={failed ? (f.acked ? 'text-[#F4BB87]' : 'text-[#FF9EA1]') : 'text-[#7CE0B2]'}>{f.acked}/{f.total}</span>
                {' · '}장애 {f.faults.length ? f.faults.map((x) => x.node).join('·') : '없음'}
                {' · '}재전송 {f.retries}회
              </div>
              <div className="mt-auto flex items-center justify-between pt-4">
                <Link to={`/twin?mode=cinematic&case=${f.id}`} data-testid={`lab-case-${f.id}-cinematic`} aria-label={`${f.id} ${f.title} CINEMATIC 으로 보기`} className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-[#CFEAFF] after:absolute after:inset-0 after:rounded-2xl after:content-['']">
                  <Clapperboard size={13} /> CINEMATIC
                </Link>
                <span className="relative z-10 flex gap-1.5">
                  <Link to={`/twin?mode=replay&case=${f.id}`} data-testid={`lab-case-${f.id}-replay`} className="inline-flex items-center gap-1 rounded-full border border-white/12 bg-white/[0.04] px-2.5 py-0.5 text-[11.5px] text-ink-2 hover:text-ink">3D REPLAY <ArrowUpRight size={11} /></Link>
                  <Link to={`/network?mode=replay&case=${f.id}`} data-testid={`lab-case-${f.id}-network`} className="inline-flex items-center gap-1 rounded-full border border-white/12 bg-white/[0.04] px-2.5 py-0.5 text-[11.5px] text-ink-2 hover:text-ink">Network <ArrowUpRight size={11} /></Link>
                </span>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
