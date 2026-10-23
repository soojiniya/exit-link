import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, ChevronDown, Focus, History, PanelRightClose, PanelRightOpen, Pause, Play, RotateCcw } from 'lucide-react';
import type { Place } from '@contracts';
import type { LinkState, NodeState } from '@/domain/network';
import {
  STAGE_COLOR, STAGE_LABEL, describeEvent, linkViewsAt, loadManifest, loadReplayCase, messageProgressAt, neighborViews,
  nodeViewsAt, replayDuration, timelineMarks, type Manifest, type MessageProgress, type ReplayCase, type TimelineKind,
} from '@/domain/replayEngine';
import { TopologyFlow, type TopologyReplayOverlay } from '@/ui/network/TopologyFlow';
import { useReplayPlayback } from '@/ui/replay/useReplayPlayback';
import { pulsesAt, routeSweepAt } from '@/ui/replay/cinematicDirector';
import { HudTile } from '@/ui/twin/HudTile';
import { Dot, Empty, cx } from '@/ui/primitives';
import { FocusToggle, LegendCard, NmHeadline, useBarBottom, useEscapeToExit } from './NetworkHud';

/**
 * Network Monitor · REPLAY 모드.
 * 저장된 실험 기록(public/replay/*.json)만 읽어 재생합니다. LIVE WebSocket·API·전역 스토어를 쓰지도 바꾸지도 않으며,
 * 화면을 벗어나면(언마운트) 재생 루프가 정리됩니다.
 */
const SPEEDS = [0.1, 0.25, 0.5, 1, 2] as const;
const MARK: Record<TimelineKind, { color: string; text: string }> = {
  fault: { color: '#E5484D', text: '장애 확인' },
  send: { color: '#7CC8FF', text: '전송 시작' },
  ack: { color: '#3FB27F', text: 'ACK 수신' },
  error: { color: '#E5484D', text: '오류' },
  retry: { color: '#E08A3C', text: '재전송 예약' },
  reroute: { color: '#E08A3C', text: '경로 변경' },
};
const LEGEND: [string, string, 'solid' | 'dash'][] = [
  ['데이터 구간 · 도착 기록됨', '#7CC8FF', 'solid'],
  ['송신 후 도착 기록 전', '#7CC8FF', 'dash'],
  ['연결 시도 중 · 응답 기록 전', '#E08A3C', 'dash'],
  ['ACK 구간', '#3FB27F', 'solid'],
  ['연결 실패 · 이전 시도 경로', '#E5484D', 'dash'],
];
const fmt = (ms: number) => `+${(ms / 1000).toFixed(3)}s`;
export const NM_REPLAY_NOTICE = '저장된 TCP 실험 기록을 재생하는 시각화입니다. 링크 위 메시지 마커의 위치는 기록된 송신·수신 이벤트 사이의 시각적 보간이며, 사람의 대피 동선이 아닙니다.';

export function ReplayMonitor({ modeSwitch, places, focus, setFocus, initialCase }: { modeSwitch: ReactNode; places: Map<string, Place>; focus: boolean; setFocus: (v: boolean) => void; initialCase?: string | null }) {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [caseId, setCaseId] = useState('');
  const [trial, setTrial] = useState<ReplayCase | null>(null);
  const [problem, setProblem] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  useEscapeToExit(focus, () => setFocus(false));
  const [barRef, barBottom] = useBarBottom();

  useEffect(() => {
    const ctl = new AbortController();
    loadManifest(ctl.signal)
      .then((m) => { setManifest(m); setCaseId(m.cases.find((c) => c.id === initialCase)?.id ?? m.cases[0]?.id ?? ''); })
      .catch((e: unknown) => { if (!ctl.signal.aborted) setProblem(`저장된 재생 목록을 확인할 수 없습니다: ${String(e)}`); });
    return () => ctl.abort();
  }, []);

  useEffect(() => {
    const entry = manifest?.cases.find((c) => c.id === caseId);
    setTrial(null);
    setPicked(null);
    setSelectedNode(null);
    if (!entry) return;
    setProblem('');
    const ctl = new AbortController();
    loadReplayCase(entry, ctl.signal)
      .then(setTrial)
      .catch((e: unknown) => { if (!ctl.signal.aborted) setProblem(`기록을 불러오지 못했습니다: ${String(e)}`); });
    return () => ctl.abort();
  }, [manifest, caseId]);

  const duration = useMemo(() => (trial ? replayDuration(trial) : 1000), [trial]);
  const pb = useReplayPlayback(duration, 0.5);
  const { t } = pb;
  // 사례가 바뀌면 처음으로
  const resetRef = useRef(pb.reset);
  resetRef.current = pb.reset;
  useEffect(() => resetRef.current(), [trial]);

  const progress = useMemo(() => (trial ? trial.messages.map((m) => messageProgressAt(trial, m, t)) : []), [trial, t]);
  const marks = useMemo(() => (trial ? timelineMarks(trial) : []), [trial]);
  const started = trial ? trial.messages.filter((m) => (m.started_offset_ms ?? 0) <= t) : [];
  const following = picked === null;
  const sel: MessageProgress | undefined =
    progress.find((p) => p.messageId === picked) ?? progress.find((p) => p.position === started[started.length - 1]?.position) ?? progress[0];
  const selMsg = trial?.messages.find((m) => m.message_id === sel?.messageId);

  const nodes: NodeState[] = useMemo(
    () => (trial ? nodeViewsAt(trial, t).map((n) => ({ id: n.id, locationId: n.locationId, status: n.status, reason: n.reason, reachable: null, observedAt: null })) : []),
    [trial, t],
  );
  const links: LinkState[] = useMemo(() => (trial ? linkViewsAt(trial, t).map(({ a, b, status, detail }) => ({ a, b, status, detail })) : []), [trial, t]);
  const overlay: TopologyReplayOverlay | undefined = useMemo(() => {
    if (!trial || !sel) return undefined;
    const views = neighborViews(trial, t);
    return {
      nodeNote: (id) => {
        const n = nodes.find((x) => x.id === id);
        if (n?.status === 'fail') return 'REPLAY · 장애 확인 기록';
        if (n?.status === 'warn') return 'REPLAY · 이웃 판정 기록';
        return 'REPLAY · 상태 기록 없음';
      },
      neighborStatus: (from, to) => views.get(`${from}>${to}`),
      route: sel.route,
      previousRoute: sel.previousRoute,
      legs: sel.legs,
      excludedLinks: sel.excludedLinks,
      markers: progress
        .filter((p) => p.marker)
        .map((p) => ({ key: p.messageId, from: p.marker!.from, to: p.marker!.to, frac: p.marker!.frac, kind: p.marker!.kind, label: `M${p.position}`, selected: p.messageId === sel.messageId })),
      // 기록 시각 기준 짧은 강조와 경로 전환 빛(cinematicDirector — 기록에 없는 효과는 만들지 않음)
      pulses: pulsesAt(trial, t),
      sweep: routeSweepAt(trial, t, sel.messageId),
      failed: sel.stage === 'failed',
    };
  }, [trial, t, sel, progress, nodes]);

  const visible = trial ? trial.events.filter((e) => e.offset_ms <= t) : [];
  const [logOpen, setLogOpen] = useState(false);
  const logBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = logBox.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible.length, logOpen]);
  const cards = useRef<HTMLDivElement>(null);
  const keyMarks = marks.filter((m) => m.kind !== 'send');
  const current = [...keyMarks].reverse().find((m) => m.t <= t) ?? null;
  useEffect(() => {
    const el = cards.current?.querySelector<HTMLElement>('[data-current="1"]');
    if (el && cards.current) cards.current.scrollTo({ left: el.offsetLeft - cards.current.clientWidth / 2 + el.clientWidth / 2, behavior: 'smooth' });
  }, [current?.t]);

  const badge = (
    <span className="pill w-fit border-ice/40 bg-ice/[0.08] text-[12px] font-semibold text-ice" data-testid="nm-replay-badge">
      <History size={12} /> REPLAY · 저장된 실험 기록 · 실시간 아님
    </span>
  );
  const controlBar = (children: ReactNode) => (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-50 flex justify-center px-4 pt-4">
      <div ref={barRef} className="control-bar glass-float pointer-events-auto flex max-w-full flex-wrap items-center gap-2.5 rounded-[22px] px-2.5 py-2">
        {modeSwitch}
        {children}
        <FocusToggle on={focus} onChange={setFocus} />
      </div>
    </div>
  );

  if (!trial || !sel || !selMsg) {
    return (
      <div className="nm-stage relative flex h-full min-h-0 flex-col">
        {controlBar(null)}
        <div className="px-10 pt-28">
          <div className="mb-6">{badge}</div>
          {problem ? (
            <p role="alert" className="flex items-center gap-2 text-sm text-[#F4BB87]"><AlertCircle size={16} />{problem}</p>
          ) : manifest && !manifest.cases.length ? (
            <Empty title="검증된 재생 기록이 없습니다" hint="예시 이벤트는 임의로 표시하지 않습니다" />
          ) : (
            <Empty title="저장된 기록을 불러오는 중입니다" hint="public/replay/manifest.json" />
          )}
        </div>
      </div>
    );
  }

  const noPlaces = places.size === 0;
  const pct = (x: number) => `${Math.min(100, Math.max(0, (x / duration) * 100)).toFixed(3)}%`;
  const ackSoFar = progress.filter((p) => p.stage === 'acked').length;
  const failedSoFar = progress.filter((p) => p.stage === 'failed').length;
  const faultsNow = nodes.filter((n) => n.status === 'fail').map((n) => n.id);
  const suspectNow = nodes.filter((n) => n.status === 'warn').map((n) => n.id);
  const caseTitle = manifest?.cases.find((c) => c.id === caseId)?.title ?? caseId;
  const go = (x: number) => { pb.setPlaying(false); pb.seek(x); };
  const showAside = !focus && panelOpen;
  const nodeSel = selectedNode ? nodes.find((n) => n.id === selectedNode) ?? null : null;
  const nbViews = neighborViews(trial, t);

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* ── 무대: 토폴로지가 주인공 ── */}
        <div className="nm-stage relative min-h-0 flex-1 overflow-hidden" data-focus={focus || undefined}>
          {/* 토폴로지 영역: 일반 = 왼쪽 상태 열 오른쪽(겹치지 않게) · FOCUS = 전체 폭, 아래 이벤트 제목 띠를 비움 */}
          <div style={{ top: barBottom }} className={cx('absolute transition-[left,bottom] duration-500', focus ? 'inset-x-0 bottom-[150px]' : 'bottom-0 left-0 right-0 xl:left-[290px]')} data-testid="nm-topology">
            {noPlaces ? (
              <div className="p-10 pt-28"><Empty title="건물 배치 정보를 아직 받지 못했습니다" hint="층·위치 이름은 GET /api/v1/building 의 건물 정의를 씁니다(재생 데이터와 무관). 저장된 기록 자체는 /replay 화면에서도 볼 수 있습니다." /></div>
            ) : (
              <TopologyFlow
                topology={{ nodes: trial.topology?.nodes.map((n) => ({ id: n.id, location_id: n.location_id ?? '' })) ?? [] }}
                network={null}
                nodes={nodes}
                links={links}
                places={places}
                pids={new Map()}
                flow={null}
                selected={selectedNode}
                onSelect={(id) => { setSelectedNode(id); if (id) setPanelOpen(true); }}
                replay={overlay}
              />
            )}
          </div>
          <div aria-hidden className="stage-vignette pointer-events-none absolute inset-0" />

          {/* 상단 통합 컨트롤 */}
          {controlBar(
            <>
              <div className="seg" role="tablist" aria-label="재생 사례">
                {manifest?.cases.map((c) => (
                  <button key={c.id} role="tab" aria-selected={c.id === caseId} onClick={() => setCaseId(c.id)} title={`${c.title} — ${c.description}`}>
                    <span className="hidden 2xl:inline">{c.title.split('·')[0].trim()} </span><span className="font-mono text-ink-3 [[aria-selected=true]_&]:text-ink">{c.id}</span>
                  </button>
                ))}
              </div>
              <span aria-hidden className="mx-0.5 h-5 w-px bg-white/10" />
              <button type="button" onClick={pb.reset} aria-label="초기화" title="처음으로" className="lift inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/[0.05] text-ink hover:border-white/25">
                <RotateCcw size={14} />
              </button>
              <button
                type="button"
                onClick={pb.toggle}
                aria-label={pb.playing ? '일시정지' : '재생'}
                className="lift inline-flex h-8 min-w-[96px] items-center justify-center gap-1.5 rounded-full bg-gradient-to-b from-[#F4F8FF] to-[#C6D6EC] px-3.5 text-[13px] font-semibold text-[#0A1220] shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_6px_18px_-8px_rgba(124,200,255,0.7)] hover:brightness-110"
              >
                {pb.playing ? <Pause size={14} /> : <Play size={14} />} {pb.playing ? '일시정지' : '재생'}
              </button>
              <div className="seg" role="tablist" aria-label="재생 속도">
                {SPEEDS.map((sp) => (
                  <button key={sp} role="tab" aria-selected={pb.speed === sp} onClick={() => pb.setSpeed(sp)}>{sp}×</button>
                ))}
              </div>
              <span className="font-mono text-[13px] tabular-nums text-ink" data-testid="nm-replay-time" title="기록 시각 기준(benchmark_perf_ns, 관측 구간 시작 = 0) · 속도는 화면 진행만 바꿈">{fmt(t)} / {fmt(duration)}</span>
            </>,
          )}

          {/* 왼쪽: 상태 타일 + 현재 이벤트 */}
          <div className="pointer-events-none absolute left-6 z-40 flex flex-col gap-2.5" style={{ top: barBottom + 10 }}>
            <div className="pointer-events-auto">{badge}</div>
            <div className={cx('nm-hud pointer-events-auto hidden w-[250px] gap-1.5 xl:grid', focus && '!hidden')}>
              <HudTile label="사례" value={caseTitle} sub={`${trial.cell.method === 'fixed' ? 'Fixed' : 'EXIT-LINK'} · ${trial.cell.condition}${trial.cell.fault_timing && trial.cell.fault_timing !== 'none' ? ` · ${trial.cell.fault_timing}` : ''}`} tone="neutral" testId="nm-hud-case" />
              <HudTile
                label={`M${sel.position} 메시지 경로 ${following ? '· 자동 추적' : '· 선택'}`}
                value={sel.route ? sel.route.join(' → ') : '경로 기록 없음'}
                sub={sel.previousRoute ? <span>이전 <s className="text-[#FFA9AC]">{sel.previousRoute.join('→')}</s> · 시도 {sel.attempt}</span> : `${STAGE_LABEL[sel.stage]} · 시도 ${sel.attempt || '—'}`}
                tone={sel.stage === 'failed' ? 'fail' : sel.previousRoute ? 'warn' : sel.stage === 'acked' ? 'ok' : 'info'}
                testId="nm-hud-route"
              />
              <HudTile label="ACK" value={`${ackSoFar} / ${trial.messages.length}`} sub={failedSoFar ? `미수신 ${failedSoFar}건(기록)` : '재생 위치까지 수신'} tone={failedSoFar ? 'fail' : ackSoFar ? 'ok' : 'idle'} testId="nm-hud-ack" />
              <HudTile
                label="장애"
                value={faultsNow.length ? faultsNow.join(' · ') : suspectNow.length ? `의심 ${suspectNow.join(' · ')}` : '확인 기록 없음'}
                sub={faultsNow.length ? '장애 확인 기록(fault_confirmed)' : suspectNow.length ? '이웃 판정 기록' : '정상으로 단정하지 않음'}
                tone={faultsNow.length ? 'fail' : suspectNow.length ? 'warn' : 'idle'}
                testId="nm-hud-fault"
              />
            </div>
            {/* 현재 이벤트(일반: 상태 열 아래 작게) */}
            {!focus && <div className="nm-hud mt-2 hidden xl:block"><NmHeadline trial={trial} t={t} playing={pb.playing} large={false} /></div>}
          </div>
          {/* FOCUS: 현재 이벤트를 아래 띠에 크게 */}
          {focus && (
            <div className="pointer-events-none absolute bottom-5 left-8 right-8 z-40">
              <NmHeadline trial={trial} t={t} playing={pb.playing} large />
            </div>
          )}

          {/* 왼쪽 아래: 범례(접힘 · FOCUS 에서는 숨김) */}
          <div className={cx('absolute bottom-4 left-6 z-40', focus && 'hidden')}>
            <LegendCard title={`범례 · M${sel.position} ${following ? '자동 추적' : '선택'}`}>
              {LEGEND.map(([l, c, st]) => (
                <div key={l} className="flex items-center gap-2"><span className="w-6" style={{ borderTop: `3px ${st === 'dash' ? 'dashed' : 'solid'} ${c}` }} /> {l}</div>
              ))}
              <div className="flex items-center gap-2"><Dot color="#E5484D" /> 장애 확인 노드 · <Dot color="#E08A3C" /> 이웃이 suspect/down 판정 · <Dot color="#6B727C" /> 상태 기록 없음</div>
              <div className="pt-1 leading-snug text-ink-3">점선 외곽 링이 있는 마커는 기록된 송신·수신 사이의 <b className="font-medium text-ink-2">시각적 보간</b> 위치입니다.</div>
              <div className="leading-snug text-ink-3">TCP 메시지 경로입니다. 사람의 대피 동선이 아닙니다.</div>
            </LegendCard>
          </div>

          {!focus && (
            <button
              type="button"
              onClick={() => setPanelOpen((o) => !o)}
              aria-expanded={panelOpen}
              aria-label={panelOpen ? '상세 패널 접기' : '상세 패널 펼치기'}
              title={panelOpen ? '상세 패널 접기' : '상세 패널 펼치기'}
              className="glass-float lift absolute right-4 top-1/2 z-40 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full text-ink-2 hover:text-ink"
            >
              {panelOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
            </button>
          )}
        </div>

        {/* ── 하단 이벤트 덱 ── */}
        <div className="glass-chrome relative z-10 shrink-0 border-t">
          <div className="panel-scroll max-h-[46vh] space-y-3 px-5 pb-3 pt-3">
            <div ref={cards} className="no-scrollbar flex gap-2 overflow-x-auto pb-1" role="list" aria-label="핵심 이벤트">
              {keyMarks.length === 0 && <div className="text-[13px] text-ink-3">이 사례에는 장애·재전송·ACK 같은 핵심 이벤트 기록이 없습니다.</div>}
              {keyMarks.map((m, i) => {
                const past = m.t <= t;
                const isCur = current?.t === m.t && current?.kind === m.kind;
                const mk = MARK[m.kind];
                return (
                  <button
                    key={i}
                    role="listitem"
                    type="button"
                    data-current={isCur ? '1' : undefined}
                    data-testid={`nm-event-${m.kind}`}
                    onClick={() => go(m.t)}
                    className={cx('event-card lift spotlight relative min-w-[176px] shrink-0 rounded-2xl border px-3.5 py-2.5 text-left', past ? 'opacity-100' : 'opacity-45', isCur ? 'bg-white/[0.07]' : 'bg-white/[0.025] hover:bg-white/[0.05]')}
                    style={{ borderColor: isCur ? `${mk.color}99` : 'rgba(255,255,255,0.09)', boxShadow: isCur ? `0 0 0 1px ${mk.color}55, 0 0 26px -10px ${mk.color}` : undefined }}
                  >
                    <span className="absolute left-0 top-3 h-6 w-[3px] rounded-r" style={{ background: mk.color }} />
                    <div className="flex items-center justify-between gap-2 font-mono text-[11px]">
                      <span style={{ color: mk.color }}>{mk.text}</span>
                      <span className="text-ink-3">{fmt(m.t)}</span>
                    </div>
                    <div className="mt-1 truncate text-[13.5px] text-ink">{m.label}</div>
                  </button>
                );
              })}
            </div>

            <div>
              <div className="relative h-4">
                {marks.map((m, i) => (
                  <button key={i} type="button" onClick={() => go(m.t)} title={`${m.label} · ${fmt(m.t)}`} aria-label={`${m.label} ${fmt(m.t)}`} className="absolute top-0 -translate-x-1/2" style={{ left: pct(m.t) }}>
                    <span className={cx('block h-3 w-1.5 rounded-sm transition-transform hover:scale-125', m.kind === 'fault' && 'h-3 w-3 rotate-45 rounded-[3px]')} style={{ background: MARK[m.kind].color, boxShadow: `0 0 6px ${MARK[m.kind].color}` }} />
                  </button>
                ))}
              </div>
              <input type="range" min={0} max={duration} step={0.1} value={t} onChange={(e) => go(Number(e.target.value))} aria-label="기록 재생 위치" className="timeline-range w-full" style={{ ['--p' as string]: pct(t) }} />
            </div>

            {/* 메시지 M0~M2 */}
            <div className={cx('grid gap-2', focus ? 'grid-cols-3' : 'grid-cols-1 lg:grid-cols-3')} role="group" aria-label="메시지 선택">
              {progress.map((p) => {
                const m = trial.messages.find((x) => x.message_id === p.messageId)!;
                const c = STAGE_COLOR[p.stage];
                const isSel = p.messageId === sel.messageId;
                return (
                  <button
                    key={p.messageId}
                    onClick={() => setPicked(p.messageId)}
                    data-testid={`nm-replay-msg-${p.position}`}
                    aria-pressed={isSel}
                    className={cx('lift min-w-0 rounded-2xl border px-3 py-2 text-left', isSel ? 'border-action/55 bg-action/[0.08] shadow-glow-action' : 'border-white/[0.08] bg-white/[0.02] hover:border-white/20')}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-[13px] text-ink"><b className="font-semibold">M{p.position}</b> · {(p.route ?? m.attempts?.[0]?.route ?? []).join(' → ') || '경로 기록 없음'}</span>
                      <span className="shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold" style={{ color: c, background: `${c}1a`, borderColor: `${c}55` }}>{STAGE_LABEL[p.stage]}</span>
                    </div>
                    {!focus && (
                      <div className="mt-1 flex [@media(max-height:820px)]:hidden flex-wrap items-center gap-x-2 font-mono text-[10.5px] text-ink-3">
                        <span>시작 {fmt(m.started_offset_ms ?? 0)}</span>
                        <span>시도 {p.attempt || '—'}</span>
                        {p.retryRecorded && <span className="text-[#F4BB87]">재전송 기록</span>}
                        {p.previousRoute && <span className="text-[#F4BB87]">우회 {p.previousRoute.join('→')} ⇒ {p.route?.join('→')}</span>}
                        <span className={m.result?.ack ? 'text-[#7CE0B2]' : 'text-[#FF9EA1]'}>최종 기록: {m.result?.ack === undefined ? '기록 없음' : m.result.ack ? 'ACK 수신' : `ACK 미수신 · ${m.result.error ?? '오류 기록 없음'}`}</span>
                      </div>
                    )}
                  </button>
                );
              })}
            </div>

            {!focus && (
              <div className="flex flex-wrap items-start justify-between gap-3">
                <button type="button" onClick={() => setLogOpen((o) => !o)} aria-expanded={logOpen} className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-3 hover:text-ink">
                  <ChevronDown size={13} className={cx('transition-transform', logOpen && 'rotate-180')} /> 전체 기록 {visible.length}/{trial.events.length}
                </button>
                {!following && <button className="text-[12px] text-action hover:underline" onClick={() => setPicked(null)}><Focus size={12} className="mr-1 inline" />자동 추적</button>}
                <p className="ml-auto max-w-[640px] text-right text-[11.5px] leading-snug text-ink-3" data-testid="nm-replay-notice">{NM_REPLAY_NOTICE}</p>
              </div>
            )}
            {!focus && logOpen && (
              <div ref={logBox} className="panel-scroll max-h-[min(180px,22vh)] rounded-xl border border-white/[0.06] bg-black/20 px-3 py-2" aria-live="off" data-testid="nm-replay-log">
                {visible.length ? (
                  <ul className="space-y-0.5">
                    {visible.map((e) => (
                      <li key={e.seq} className={cx('grid grid-cols-[78px_1fr] gap-2 rounded px-1 text-[11.5px]', e.message_id && e.message_id === sel.messageId ? 'text-ink' : 'text-ink-2', e.event === 'fault_confirmed' || e.event === 'error' ? 'text-[#FF9EA1]' : '')}>
                        <span className="font-mono text-[10.5px] text-ink-3">{fmt(e.offset_ms)}</span>
                        <span>{describeEvent(trial, e)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-ink-3">재생 위치까지 기록된 이벤트가 없습니다.</p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── 오른쪽 상세(접힘·FOCUS 에서 숨김) ── */}
      <div className={cx('aside-shell relative h-full shrink-0 overflow-hidden', showAside ? 'w-[320px] xl:w-[370px]' : 'w-0')} aria-hidden={!showAside}>
        {showAside && (
          <aside className="glass-chrome panel-scroll h-full w-[320px] space-y-4 border-l px-4 py-4 xl:w-[370px]" aria-label="재생 메시지 상세">
            {nodeSel && (
              <section className="glass-inset rounded-2xl p-4" data-testid="nm-node-detail">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[12px] font-medium uppercase tracking-[0.14em] text-ink-3">선택 노드</span>
                  <button className="text-[11.5px] text-ink-3 hover:text-ink" onClick={() => setSelectedNode(null)}>선택 해제</button>
                </div>
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-[22px] font-semibold text-ink">{nodeSel.id}</span>
                  <span className="text-[13px] text-ink-2">{places.get(nodeSel.locationId)?.floor ?? '—'}F · {places.get(nodeSel.locationId)?.label ?? nodeSel.locationId}</span>
                </div>
                <div className="mt-1 text-[14px] font-medium" style={{ color: nodeSel.status === 'fail' ? '#FF7A7E' : nodeSel.status === 'warn' ? '#F0A866' : '#8D98AB' }}>
                  {nodeSel.status === 'fail' ? '장애 확인 기록' : nodeSel.status === 'warn' ? '이웃 판정 기록(장애 의심)' : '상태 기록 없음 · 정상으로 단정하지 않음'}
                </div>
                <div className="mt-0.5 text-[12px] text-ink-3">{nodeSel.reason}</div>
                <div className="mt-3 text-[11px] text-ink-3">재생 위치까지 기록된 이웃 판정</div>
                <ul className="mt-1 space-y-0.5 font-mono text-[11.5px]">
                  {[...nbViews.entries()].filter(([k]) => k.split('>').includes(nodeSel.id)).map(([k, v]) => (
                    <li key={k} className="flex justify-between"><span className="text-ink-2">{k.replace('>', ' → ')}</span><span style={{ color: v === 'down' ? '#FF9EA1' : v === 'suspect' ? '#F4BB87' : v === 'up' ? '#7CE0B2' : '#8D98AB' }}>{v}</span></li>
                  ))}
                  {![...nbViews.keys()].some((k) => k.split('>').includes(nodeSel.id)) && <li className="font-sans text-ink-3">기록 없음</li>}
                </ul>
              </section>
            )}

            <section className="glass-inset rounded-2xl p-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[12px] font-medium uppercase tracking-[0.14em] text-ink-3">M{sel.position} 기록된 결과</span>
                <span className="rounded-full border px-2 py-0.5 text-[11px] font-semibold" style={{ color: STAGE_COLOR[sel.stage], background: `${STAGE_COLOR[sel.stage]}1a`, borderColor: `${STAGE_COLOR[sel.stage]}55` }}>{STAGE_LABEL[sel.stage]}</span>
              </div>
              <div className="font-mono text-[14px] text-ink">{selMsg.result?.route?.length ? selMsg.result.route.join(' → ') : (sel.route ?? []).join(' → ') || '경로 기록 없음'}</div>
              {sel.previousRoute && sel.route && (
                <div className="mt-1.5 rounded-xl border border-[#E9954A]/30 bg-[#E9954A]/[0.06] px-2.5 py-1.5 font-mono text-[12px]">
                  <span className="text-[#F6C79A]">우회: </span><s className="text-ink-3">{sel.previousRoute.join('→')}</s><span className="text-ink-3"> ⇒ </span><span className="text-[#BFE4FF]">{sel.route.join('→')}</span>
                </div>
              )}
              <dl className="mt-3 grid grid-cols-2 gap-2">
                <Stat k="ACK 수신" testId="nm-replay-ack" v={selMsg.result?.ack === undefined ? '기록 없음' : selMsg.result.ack ? <span className="text-[#7CE0B2]">수신</span> : <span className="text-[#FF9EA1]">미수신</span>} />
                <Stat k="재전송(retries)" v={<span className="font-mono">{selMsg.result?.retries ?? '기록 없음'}</span>} />
                <Stat k="측정 지연" v={<span className="font-mono">{selMsg.result?.client_elapsed_ms === undefined ? '기록 없음' : `${selMsg.result.client_elapsed_ms} ms`}</span>} />
                <Stat k="오류" v={<span className="font-mono">{selMsg.result?.error ?? '—'}</span>} />
              </dl>
              <p className="mt-2 text-[11px] text-ink-3">기록된 최종 결과입니다(재생 위치와 무관). 목적지 수신 {selMsg.result?.destination_received_count ?? '기록 없음'}회.</p>
            </section>

            <section>
              <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-3">시도 기록</div>
              {selMsg.attempts?.length ? (
                <table className="w-full text-[12px]">
                  <tbody className="font-mono">
                    {selMsg.attempts.map((a) => (
                      <tr key={a.number} className="border-t border-white/[0.05]">
                        <td className="py-1 pr-2 text-ink-3">#{a.number}</td>
                        <td className="pr-2">{a.route.join('→')}</td>
                        <td className="pr-2 text-right">{a.duration_ms.toFixed(1)} ms</td>
                        <td className={cx('text-right', a.outcome === 'ack' ? 'text-[#7CE0B2]' : 'text-[#FF9EA1]')}>{a.outcome}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="text-[12px] text-ink-3">시도별 기록 없음(이 사례의 결과에 attempts 가 비어 있음).</p>
              )}
              {sel.lastError && (
                <p className="mt-2 text-[12px] text-[#FFC9CB]">재생 위치까지 기록된 마지막 오류: <span className="font-mono">{sel.lastError.code ?? '—'}{sel.lastError.reason ? ` (${sel.lastError.reason})` : ''}</span></p>
              )}
            </section>

            <details className="group rounded-2xl border border-white/[0.07] px-3.5 py-2.5">
              <summary className="cursor-pointer list-none font-mono text-[11px] uppercase tracking-[0.14em] text-ink-3 hover:text-ink">기록되지 않은 정보 · 출처</summary>
              <ul className="mt-2 space-y-1 text-[12px] leading-relaxed text-ink-2">
                {trial.not_recorded?.map((n, i) => <li key={i}><span className="font-mono text-[10.5px] text-ink-3">{n.scope}</span> · {n.text}</li>)}
                <li><span className="font-mono text-[10.5px] text-ink-3">marker</span> · 메시지의 연속 위치는 기록되지 않았습니다. 링크 위 마커 이동은 시각적 보간입니다.</li>
                {trial.cell.method === 'fixed' && <li><span className="font-mono text-[10.5px] text-ink-3">fixed</span> · Fixed 방식은 이웃 판정 기록이 없어 링크 상태를 '기록 없음'으로 둡니다.</li>}
              </ul>
              <div className="mt-2 text-[11px] leading-relaxed text-ink-3">
                사례 {trial.cell.cell} · 실행 {trial.cell.experiment_id ?? '—'}
                <br />trial.json SHA-256 <span className="break-all font-mono">{trial.provenance.trial_sha256}</span>
              </div>
            </details>
          </aside>
        )}
      </div>
    </div>
  );
}

function Stat({ k, v, testId }: { k: string; v: ReactNode; testId?: string }) {
  return (
    <div className="rounded-xl bg-white/[0.035] px-3 py-2">
      <dt className="text-[11px] text-ink-3">{k}</dt>
      <dd className="mt-0.5 text-[15px] font-semibold" data-testid={testId}>{v}</dd>
    </div>
  );
}
