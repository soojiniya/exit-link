import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AlertCircle, AlertTriangle, ChevronDown, ChevronLeft, ChevronRight, Code2, Crosshair, Footprints, History, PanelRightClose, PanelRightOpen, Pause, Play, RotateCcw, X,
} from 'lucide-react';
import type { Place } from '@contracts';
import type { LinkState, NodeState } from '@/domain/network';
// 기록 해석(시간·경로·노드·링크 상태)은 Network Monitor · Digital Twin 과 같은 공통 엔진만 씁니다.
import {
  STAGE_COLOR, STAGE_LABEL, describeEvent, linkViewsAt, loadManifest, loadReplayCase, messageEvents, messageProgressAt, neighborViews,
  nodeViewsAt, replayDuration, timelineMarks, type Manifest, type MessageProgress, type ReplayCase, type ReplayEvent, type TimelineKind,
} from '@/domain/replayEngine';
import { pulsesAt, routeSweepAt } from '@/ui/replay/cinematicDirector';
import { useReplayPlayback } from '@/ui/replay/useReplayPlayback';
import { FILTERS, categoryOf, colorOf, failureEvents, fmtT, messageTag, previousRecordedRoute, titleOf, type EventFilter } from '@/ui/replay/inspector';
import { TopologyFlow, type TopologyReplayOverlay } from '@/ui/network/TopologyFlow';
import { LegendCard } from '@/ui/network/NetworkHud';
import { HudTile } from '@/ui/twin/HudTile';
import { Dot, Empty, cx } from '@/ui/primitives';
import { useApp } from '@/store/store';

/**
 * REPLAY · Playback Inspector.
 * 저장된 실험 기록(public/replay/*.json)만 읽는 읽기 전용 분석 화면입니다. LIVE WebSocket·제어 API 를 쓰지 않으며, 백엔드 없이 동작합니다.
 * 건물 정의(층·위치 이름)는 앱이 이미 받은 값이 있으면 쓰고, 없으면 연결 관계만 유지한 개략 배치로 표시합니다.
 */
const SPEEDS = [0.1, 0.25, 0.5, 1, 2] as const;
const MARK: Record<TimelineKind, { color: string; text: string }> = {
  fault: { color: '#EF5A5F', text: '장애 확인' },
  send: { color: '#7CC8FF', text: '전송 시작' },
  ack: { color: '#3FC28A', text: 'ACK 수신' },
  error: { color: '#EF5A5F', text: '오류' },
  retry: { color: '#E9954A', text: '재전송 예약' },
  reroute: { color: '#E9954A', text: '경로 변경' },
};
const LEGEND: [string, string, 'solid' | 'dash'][] = [
  ['데이터 구간 · 도착 기록됨', '#7CC8FF', 'solid'],
  ['송신 후 도착 기록 전', '#7CC8FF', 'dash'],
  ['연결 시도 중 · 응답 기록 전', '#E08A3C', 'dash'],
  ['ACK 구간', '#3FB27F', 'solid'],
  ['연결 실패 · 이전 시도 경로', '#E5484D', 'dash'],
];
const EPS = 1e-6;
const mq = (q: string) => typeof window !== 'undefined' && !!window.matchMedia?.(q).matches;

export default function Replay() {
  const [params, setParams] = useSearchParams();
  const building = useApp((s) => s.building);
  const places = useMemo(() => new Map<string, Place>((building?.building.nodes ?? []).map((n) => [n.id, n])), [building]);

  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [caseId, setCaseId] = useState('');
  const [trial, setTrial] = useState<ReplayCase | null>(null);
  const [problem, setProblem] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [selNode, setSelNode] = useState<string | null>(null);
  const [selLink, setSelLink] = useState<string | null>(null);
  const [filter, setFilter] = useState<EventFilter>('all');
  const [nodeOnly, setNodeOnly] = useState<string | null>(null);
  const [inspected, setInspected] = useState<number | null>(null);
  const [rawOpen, setRawOpen] = useState(false);
  const [stepMode, setStepMode] = useState(false);
  const [insOpen, setInsOpen] = useState(() => mq('(min-width: 1280px)'));
  const [tableOpen, setTableOpen] = useState(() => mq('(min-height: 1150px)'));
  const initialT = useRef<number | null>(Number.isFinite(Number(params.get('t'))) && params.get('t') !== null ? Number(params.get('t')) : null);

  useEffect(() => {
    const ctl = new AbortController();
    loadManifest(ctl.signal)
      .then((m) => { setManifest(m); setCaseId(m.cases.find((c) => c.id === params.get('case'))?.id ?? m.cases[0]?.id ?? ''); })
      .catch((e: unknown) => { if (!ctl.signal.aborted) setProblem(`저장된 재생 목록을 확인할 수 없습니다: ${String(e)}`); });
    return () => ctl.abort();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const entry = manifest?.cases.find((c) => c.id === caseId);
    setTrial(null);
    setPicked(null); setSelNode(null); setSelLink(null); setNodeOnly(null); setInspected(null); setRawOpen(false); setFilter('all');
    if (!entry) return;
    setProblem('');
    if (params.get('case') !== caseId) setParams((p) => { const n = new URLSearchParams(p); n.set('case', caseId); n.delete('t'); return n; }, { replace: true });
    // 파일명 허용 목록·형식·사례 ID·시간 정렬 검증은 loadReplayCase 가 합니다(공통 엔진).
    const ctl = new AbortController();
    loadReplayCase(entry, ctl.signal)
      .then(setTrial)
      .catch((e: unknown) => { if (!ctl.signal.aborted) setProblem(`기록을 불러오지 못했습니다: ${String(e)}`); });
    return () => ctl.abort();
  }, [manifest, caseId]); // eslint-disable-line react-hooks/exhaustive-deps

  const duration = useMemo(() => (trial ? replayDuration(trial) : 1000), [trial]);
  const pb = useReplayPlayback(duration, 0.5);
  const { t } = pb;
  // 사례가 바뀌면 처음으로(주소에 t 가 있으면 첫 사례에서만 그 시각으로)
  const pbRef = useRef(pb);
  pbRef.current = pb;
  useEffect(() => {
    if (!trial) return;
    pbRef.current.reset();
    if (initialT.current !== null) { const x = initialT.current; initialT.current = null; window.setTimeout(() => pbRef.current.seek(x), 0); }
  }, [trial]);

  // ── 공통 엔진 계산(Network Monitor REPLAY 와 같은 호출) ──
  const progress = useMemo(() => (trial ? trial.messages.map((m) => messageProgressAt(trial, m, t)) : []), [trial, t]);
  const marks = useMemo(() => (trial ? timelineMarks(trial) : []), [trial]);
  const started = trial ? trial.messages.filter((m) => (m.started_offset_ms ?? 0) <= t) : [];
  // 토폴로지에 그릴 메시지: 포커스(카드 선택) > 인스펙터에서 고른 이벤트의 메시지 > 자동 추적(가장 최근 시작)
  const inspectedMsg = inspected !== null ? trial?.events.find((e) => e.seq === inspected)?.message_id ?? null : null;
  const following = picked === null && inspectedMsg === null;
  const sel: MessageProgress | undefined =
    progress.find((p) => p.messageId === picked) ?? progress.find((p) => p.messageId === inspectedMsg) ?? progress.find((p) => p.position === started[started.length - 1]?.position) ?? progress[0];
  const nodes: NodeState[] = useMemo(
    () => (trial ? nodeViewsAt(trial, t).map((n) => ({ id: n.id, locationId: n.locationId, status: n.status, reason: n.reason, reachable: null, observedAt: null })) : []),
    [trial, t],
  );
  const linkViews = useMemo(() => (trial ? linkViewsAt(trial, t) : []), [trial, t]);
  const links: LinkState[] = useMemo(() => linkViews.map(({ a, b, status, detail }) => ({ a, b, status, detail })), [linkViews]);
  const nb = useMemo(() => (trial ? neighborViews(trial, t) : new Map<string, string>()), [trial, t]);
  const overlay: TopologyReplayOverlay | undefined = useMemo(() => {
    if (!trial || !sel) return undefined;
    return {
      nodeNote: (id) => {
        const n = nodes.find((x) => x.id === id);
        if (n?.status === 'fail') return 'REPLAY · 장애 확인 기록';
        if (n?.status === 'warn') return 'REPLAY · 이웃 판정 기록';
        return 'REPLAY · 상태 기록 없음';
      },
      neighborStatus: (from, to) => nb.get(`${from}>${to}`),
      route: sel.route,
      previousRoute: sel.previousRoute,
      legs: sel.legs,
      excludedLinks: sel.excludedLinks,
      markers: progress
        .filter((p) => p.marker)
        .map((p) => ({ key: p.messageId, from: p.marker!.from, to: p.marker!.to, frac: p.marker!.frac, kind: p.marker!.kind, label: `M${p.position}`, selected: p.messageId === sel.messageId })),
      pulses: pulsesAt(trial, t),
      sweep: routeSweepAt(trial, t, sel.messageId),
      failed: sel.stage === 'failed',
    };
  }, [trial, t, sel, progress, nodes, nb]);

  // ── 이벤트 목록(필터 · 메시지 포커스 · 노드) ──
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: trial?.events.length ?? 0 };
    for (const e of trial?.events ?? []) c[categoryOf(e)] = (c[categoryOf(e)] ?? 0) + 1;
    return c;
  }, [trial]);
  const list = useMemo(() => {
    if (!trial) return [];
    return trial.events.filter((e) => {
      if (filter !== 'all' && categoryOf(e) !== filter) return false;
      // 메시지 포커스: 그 메시지의 이벤트 + 맥락이 되는 장애 확인 기록
      if (picked && e.message_id !== picked && e.event !== 'fault_confirmed') return false;
      if (nodeOnly && e.node !== nodeOnly && e.neighbor !== nodeOnly) return false;
      return true;
    });
  }, [trial, filter, picked, nodeOnly]);
  const lastEv = trial ? [...trial.events].reverse().find((e) => e.offset_ms <= t + EPS) ?? null : null;
  const curInList = [...list].reverse().find((e) => e.offset_ms <= t + EPS) ?? null;
  const nextEv = list.find((e) => e.offset_ms > t + EPS) ?? null;
  const prevEv = [...list].reverse().find((e) => e.offset_ms < t - EPS) ?? null;

  const go = useCallback((x: number) => { pbRef.current.setPlaying(false); pbRef.current.seek(x); }, []);
  const jumpTo = useCallback((e: ReplayEvent) => { setInspected(e.seq); go(e.offset_ms); }, [go]);

  // Event Step Mode: 재생하면 다음 이벤트(현재 필터 기준)에서 멈춥니다.
  const stopAt = useRef<{ t: number; seq: number } | null>(null);
  const play = () => {
    if (pb.playing) { pb.setPlaying(false); stopAt.current = null; return; }
    if (stepMode) {
      if (!nextEv) return;
      stopAt.current = { t: nextEv.offset_ms, seq: nextEv.seq };
    } else { stopAt.current = null; setInspected(null); }
    pb.toggle();
  };
  useEffect(() => {
    const s = stopAt.current;
    if (!s) return;
    if (!pb.playing) { stopAt.current = null; return; }
    if (t >= s.t - EPS) { stopAt.current = null; pb.setPlaying(false); pb.seek(s.t); setInspected(s.seq); }
  }, [t, pb.playing]); // eslint-disable-line react-hooks/exhaustive-deps

  // 단축키: Space 재생 · ←/→ 이전·다음 이벤트 · Home 처음 (입력 요소 위에서는 동작하지 않음)
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement | null;
    if (!trial || e.altKey || e.ctrlKey || e.metaKey || (el && (el.closest('input,select,textarea,[role=radiogroup],[role=tablist]') || el.isContentEditable))) return;
    if (e.key === ' ') { e.preventDefault(); play(); }
    else if (e.key === 'ArrowRight' && nextEv) { e.preventDefault(); jumpTo(nextEv); }
    else if (e.key === 'ArrowLeft' && prevEv) { e.preventDefault(); jumpTo(prevEv); }
    else if (e.key === 'Home') { e.preventDefault(); pb.reset(); setInspected(null); }
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  // 현재 이벤트를 인스펙터 목록 안에서만 보이게(페이지는 스크롤하지 않음)
  const listBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = listBox.current;
    const seq = inspected ?? curInList?.seq;
    if (!box || seq === undefined || seq === null) return;
    const el = box.querySelector<HTMLElement>(`[data-seq="${seq}"]`);
    if (!el) return;
    const top = el.offsetTop - box.offsetTop;
    if (top < box.scrollTop || top + el.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTo({ top: top - box.clientHeight / 3, behavior: mq('(prefers-reduced-motion: reduce)') ? 'auto' : 'smooth' });
  }, [curInList?.seq, inspected, insOpen, list.length]);

  // ── 화면 ──
  if (!trial || !sel) {
    return (
      <div className="panel-scroll h-full">
        <div className="mx-auto max-w-[1100px] px-8 pt-12">
          <PageTitle />
          <div className="mt-8">
            {problem ? (
              <p role="alert" className="flex items-center gap-2 text-sm text-[#F4BB87]"><AlertCircle size={16} />{problem}</p>
            ) : manifest && !manifest.cases.length ? (
              <Empty title="검증된 재생 기록이 없습니다" hint="원본 기록을 검증한 뒤 정적 JSON을 가져와야 합니다. 예시 이벤트는 임의로 표시하지 않습니다." />
            ) : (
              <Empty title="저장된 기록을 불러오는 중입니다" hint="public/replay/manifest.json" />
            )}
          </div>
        </div>
      </div>
    );
  }

  const entry = manifest?.cases.find((c) => c.id === caseId);
  const pct = (x: number) => `${Math.min(100, Math.max(0, (x / duration) * 100)).toFixed(3)}%`;
  const ackSoFar = progress.filter((p) => p.stage === 'acked').length;
  const failedSoFar = progress.filter((p) => p.stage === 'failed').length;
  const faultsNow = nodes.filter((n) => n.status === 'fail').map((n) => n.id);
  const suspectNow = nodes.filter((n) => n.status === 'warn').map((n) => n.id);
  const unplaced = places.size === 0;
  const inspectedEv = inspected !== null ? trial.events.find((e) => e.seq === inspected) ?? null : null;
  const fails = failureEvents(trial);
  const failedMsgs = trial.messages.filter((m) => m.result?.ack === false);
  const pickedMsg = picked ? trial.messages.find((m) => m.message_id === picked) ?? null : null;
  const methodLabel = trial.cell.method === 'fixed' ? 'Fixed' : 'EXIT-LINK';

  const onCaseKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const ids = manifest?.cases.map((c) => c.id) ?? [];
    const i = ids.indexOf(caseId);
    const n = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? i - 1 : null;
    if (n === null || !ids.length) return;
    e.preventDefault();
    const next = ids[(n + ids.length) % ids.length];
    setCaseId(next);
    window.setTimeout(() => document.querySelector<HTMLElement>(`[data-testid="rp-case-${next}"]`)?.focus(), 0);
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto lg:overflow-hidden" data-testid="rp-root">
      {/* ── A. Playback Control Center ── */}
      <section className="glass-chrome relative z-20 shrink-0 border-b px-4 pb-3 pt-3.5 md:px-6" aria-label="재생 제어">
        <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
          <div className="min-w-[240px] flex-1">
            <div className="eyebrow">REPLAY · Playback Inspector</div>
            <h1 className="mt-1.5 text-[clamp(22px,2vw,30px)] font-light leading-none tracking-[-0.03em] text-ink"><span className="text-sheen font-normal">실험 기록 재생 분석</span></h1>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="pill w-fit border-ice/40 bg-ice/[0.08] text-[11.5px] font-semibold text-ice" data-testid="replay-badge"><History size={12} /> REPLAY · 저장된 실험 기록 · 실시간 아님</span>
              <span className="pill border-white/10 bg-white/[0.03] text-[11.5px] text-ink-2" data-testid="rp-cell">{methodLabel} · {trial.cell.condition}{trial.cell.fault_timing && trial.cell.fault_timing !== 'none' ? ` · ${trial.cell.fault_timing}` : ''}</span>
            </div>
          </div>
          {/* 사례 선택: 라디오 그룹(←/→ 키로 이동) */}
          <div role="radiogroup" aria-label="재생 사례" onKeyDown={onCaseKey} className="grid w-full grid-cols-1 gap-2 sm:grid-cols-3 xl:w-auto xl:min-w-[720px]">
            {manifest?.cases.map((c) => {
              const on = c.id === caseId;
              return (
                <button
                  key={c.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  tabIndex={on ? 0 : -1}
                  data-testid={`rp-case-${c.id}`}
                  onClick={() => setCaseId(c.id)}
                  className={cx('lift spotlight min-w-0 rounded-2xl border px-3.5 py-2 text-left transition', on ? 'border-[#7CC8FF]/55 bg-[#7CC8FF]/[0.09] shadow-[0_0_0_1px_rgba(124,200,255,0.25),0_0_28px_-12px_#7CC8FF]' : 'border-white/[0.09] bg-white/[0.025] hover:border-white/20')}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className={cx('truncate text-[13.5px] font-medium', on ? 'text-ink' : 'text-ink-2')}>{c.title}</span>
                    <span className="shrink-0 font-mono text-[11px] text-ink-3">{c.id}</span>
                  </div>
                  <div className="rp-short-hide mt-0.5 truncate text-[11.5px] text-ink-3" title={c.description}>{c.description}</div>
                </button>
              );
            })}
          </div>
        </div>

        {/* 재생 컨트롤 */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <IconBtn label="초기화" title="처음으로(Home)" onClick={() => { pb.reset(); setInspected(null); stopAt.current = null; }}><RotateCcw size={14} /></IconBtn>
          <IconBtn label="이전 이벤트" title="이전 이벤트(←) · 현재 필터 기준" disabled={!prevEv} onClick={() => prevEv && jumpTo(prevEv)}><ChevronLeft size={16} /></IconBtn>
          <button
            type="button"
            onClick={play}
            aria-label={pb.playing ? '일시정지' : stepMode ? '다음 이벤트까지 재생' : '재생'}
            disabled={!pb.playing && stepMode && !nextEv}
            className="lift inline-flex h-8 min-w-[104px] items-center justify-center gap-1.5 rounded-full bg-gradient-to-b from-[#F4F8FF] to-[#C6D6EC] px-3.5 text-[13px] font-semibold text-[#0A1220] shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_6px_18px_-8px_rgba(124,200,255,0.7)] hover:brightness-110 disabled:opacity-50"
          >
            {pb.playing ? <Pause size={14} /> : <Play size={14} />} {pb.playing ? '일시정지' : stepMode ? '다음까지' : '재생'}
          </button>
          <IconBtn label="다음 이벤트" title="다음 이벤트(→) · 현재 필터 기준" disabled={!nextEv} onClick={() => nextEv && jumpTo(nextEv)}><ChevronRight size={16} /></IconBtn>
          <button
            type="button"
            aria-pressed={stepMode}
            data-testid="rp-step-mode"
            onClick={() => setStepMode((s) => !s)}
            title="Event Step Mode: 재생하면 다음 이벤트에서 자동으로 멈춥니다"
            className={cx('lift inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12.5px] transition', stepMode ? 'border-[#7CC8FF]/60 bg-[#7CC8FF]/[0.14] text-[#DDF1FF]' : 'border-white/10 bg-white/[0.04] text-ink-2 hover:text-ink')}
          >
            <Footprints size={13} /> 스텝 모드
          </button>
          <div className="seg" role="tablist" aria-label="재생 속도">
            {SPEEDS.map((sp) => (
              <button key={sp} role="tab" aria-selected={pb.speed === sp} onClick={() => pb.setSpeed(sp)}>{sp}×</button>
            ))}
          </div>
          <div className="ml-auto flex items-baseline gap-2">
            <span className="font-mono text-[14px] tabular-nums text-ink" data-testid="rp-time" data-t={t} title="기록 시각 기준(benchmark_perf_ns, 관측 구간 시작 = 0) · 속도는 화면 진행만 바꿈">{fmtT(t)} <span className="text-ink-3">/ {fmtT(duration)}</span></span>
            <span className="hidden font-mono text-[11px] text-ink-3 sm:inline" data-testid="rp-time-raw">t = {Number(t.toFixed(4))} ms</span>
          </div>
        </div>

        {/* 타임라인 + 이벤트 마커 */}
        <div className="mt-2">
          <div className="relative h-4">
            {marks.map((m, i) => (
              <button key={i} type="button" onClick={() => { setInspected(null); go(m.t); }} title={`${m.label} · ${fmtT(m.t)}`} aria-label={`${m.label} ${fmtT(m.t)}`} className="absolute top-0 -translate-x-1/2" style={{ left: pct(m.t) }} data-testid={`rp-mark-${m.kind}`}>
                <span className={cx('block h-3 w-1.5 rounded-sm transition-transform hover:scale-125', m.kind === 'fault' && 'h-3 w-3 rotate-45 rounded-[3px]')} style={{ background: MARK[m.kind].color, boxShadow: `0 0 6px ${MARK[m.kind].color}` }} />
              </button>
            ))}
            {inspectedEv && <span aria-hidden className="pointer-events-none absolute -top-0.5 h-5 w-px bg-white/70" style={{ left: pct(inspectedEv.offset_ms) }} />}
          </div>
          <input type="range" min={0} max={duration} step="any" value={t} onChange={(e) => { setInspected(null); go(Number(e.target.value)); }} aria-label="기록 재생 위치" className="timeline-range w-full" style={{ ['--p' as string]: pct(t) }} />
          <div className="rp-short-hide mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-3">
            {(Object.keys(MARK) as TimelineKind[]).filter((k) => marks.some((m) => m.kind === k)).map((k) => (
              <span key={k} className="inline-flex items-center gap-1.5"><span className="h-2 w-1.5 rounded-sm" style={{ background: MARK[k].color }} />{MARK[k].text}</span>
            ))}
            <span className="ml-auto hidden md:inline">Space 재생 · ←/→ 이벤트 이동 · 속도는 화면 진행만 바꾸며 측정 지연은 그대로입니다</span>
          </div>
        </div>
      </section>

      {/* ── B. 중앙 + 오른쪽 ── */}
      <div className="flex shrink-0 flex-col lg:min-h-0 lg:flex-1 lg:flex-row">
        <div className="flex min-w-0 flex-col lg:min-h-0 lg:flex-1">
          {/* Network Playback: 위 상태 띠(겹치지 않음) + 토폴로지 */}
          <div className="nm-stage relative flex h-[520px] shrink-0 flex-col overflow-hidden lg:h-auto lg:min-h-[300px] lg:flex-1" data-testid="rp-topology" aria-label="네트워크 재생">
            <div className="rp-hud relative z-30 grid shrink-0 grid-cols-2 gap-2 px-4 pr-14 pt-3 lg:grid-cols-4 2xl:grid-cols-[repeat(3,minmax(0,1fr))_minmax(0,1.35fr)]">
              <HudTile
                label={`M${sel.position} 경로 ${following ? '· 자동 추적' : picked ? '· 포커스' : '· 선택 이벤트'}`}
                value={sel.route ? sel.route.join(' → ') : '경로 기록 없음'}
                sub={sel.previousRoute ? <span>이전 <s className="text-[#FFA9AC]">{sel.previousRoute.join('→')}</s> · 시도 {sel.attempt}</span> : `${STAGE_LABEL[sel.stage]} · 시도 ${sel.attempt || '—'}`}
                tone={sel.stage === 'failed' ? 'fail' : sel.previousRoute ? 'warn' : sel.stage === 'acked' ? 'ok' : 'info'}
                testId="rp-hud-route"
              />
              <HudTile label="ACK" value={`${ackSoFar} / ${trial.messages.length}`} sub={failedSoFar ? `미수신 ${failedSoFar}건(기록)` : '재생 위치까지 수신'} tone={failedSoFar ? 'fail' : ackSoFar ? 'ok' : 'idle'} testId="rp-hud-ack" />
              <HudTile
                label="장애"
                value={faultsNow.length ? faultsNow.join(' · ') : suspectNow.length ? `의심 ${suspectNow.join(' · ')}` : '확인 기록 없음'}
                sub={faultsNow.length ? '장애 확인 기록(fault_confirmed)' : suspectNow.length ? '이웃 판정 기록' : '정상으로 단정하지 않음'}
                tone={faultsNow.length ? 'fail' : suspectNow.length ? 'warn' : 'idle'}
                testId="rp-hud-fault"
              />
              <HudTile
                label={lastEv ? `현재 이벤트 · ${fmtT(lastEv.offset_ms)}` : '현재 이벤트'}
                value={lastEv ? titleOf(lastEv) : '재생 전 · 기록된 이벤트 없음'}
                sub={lastEv ? describeEvent(trial, lastEv) : '재생하거나 이벤트를 누르세요'}
                tone={!lastEv ? 'idle' : colorOf(lastEv) === '#EF5A5F' ? 'fail' : colorOf(lastEv) === '#E9954A' ? 'warn' : colorOf(lastEv) === '#3FC28A' ? 'ok' : 'info'}
                testId="rp-hud-event"
              />
            </div>
            <div className="relative min-h-0 flex-1">
              <TopologyFlow
                topology={{ nodes: trial.topology?.nodes.map((n) => ({ id: n.id, location_id: n.location_id ?? '' })) ?? [] }}
                network={null}
                nodes={nodes}
                links={links}
                places={places}
                pids={new Map()}
                flow={null}
                selected={selNode}
                onSelect={(id) => { setSelNode(id); setSelLink(null); if (id) setInsOpen(true); }}
                selectedLink={selLink}
                onSelectLink={(a, b) => { setSelLink(`${a}-${b}`); setSelNode(null); setInsOpen(true); }}
                replay={overlay}
                unplaced={unplaced}
              />
              <div aria-hidden className="stage-vignette pointer-events-none absolute inset-0" />
              <div className="absolute bottom-3 left-4 z-30 flex flex-col items-start gap-2">
                {unplaced && (
                  <span data-testid="rp-unplaced" className="pill border-white/12 bg-black/50 text-[11px] text-ink-2" title="층·위치 이름은 GET /api/v1/building 의 건물 정의를 씁니다. 받지 못하면 서·동 위치(배치 파일)와 기록의 노드 순서로 개략 배치합니다. 연결 관계는 기록 그대로입니다.">
                    건물 정의 미수신 · 노드 위치는 개략 배치(층 아님)
                  </span>
                )}
                <LegendCard title="범례">
                  {LEGEND.map(([l, c, st]) => (
                    <div key={l} className="flex items-center gap-2"><span className="w-6" style={{ borderTop: `3px ${st === 'dash' ? 'dashed' : 'solid'} ${c}` }} /> {l}</div>
                  ))}
                  <div className="flex items-center gap-2"><Dot color="#E5484D" /> 장애 확인 · <Dot color="#E08A3C" /> 이웃 판정 · <Dot color="#6B727C" /> 기록 없음</div>
                  <div className="pt-1 leading-snug text-ink-3">점선 외곽 링 마커는 기록된 송신·수신 사이의 <b className="font-medium text-ink-2">시각적 보간</b> 위치입니다. TCP 메시지 경로이며 사람의 대피 동선이 아닙니다.</div>
                </LegendCard>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setInsOpen((o) => !o)}
              aria-expanded={insOpen}
              aria-controls="rp-inspector"
              aria-label={insOpen ? 'Event Inspector 접기' : 'Event Inspector 펼치기'}
              title={insOpen ? 'Event Inspector 접기' : 'Event Inspector 펼치기'}
              data-testid="rp-inspector-toggle"
              className="glass-float lift absolute right-3 top-3 z-40 flex h-9 w-9 items-center justify-center rounded-full text-ink-2 hover:text-ink"
            >
              {insOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
            </button>
          </div>

          {/* ── D. Message Results ── */}
          <MessageResults
            trial={trial}
            progress={progress}
            sel={sel}
            picked={picked}
            setPicked={(id) => { setPicked(id); setInspected(null); }}
            tableOpen={tableOpen}
            setTableOpen={setTableOpen}
            focusEvent={(id) => { setPicked(id); setFilter('all'); setInsOpen(true); }}
          />
        </div>

        {/* ── C. Event Inspector ── */}
        <div className={cx('aside-shell relative shrink-0 overflow-hidden lg:h-full', insOpen ? 'w-full lg:w-[380px] 2xl:w-[420px]' : 'h-0 w-full lg:w-0')} aria-hidden={!insOpen}>
          {insOpen && (
            <aside id="rp-inspector" className="glass-chrome flex h-full max-h-[85vh] min-h-0 w-full flex-col border-t lg:max-h-none lg:w-[380px] lg:border-l lg:border-t-0 2xl:w-[420px]" aria-label="Event Inspector" data-testid="rp-inspector">
              <div className="shrink-0 space-y-2.5 border-b border-white/[0.06] px-4 pb-3 pt-3.5">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-3">Event Inspector</div>
                    <div className="mt-0.5 text-[13px] text-ink-2"><span className="font-semibold text-ink" data-testid="rp-ev-count">{list.length}</span> / {trial.events.length}개 기록 이벤트</div>
                  </div>
                  <button type="button" onClick={() => setInsOpen(false)} className="text-ink-3 hover:text-ink lg:hidden" aria-label="Event Inspector 닫기"><X size={16} /></button>
                </div>
                <div className="flex flex-wrap gap-1" role="tablist" aria-label="이벤트 필터">
                  {FILTERS.map((f) => (
                    <button
                      key={f.id}
                      role="tab"
                      aria-selected={filter === f.id}
                      data-testid={`rp-filter-${f.id}`}
                      onClick={() => setFilter(f.id)}
                      disabled={f.id !== 'all' && !counts[f.id]}
                      className={cx('rounded-full border px-2.5 py-1 text-[12px] transition disabled:opacity-35', filter === f.id ? 'border-[#7CC8FF]/55 bg-[#7CC8FF]/[0.12] text-ink' : 'border-white/[0.08] text-ink-2 hover:text-ink')}
                    >
                      {f.label} <span className="font-mono text-[10.5px] text-ink-3">{counts[f.id] ?? 0}</span>
                    </button>
                  ))}
                </div>
                {(pickedMsg || nodeOnly) && (
                  <div className="flex flex-wrap gap-1.5">
                    {pickedMsg && (
                      <Chip testId="rp-msg-focus" onClear={() => setPicked(null)}>Message Focus · M{pickedMsg.position} 이벤트 + 장애 확인</Chip>
                    )}
                    {nodeOnly && <Chip testId="rp-node-only" onClear={() => setNodeOnly(null)}>노드 {nodeOnly} 관련 이벤트만</Chip>}
                  </div>
                )}
              </div>

              <div ref={listBox} className="panel-scroll min-h-0 flex-1 space-y-3 px-4 py-3" data-testid="rp-ev-scroll">
                {/* 선택한 노드 / 링크 */}
                {selNode && <NodeCard trial={trial} id={selNode} nodes={nodes} nb={nb} places={places} onlyThis={() => setNodeOnly(selNode)} clear={() => setSelNode(null)} />}
                {selLink && <LinkCard trial={trial} id={selLink} views={linkViews} progress={progress} t={t} clear={() => setSelLink(null)} />}

                {/* Failure Inspection */}
                <FailureCard trial={trial} fails={fails} failedMsgs={failedMsgs} t={t} jump={jumpTo} focusMsg={(id) => setPicked(id)} />

                {/* 이벤트 목록 */}
                <ol className="space-y-1.5" aria-label="기록 이벤트">
                  {list.length === 0 && <li className="text-[12.5px] text-ink-3">이 조건에 해당하는 기록 이벤트가 없습니다.</li>}
                  {list.map((e) => {
                    const past = e.offset_ms <= t + EPS;
                    const isCur = curInList?.seq === e.seq;
                    const isIns = inspected === e.seq;
                    const col = colorOf(e);
                    const tag = messageTag(trial, e.message_id);
                    const prevRoute = e.event === 'route_changed' ? previousRecordedRoute(trial, e) : null;
                    return (
                      <li key={e.seq} data-seq={e.seq}>
                        <div className={cx('relative rounded-xl border transition', isIns ? 'bg-white/[0.07]' : isCur ? 'bg-white/[0.05]' : 'bg-white/[0.02] hover:bg-white/[0.04]', past ? '' : 'opacity-50')} style={{ borderColor: isIns || isCur ? `${col}88` : 'rgba(255,255,255,0.07)' }}>
                          <span className="absolute left-0 top-2.5 h-5 w-[3px] rounded-r" style={{ background: col }} />
                          <button
                            type="button"
                            onClick={() => jumpTo(e)}
                            aria-current={isCur ? 'step' : undefined}
                            data-testid={`rp-ev-${e.seq}`}
                            data-offset={e.offset_ms}
                            data-event={e.event}
                            className="block w-full px-3 py-2 text-left"
                            title="이 이벤트가 기록된 시각으로 이동"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="flex min-w-0 items-center gap-1.5">
                                <span className="truncate text-[13.5px] font-medium text-ink">{titleOf(e)}</span>
                                {tag && <span className="shrink-0 rounded-md border border-white/10 px-1 font-mono text-[10.5px] text-ink-2">{tag}</span>}
                              </span>
                              <span className="shrink-0 font-mono text-[11px] tabular-nums" style={{ color: past ? col : undefined }}>{fmtT(e.offset_ms)}</span>
                            </div>
                            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono text-[10.5px] text-ink-3">
                              <span>{e.event}</span>
                              <span>#{e.seq}</span>
                              {e.node && <span>{e.node}{e.next_node ? ` → ${e.next_node}` : ''}{e.neighbor ? ` · ${e.neighbor}` : ''}</span>}
                            </div>
                            <div className="mt-1 text-[12px] leading-snug text-ink-2">{describeEvent(trial, e)}</div>
                            {prevRoute && e.route && (
                              <div className="mt-1 font-mono text-[11.5px]"><s className="text-[#FF9EA1]/80">{prevRoute.join('→')}</s> <span className="text-ink-3">⇒</span> <span className="text-[#BFE4FF]">{e.route.join('→')}</span></div>
                            )}
                          </button>
                          {isIns && (
                            <div className="border-t border-white/[0.06] px-3 pb-2.5 pt-1.5">
                              <button type="button" aria-expanded={rawOpen} onClick={() => setRawOpen((o) => !o)} data-testid="rp-raw-toggle" className="inline-flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-3 hover:text-ink">
                                <Code2 size={12} /> Source Detail · 원문 {rawOpen ? '접기' : '보기'}
                              </button>
                              {rawOpen && (
                                <pre className="mt-1.5 max-h-[220px] overflow-auto rounded-lg bg-black/40 p-2.5 font-mono text-[11px] leading-[1.5] text-[#CFE0F5]" data-testid="rp-raw">{JSON.stringify(e, null, 2)}</pre>
                              )}
                            </div>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ol>

                {/* 출처 · 기록되지 않은 정보 */}
                <details className="rounded-2xl border border-white/[0.07] px-3.5 py-2.5" data-testid="rp-provenance">
                  <summary className="cursor-pointer list-none font-mono text-[11px] uppercase tracking-[0.14em] text-ink-3 hover:text-ink">출처 · 기록되지 않은 정보</summary>
                  <ul className="mt-2 space-y-1 text-[12px] leading-relaxed text-ink-2">
                    {trial.not_recorded?.map((n, i) => <li key={i}><span className="font-mono text-[10.5px] text-ink-3">{n.scope}</span> · {n.text}</li>)}
                    <li><span className="font-mono text-[10.5px] text-ink-3">marker</span> · 메시지의 연속 위치는 기록되지 않았습니다. 링크 위 마커 이동은 시각적 보간입니다.</li>
                    {trial.cell.method === 'fixed' && <li><span className="font-mono text-[10.5px] text-ink-3">fixed</span> · Fixed 방식은 이웃 판정(heartbeat) 기록이 없어 링크 상태를 '기록 없음'으로 둡니다.</li>}
                  </ul>
                  <div className="mt-2 break-all text-[11px] leading-relaxed text-ink-3">
                    사례 {trial.cell.cell} · {entry?.title} · 실행 {trial.cell.experiment_id ?? '—'}
                    <br />원본 {trial.provenance.source_cell ?? trial.provenance.source_path ?? '—'}
                    <br />trial.json SHA-256 <span className="font-mono">{trial.provenance.trial_sha256}</span>
                    <br />시간 기준 {trial.clock.basis} · 관측 종료 {trial.clock.observation_end_offset_ms ?? '기록 없음'} ms
                  </div>
                </details>
              </div>
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}

function PageTitle() {
  return (
    <div>
      <div className="eyebrow">REPLAY · Playback Inspector</div>
      <h1 className="mt-1.5 text-[clamp(22px,2vw,30px)] font-light leading-none tracking-[-0.03em] text-ink"><span className="text-sheen font-normal">실험 기록 재생 분석</span></h1>
      <span className="pill mt-3 w-fit border-ice/40 bg-ice/[0.08] text-[11.5px] font-semibold text-ice" data-testid="replay-badge"><History size={12} /> REPLAY · 저장된 실험 기록 · 실시간 아님</span>
    </div>
  );
}

function IconBtn({ label, title, onClick, disabled, children }: { label: string; title: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={label} title={title} className="lift inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/[0.05] text-ink hover:border-white/25 disabled:opacity-35">
      {children}
    </button>
  );
}

function Chip({ children, onClear, testId }: { children: ReactNode; onClear: () => void; testId?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-[#7CC8FF]/40 bg-[#7CC8FF]/[0.08] py-0.5 pl-2.5 pr-1 text-[11.5px] text-[#DDF1FF]" data-testid={testId}>
      <Crosshair size={11} /> {children}
      <button type="button" onClick={onClear} aria-label="해제" className="rounded-full p-0.5 text-ink-3 hover:bg-white/10 hover:text-ink"><X size={11} /></button>
    </span>
  );
}

function CardShell({ title, right, children, testId, tone }: { title: string; right?: ReactNode; children: ReactNode; testId?: string; tone?: string }) {
  return (
    <section className="glass-inset rounded-2xl p-3.5" data-testid={testId} style={tone ? { boxShadow: `inset 0 0 0 1px ${tone}33` } : undefined}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[11.5px] font-medium uppercase tracking-[0.14em] text-ink-3">{title}</span>
        {right}
      </div>
      {children}
    </section>
  );
}

/** Failure Inspection: 장애·이웃 판정·오류·재전송·경로 변경 기록과 ACK 미수신 메시지 */
function FailureCard({ trial, fails, failedMsgs, t, jump, focusMsg }: { trial: ReplayCase; fails: ReplayEvent[]; failedMsgs: ReplayCase['messages']; t: number; jump: (e: ReplayEvent) => void; focusMsg: (id: string) => void }) {
  const [open, setOpen] = useState(true);
  const none = fails.length === 0 && failedMsgs.length === 0;
  return (
    <CardShell
      title="Failure Inspection"
      testId="rp-failure"
      tone={none ? undefined : '#EF5A5F'}
      right={
        none ? null : (
          <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="text-ink-3 hover:text-ink" aria-label={open ? '장애 점검 접기' : '장애 점검 펼치기'}>
            <ChevronDown size={14} className={cx('transition-transform', open && 'rotate-180')} />
          </button>
        )
      }
    >
      {none ? (
        <p className="text-[12.5px] leading-snug text-ink-2" data-testid="rp-failure-none">이 사례에는 장애 확인·이웃 판정·오류·재전송 기록이 없습니다. 기록된 범위의 사실이며, 기록되지 않은 상태를 정상으로 단정하지 않습니다.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-[13px] text-[#FFC9CB]"><AlertTriangle size={13} /> 장애 관련 기록 {fails.length}건{failedMsgs.length ? ` · ACK 미수신 ${failedMsgs.length}건` : ''}</span>
            {fails[0] && (
              <button type="button" onClick={() => jump(fails[0])} data-testid="rp-failure-first" className="ml-auto rounded-full border border-[#EF5A5F]/40 px-2.5 py-0.5 text-[11.5px] text-[#FFC9CB] hover:bg-[#EF5A5F]/10">첫 장애 기록으로</button>
            )}
          </div>
          {open && (
            <ol className="mt-2 space-y-1">
              {fails.map((e) => {
                const prevRoute = e.event === 'route_changed' ? previousRecordedRoute(trial, e) : null;
                return (
                  <li key={e.seq}>
                    <button type="button" onClick={() => jump(e)} className={cx('grid w-full grid-cols-[64px_1fr] gap-2 rounded-lg px-1.5 py-1 text-left text-[12px] hover:bg-white/[0.05]', e.offset_ms > t + EPS && 'opacity-50')} data-testid={`rp-fail-${e.seq}`}>
                      <span className="font-mono text-[10.5px] tabular-nums" style={{ color: colorOf(e) }}>{fmtT(e.offset_ms)}</span>
                      <span className="text-ink-2">
                        <span className="text-ink">{titleOf(e)}</span> · {describeEvent(trial, e)}
                        {prevRoute && e.route && <span className="block font-mono text-[11px]"><s className="text-[#FF9EA1]/80">{prevRoute.join('→')}</s> ⇒ <span className="text-[#BFE4FF]">{e.route.join('→')}</span></span>}
                      </span>
                    </button>
                  </li>
                );
              })}
              {failedMsgs.map((m) => (
                <li key={m.position}>
                  <button type="button" onClick={() => m.message_id && focusMsg(m.message_id)} className="grid w-full grid-cols-[64px_1fr] gap-2 rounded-lg px-1.5 py-1 text-left text-[12px] hover:bg-white/[0.05]" data-testid={`rp-fail-msg-${m.position}`}>
                    <span className="font-mono text-[10.5px] text-[#FF9EA1]">최종</span>
                    <span className="text-ink-2"><span className="text-ink">M{m.position} ACK 미수신</span> · 오류 {m.result?.error ?? '기록 없음'} · 측정 {m.result?.client_elapsed_ms ?? '기록 없음'} ms</span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </CardShell>
  );
}

function NodeCard({ trial, id, nodes, nb, places, onlyThis, clear }: { trial: ReplayCase; id: string; nodes: NodeState[]; nb: Map<string, string>; places: Map<string, Place>; onlyThis: () => void; clear: () => void }) {
  const n = nodes.find((x) => x.id === id);
  if (!n) return null;
  const place = places.get(n.locationId);
  const rel = [...nb.entries()].filter(([k]) => k.split('>').includes(id));
  const evCount = trial.events.filter((e) => e.node === id || e.neighbor === id).length;
  return (
    <CardShell title="선택 노드" testId="rp-node-detail" right={<button className="text-[11.5px] text-ink-3 hover:text-ink" onClick={clear}>선택 해제</button>}>
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[20px] font-semibold text-ink">{n.id}</span>
        <span className="text-[12.5px] text-ink-2">{place ? `${place.floor}F · ${place.label}` : n.locationId}</span>
      </div>
      <div className="mt-1 text-[13.5px] font-medium" style={{ color: n.status === 'fail' ? '#FF7A7E' : n.status === 'warn' ? '#F0A866' : '#8D98AB' }}>
        {n.status === 'fail' ? '장애 확인 기록' : n.status === 'warn' ? '이웃 판정 기록(장애 의심)' : '상태 기록 없음 · 정상으로 단정하지 않음'}
      </div>
      <div className="mt-0.5 text-[12px] text-ink-3">{n.reason}</div>
      <div className="mt-2 text-[11px] text-ink-3">재생 위치까지 기록된 이웃 판정</div>
      <ul className="mt-1 space-y-0.5 font-mono text-[11.5px]">
        {rel.map(([k, v]) => (
          <li key={k} className="flex justify-between"><span className="text-ink-2">{k.replace('>', ' → ')}</span><span style={{ color: v === 'down' ? '#FF9EA1' : v === 'suspect' ? '#F4BB87' : v === 'up' ? '#7CE0B2' : '#8D98AB' }}>{v}</span></li>
        ))}
        {!rel.length && <li className="font-sans text-ink-3">기록 없음</li>}
      </ul>
      <button type="button" onClick={onlyThis} disabled={!evCount} className="mt-2 text-[12px] text-action hover:underline disabled:text-ink-3 disabled:no-underline" data-testid="rp-node-only-btn">이 노드 관련 이벤트만 보기 ({evCount})</button>
    </CardShell>
  );
}

function LinkCard({ trial, id, views, progress, t, clear }: { trial: ReplayCase; id: string; views: ReturnType<typeof linkViewsAt>; progress: MessageProgress[]; t: number; clear: () => void }) {
  const [a, b] = id.split('-');
  const v = views.find((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a));
  const on = (r: string[] | null | undefined) => !!r && r.some((x, i) => i < r.length - 1 && ((x === a && r[i + 1] === b) || (x === b && r[i + 1] === a)));
  const using = progress.filter((p) => on(p.route));
  const excluded = trial.events.filter((e) => e.event === 'route_changed' && e.offset_ms <= t + EPS && (e.excluded_links ?? []).some(([x, y]) => (x === a && y === b) || (x === b && y === a)));
  const col = v?.status === 'fail' ? '#FF9EA1' : v?.status === 'warn' ? '#F4BB87' : v?.status === 'ok' ? '#7CE0B2' : '#8D98AB';
  return (
    <CardShell title="선택 링크" testId="rp-link-detail" right={<button className="text-[11.5px] text-ink-3 hover:text-ink" onClick={clear}>선택 해제</button>}>
      <div className="font-mono text-[18px] font-semibold text-ink">{a} — {b}</div>
      <div className="mt-1 text-[13px] font-medium" style={{ color: col }}>{v ? (v.status === 'unknown' ? '링크 상태 기록 없음' : v.status === 'ok' ? '이웃 판정 up 기록' : v.status === 'warn' ? '이웃 판정 suspect 기록' : '이웃 판정 down / 장애 기록') : '기록된 연결 아님'}</div>
      {v?.detail && <div className="mt-0.5 text-[12px] text-ink-3">{v.detail}</div>}
      <dl className="mt-2 grid grid-cols-2 gap-1.5 font-mono text-[11.5px]">
        <div className="rounded-lg bg-white/[0.035] px-2 py-1"><dt className="font-sans text-[10.5px] text-ink-3">{a}가 본 {b}</dt><dd>{v?.ab ?? '기록 없음'}</dd></div>
        <div className="rounded-lg bg-white/[0.035] px-2 py-1"><dt className="font-sans text-[10.5px] text-ink-3">{b}가 본 {a}</dt><dd>{v?.ba ?? '기록 없음'}</dd></div>
      </dl>
      <div className="mt-2 text-[12px] text-ink-2">현재 경로로 쓰는 메시지: {using.length ? using.map((p) => `M${p.position}`).join(', ') : '없음'}</div>
      {excluded.length > 0 && <div className="mt-1 text-[12px] text-[#FFC9CB]">경로 변경에서 제외됨: {excluded.map((e) => `${messageTag(trial, e.message_id) ?? ''} ${fmtT(e.offset_ms)}`).join(', ')}</div>}
    </CardShell>
  );
}

/** 하단 메시지 결과: M0~M2 카드(재생 위치 기준 단계) + 상세 표(기록된 최종 결과) */
function MessageResults({ trial, progress, sel, picked, setPicked, tableOpen, setTableOpen, focusEvent }: {
  trial: ReplayCase; progress: MessageProgress[]; sel: MessageProgress; picked: string | null; setPicked: (id: string | null) => void; tableOpen: boolean; setTableOpen: (v: boolean) => void; focusEvent: (id: string) => void;
}) {
  return (
    <section className="glass-chrome relative z-10 shrink-0 border-t lg:max-h-[42vh] lg:overflow-y-auto" aria-label="메시지 결과" data-testid="rp-messages">
      <div className="space-y-2.5 px-4 py-3 md:px-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-3">Message Results</span>
          {picked ? (
            <button className="text-[12px] text-action hover:underline" onClick={() => setPicked(null)} data-testid="rp-auto-follow"><Crosshair size={12} className="mr-1 inline" />자동 추적으로</button>
          ) : (
            <span className="text-[11.5px] text-ink-3">카드를 누르면 그 메시지에 포커스(토폴로지·인스펙터)</span>
          )}
          <button type="button" onClick={() => setTableOpen(!tableOpen)} aria-expanded={tableOpen} className="ml-auto inline-flex items-center gap-1 text-[12px] text-ink-2 hover:text-ink" data-testid="rp-table-toggle">
            <ChevronDown size={13} className={cx('transition-transform', tableOpen && 'rotate-180')} /> 상세 표
          </button>
        </div>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-3" role="group" aria-label="메시지 선택">
          {progress.map((p) => {
            const m = trial.messages.find((x) => x.message_id === p.messageId)!;
            const c = STAGE_COLOR[p.stage];
            const isSel = p.messageId === sel.messageId;
            const finalAck = m.result?.ack;
            return (
              <button
                key={p.messageId}
                onClick={() => setPicked(picked === p.messageId ? null : p.messageId)}
                data-testid={`rp-msg-${p.position}`}
                aria-pressed={picked === p.messageId}
                className={cx('lift min-w-0 rounded-2xl border px-3 py-2 text-left', isSel ? 'border-action/55 bg-action/[0.08] shadow-glow-action' : 'border-white/[0.08] bg-white/[0.02] hover:border-white/20')}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-[13px] text-ink"><b className="font-semibold">M{p.position}</b> · {(p.route ?? m.attempts?.[0]?.route ?? []).join(' → ') || '경로 기록 없음'}</span>
                  <span className="shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold" style={{ color: c, background: `${c}1a`, borderColor: `${c}55` }} data-testid={`rp-msg-stage-${p.position}`}>{STAGE_LABEL[p.stage]}</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 font-mono text-[10.5px] text-ink-3">
                  <span>시작 {fmtT(m.started_offset_ms ?? 0)}</span>
                  <span>시도 {p.attempt || '—'}</span>
                  {p.retryRecorded && <span className="text-[#F4BB87]">재전송 기록</span>}
                  {p.previousRoute && <span className="text-[#F4BB87]">우회 {p.previousRoute.join('→')} ⇒ {p.route?.join('→')}</span>}
                  <span className={finalAck ? 'text-[#7CE0B2]' : finalAck === false ? 'text-[#FF9EA1]' : ''}>최종: {finalAck === undefined ? '기록 없음' : finalAck ? 'ACK 수신' : `ACK 미수신 · ${m.result?.error ?? '오류 기록 없음'}`}</span>
                </div>
              </button>
            );
          })}
        </div>
        {tableOpen && (
          <div className="overflow-x-auto" data-testid="rp-table">
            <table className="w-full min-w-[860px] text-left text-[12.5px]">
              <thead>
                <tr className="border-b border-white/15 text-[11px] uppercase tracking-[0.08em] text-ink-3">
                  {['메시지', '최종 경로', 'ACK', '재전송', '측정 지연', '오류', '시도별 결과', '이벤트'].map((h) => <th key={h} className="px-2 py-1.5 font-medium">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {trial.messages.map((m) => {
                  const evs = m.message_id ? messageEvents(trial, m.message_id).length : 0;
                  return (
                    <tr key={m.position} className={cx('border-b border-white/[0.06] align-top', m.message_id === sel.messageId && 'bg-white/[0.03]')} data-testid={`rp-row-${m.position}`}>
                      <td className="px-2 py-1.5 font-mono font-semibold text-ink">M{m.position}</td>
                      <td className="px-2 py-1.5 font-mono">{m.result?.route?.length ? m.result.route.join(' → ') : '기록 없음'}</td>
                      <td className="px-2 py-1.5">{m.result?.ack === undefined ? '기록 없음' : m.result.ack ? <span className="text-[#7CE0B2]">수신</span> : <span className="text-[#FF9EA1]">미수신</span>}</td>
                      <td className="px-2 py-1.5 font-mono">{m.result?.retries ?? '기록 없음'}</td>
                      <td className="px-2 py-1.5 font-mono">{m.result?.client_elapsed_ms === undefined ? '기록 없음' : `${m.result.client_elapsed_ms} ms`}</td>
                      <td className="px-2 py-1.5 font-mono text-ink-2">{m.result?.error ?? '—'}</td>
                      <td className="px-2 py-1.5 font-mono text-[11.5px]">
                        {m.attempts?.length ? (
                          m.attempts.map((a) => (
                            <div key={a.number}>#{a.number} {a.route.join('→')} · {a.duration_ms.toFixed(1)} ms · <span className={a.outcome === 'ack' ? 'text-[#7CE0B2]' : 'text-[#FF9EA1]'}>{a.outcome}</span></div>
                          ))
                        ) : (
                          <span className="font-sans text-ink-3">시도별 기록 없음</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        {m.message_id && evs ? <button type="button" className="font-mono text-action hover:underline" onClick={() => focusEvent(m.message_id!)}>{evs}건 보기</button> : <span className="text-ink-3">0</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-1.5 text-[11px] text-ink-3">표는 기록된 최종 결과입니다(재생 위치와 무관). 카드의 단계 표시는 재생 위치까지의 기록입니다.</p>
          </div>
        )}
      </div>
    </section>
  );
}
