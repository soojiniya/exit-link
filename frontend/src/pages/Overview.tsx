import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity, AlertTriangle, Archive, ArrowRight, ArrowUpRight, BarChart3, Box, CheckCircle2, Clapperboard, Clock3, FlaskConical, Flame,
  GitBranch, Info, Network, Presentation, Server,
} from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useApp } from '@/store/store';
import { useActiveScenario } from '@/store/selectors';
import { useAnalytics } from '@/store/useAnalytics';
import { NODE_STATUS_LABEL, STATUS_COLOR } from '@/domain/network';
import { ago, ms, reasonLabel, timeOf } from '@/domain/format';
import { STRATA, pValue, pct, pctRange, pp, ppRange, rowOf, study, studyValid } from '@/domain/study';
import { loadManifest, loadReplayCase } from '@/domain/replayEngine';
import { caseFacts, type CaseFacts } from '@/ui/overview/recordedCases';
import { CH, ChartCard, Legend, SimpleTable, TipBox, axisProps } from '@/ui/charts';
import { RetentionNotice } from '@/ui/RetentionNotice';
import { Chip, Dot, SourceBadge, cx } from '@/ui/primitives';
import { useNow } from '@/ui/TopBar';
import type { DeliveryRow } from '@/domain/analytics';
import type { ConnStatus } from '@/store/types';

/**
 * Overview — EXIT-LINK 메인 대시보드.
 * 구역을 명확히 나눕니다.
 *  A. Hero: 제품 설명 + 현재 LIVE 연결 상태(요약)
 *  B. LIVE: 실제 TCP 관측·SIM 시나리오(스토어 값만 사용, 없으면 '미실행'·'관측 기록 없음'으로 표시하고 0 을 측정값처럼 쓰지 않음)
 *  C. RECORDED: 저장된 본 실험 결과(domain/study — Analytics 와 같은 모듈·같은 행) + 저장된 재생 기록 사례(public/replay)
 * LIVE API·WebSocket 동작은 바꾸지 않으며, RECORDED 구역은 정적 파일만 읽습니다(쓰기 요청 없음).
 */

const TONE = { ok: '#5FD6A2', warn: '#F0A866', fail: '#FF7A7E', idle: '#8D98AB', info: '#BFE4FF', neutral: '#F4F7FB' } as const;
type Tone = keyof typeof TONE;
/** Analytics 본 실험 화면과 같은 방식 색 */
const METHOD = { fixed: { label: 'Fixed', sub: '고정 경로', color: '#C86A9A' }, exit: { label: 'EXIT-LINK', sub: '자동 재라우팅', color: CH.good } } as const;

const OUTCOME: Record<DeliveryRow['outcome'], { label: string; color: string }> = {
  ack: { label: 'ACK 수신·성공', color: CH.good },
  no_ack: { label: 'ACK 없음·실패', color: CH.bad },
  transport_error: { label: '전송 오류', color: CH.warn },
};
const CONN: Record<ConnStatus, { label: string; tone: Tone }> = {
  idle: { label: '연결 대기', tone: 'idle' },
  connecting: { label: '연결 중', tone: 'warn' },
  open: { label: '연결됨 · 실시간 스트림', tone: 'ok' },
  reconnecting: { label: '연결 끊김 · 재연결 시도 중', tone: 'fail' },
  resyncing: { label: '동기화 중', tone: 'warn' },
};

export default function Overview() {
  const now = useNow(5000);
  const a = useAnalytics();
  const scenario = useActiveScenario();
  const conn = useApp((s) => s.conn);
  const building = useApp((s) => s.building);
  const buildingError = useApp((s) => s.buildingError);
  const timeline = useApp((s) => s.timeline);
  const network = a.network;
  const labels = new Map((building?.building.nodes ?? []).map((n) => [n.id, n.label]));

  // ── LIVE 파생값(스토어 값만) ──
  const total = a.nodes.length;
  const observed = !!network && network.observation_status === 'observed';
  const reachable = a.nodes.filter((n) => n.reachable === true).length;
  const offlineAll = observed && total > 0 && a.nodes.every((n) => n.status === 'offline');
  const fails = a.nodes.filter((n) => n.status === 'fail').map((n) => n.id);
  const suspects = a.nodes.filter((n) => n.status === 'warn' || n.status === 'recovering').map((n) => n.id);
  const liveRunning = observed && reachable > 0;
  const h = scenario?.state.hazards;
  const hazardCount = h ? h.fire_locations.length + h.dangerous_nodes.length + h.blocked_nodes.length + h.blocked_passages.length : 0;
  const plans = scenario?.plans ?? [];
  const noRoute = plans.filter((p) => p.status === 'no_route').length;
  const lastAck = [...a.rows].reverse().find((r) => r.outcome === 'ack') ?? null;
  const lastReroute = [...a.flows].reverse().find((f) => f.previousRoute) ?? null;
  const recent = timeline.filter((t) => t.severity === 'fail' || t.severity === 'warn' || t.title.startsWith('통신 경로') || t.kind === 'route.changed').slice(-8).reverse();
  const lastRows = a.rows.slice(-24).map((r, i) => ({ ...r, idx: i + 1 }));
  const backendTone: Tone = buildingError && conn !== 'open' ? 'fail' : CONN[conn].tone;
  const backendText = conn === 'open' ? CONN.open.label : buildingError && conn !== 'connecting' ? '백엔드에 연결할 수 없음' : CONN[conn].label;

  const nodeValue = !network ? '관측 대기' : !observed ? (network.observation_status === 'error' ? '관측 오류' : '미관측') : offlineAll ? '미실행' : `${reachable} / ${total} 실행`;
  const nodeSub = !network
    ? '백엔드 스냅샷을 아직 받지 못했습니다'
    : !observed
      ? network.monitor_error ?? '노드 상태를 아직 관측하지 않았습니다'
      : offlineAll
        ? `TCP 노드 ${total}개 모두 응답 없음 · 실험 미시작 또는 노드 미기동`
        : `TCP 응답 ${reachable}개 · ${network.configuration_source === 'owned_experiment' ? '실험 프로세스' : '프로젝트 구성'}`;
  const nodeTone: Tone = !observed || offlineAll ? 'idle' : reachable === total ? 'ok' : 'warn';

  const scrollToRecorded = () => document.getElementById('recorded')?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <div className="panel-scroll h-full">
      <div className="mx-auto max-w-[1480px] space-y-16 px-6 pb-20 pt-10 md:px-10">
        {/* ── A. Hero ── */}
        <section className="grid grid-cols-1 items-end gap-8 xl:grid-cols-[1.35fr_1fr]" aria-labelledby="ov-title">
          <div className="ov-in">
            <div className="eyebrow">EXIT-LINK · Command Center</div>
            <h1 id="ov-title" className="mt-5 text-[clamp(44px,5.4vw,84px)] font-extralight leading-[0.95] tracking-[-0.045em] text-ink">
              <span className="text-sheen font-light">EXIT-LINK</span>
            </h1>
            <div className="mt-3 text-[clamp(17px,1.5vw,22px)] font-light tracking-[-0.01em] text-ink-2">Adaptive Emergency Communication Network</div>
            <p className="mt-5 max-w-[62ch] text-[15px] leading-relaxed text-ink-2">
              건물 안 통신 노드 일부가 멈춰도, 장애를 감지하고 <span className="text-ink">대체 TCP 경로</span>로 대피 안내 메시지 전달을 다시 시도하는 시스템입니다.
              수신 노드의 <span className="text-[#8FE6BE]">ACK</span>로 전달 여부를 확인합니다.
            </p>
            <div className="mt-7 flex flex-wrap gap-2.5">
              <Link to="/twin?mode=cinematic&case=t010" className="lift inline-flex h-10 items-center gap-2 rounded-full bg-gradient-to-b from-[#F4F8FF] to-[#C6D6EC] px-5 text-[13.5px] font-semibold text-[#0A1220] shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_10px_26px_-12px_rgba(124,200,255,0.8)]">
                <Clapperboard size={15} /> 장애 우회 시연 보기
              </Link>
              <button type="button" onClick={scrollToRecorded} className="lift inline-flex h-10 items-center gap-2 rounded-full border border-white/12 bg-white/[0.04] px-4 text-[13.5px] text-ink hover:border-white/25">
                <Archive size={15} /> 저장된 연구 결과
              </button>
              <Link to="/twin" className="lift inline-flex h-10 items-center gap-2 rounded-full border border-white/12 bg-white/[0.04] px-4 text-[13.5px] text-ink-2 hover:border-white/25 hover:text-ink">
                <Box size={15} /> Digital Twin
              </Link>
            </div>
          </div>

          {/* 현재 LIVE 연결 상태(요약) */}
          <div className="ov-in glass rounded-[24px] p-5" style={{ ['--d' as string]: '120ms' }} data-testid="ov-live-summary">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-[12px] font-medium uppercase tracking-[0.14em] text-ink-3">현재 연결 상태</span>
              <SourceBadge origin="LIVE" />
            </div>
            <dl className="divide-y divide-white/[0.06]">
              <SummaryRow icon={<Server size={15} />} label="백엔드" value={backendText} tone={backendTone} testId="ov-backend" />
              <SummaryRow icon={<Network size={15} />} label="TCP 노드" value={nodeValue} tone={nodeTone} testId="ov-nodes" />
              <SummaryRow icon={<Flame size={15} />} label="LIVE 시나리오" value={scenario ? `활성 · rev ${scenario.state.revision}` : '활성 시나리오 없음'} tone={scenario ? 'info' : 'idle'} tag="SIM" />
              <SummaryRow icon={<Clock3 size={15} />} label="마지막 관측" value={network?.observed_at ? `${timeOf(network.observed_at)} · ${ago(network.observed_at, now)}` : '관측 기록 없음'} tone={network?.observed_at ? 'neutral' : 'idle'} />
            </dl>
          </div>
        </section>

        {/* ── B. LIVE System Status ── */}
        <section aria-labelledby="ov-live" className="space-y-5" data-zone="live">
          <ZoneHeader
            id="ov-live"
            kicker="LIVE"
            title="실시간 운영 상태"
            desc="실제 TCP 노드 관측과 가상 재난 시나리오(SIM)입니다. 값이 없으면 '미실행'·'관측 기록 없음'으로 표시하며 0 을 측정값처럼 쓰지 않습니다."
            tone="live"
            right={<div className="w-full max-w-[560px]"><RetentionNotice compact /></div>}
          />

          {!liveRunning && (
            <div className="ov-in flex flex-col gap-4 rounded-2xl border border-white/[0.08] bg-white/[0.025] px-5 py-4 md:flex-row md:items-center md:justify-between" data-testid="ov-live-empty">
              <div className="flex items-start gap-3">
                <Info size={17} className="mt-0.5 shrink-0 text-ink-3" />
                <div>
                  <div className="text-[14px] text-ink">
                    {!network ? '백엔드 실시간 스트림을 받지 못해 LIVE 운영 데이터가 없습니다.' : '지금은 LIVE TCP 노드가 실행되지 않아 실시간 운영 데이터가 없습니다.'}
                  </div>
                  <div className="mt-0.5 text-[12.5px] text-ink-3">아래 저장된 연구 결과와 실험 기록 재생으로 EXIT-LINK 의 동작을 확인할 수 있습니다. 가상의 운영 값은 만들지 않습니다.</div>
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                <button type="button" onClick={scrollToRecorded} className="lift inline-flex h-9 items-center gap-1.5 rounded-full border border-white/12 bg-white/[0.04] px-3.5 text-[12.5px] text-ink">
                  연구 결과 <ArrowRight size={13} />
                </button>
                <Link to="/twin?mode=replay&case=t010" className="lift inline-flex h-9 items-center gap-1.5 rounded-full border border-[#7CC8FF]/35 bg-[#7CC8FF]/[0.08] px-3.5 text-[12.5px] text-[#CFEAFF]">
                  기록 재생 <ArrowRight size={13} />
                </Link>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            <StatusCard icon={<Network size={16} />} label="TCP 노드 실행" value={nodeValue} sub={nodeSub} tone={nodeTone} testId="ov-card-nodes">
              {observed && total > 0 && (
                <div className="mt-3 grid grid-cols-6 gap-1.5" aria-label="노드별 관측 상태">
                  {a.nodes.map((n) => (
                    <div key={n.id} className="glass-inset flex flex-col items-center gap-1 rounded-lg py-1.5" title={`${n.id} · ${NODE_STATUS_LABEL[n.status]} · ${labels.get(n.locationId) ?? n.locationId} · ${n.reason}`}>
                      <Dot color={STATUS_COLOR[n.status]} size={7} />
                      <span className="font-mono text-[10.5px] text-ink-2">{n.id}</span>
                    </div>
                  ))}
                </div>
              )}
            </StatusCard>
            <StatusCard
              icon={<AlertTriangle size={16} />}
              label="장애 · 의심 노드"
              value={!observed || offlineAll ? '판정 불가' : fails.length ? fails.join(' · ') : suspects.length ? `의심 ${suspects.join(' · ')}` : '없음'}
              sub={!observed || offlineAll ? '노드가 실행되지 않아 장애 여부를 판정하지 않습니다' : fails.length && suspects.length ? `의심·복구 중 ${suspects.join(' · ')}` : fails.length ? '이웃 노드의 장애 판정 또는 연결 불가' : `정상 응답 ${a.nodes.filter((n) => n.status === 'ok').length}/${total} · 링크 장애 ${a.links.filter((l) => l.status === 'fail').length}`}
              tone={!observed || offlineAll ? 'idle' : fails.length ? 'fail' : suspects.length ? 'warn' : 'ok'}
              testId="ov-card-faults"
            />
            <StatusCard
              icon={<Flame size={16} />}
              label="활성 시나리오"
              tag="SIM"
              value={!scenario ? '활성 시나리오 없음' : h?.fire_locations.length ? `화재 · ${labels.get(h.fire_locations[0]) ?? h.fire_locations[0]}` : hazardCount ? `위험 구역 ${hazardCount}곳` : '위험 구역 없음'}
              sub={scenario ? `rev ${scenario.state.revision} · 대피 경로 ${plans.length ? `${plans.length - noRoute}/${plans.length} 확보` : '계산 없음'} · 가상 데이터` : 'Simulation Lab 또는 상단 제어에서 생성'}
              tone={!scenario ? 'idle' : h?.fire_locations.length || noRoute ? 'fail' : hazardCount ? 'warn' : 'info'}
              testId="ov-card-scenario"
            >
              {scenario && hazardCount > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {h!.fire_locations.map((id) => <Chip key={`f${id}`} tone="fail">화재 <span className="font-mono">{id}</span></Chip>)}
                  {h!.dangerous_nodes.map((id) => <Chip key={`d${id}`} tone="warn">위험 <span className="font-mono">{id}</span></Chip>)}
                  {h!.blocked_nodes.map((id) => <Chip key={`b${id}`} tone="fail">차단 <span className="font-mono">{id}</span></Chip>)}
                  {h!.blocked_passages.map((p) => <Chip key={`p${p.source}${p.target}`} tone="fail">통로 <span className="font-mono">{p.source}–{p.target}</span></Chip>)}
                </div>
              )}
            </StatusCard>
            <StatusCard
              icon={<CheckCircle2 size={16} />}
              label="마지막 ACK 기록"
              value={lastAck ? `${lastAck.pair} · ${lastAck.elapsedMs !== null ? ms(lastAck.elapsedMs) : '지연 기록 없음'}` : '관측 기록 없음'}
              sub={lastAck ? `${timeOf(lastAck.at)} · 경로 ${lastAck.route?.join('→') ?? '—'} · 보관 ${a.rows.length}건 중 ACK ${a.rows.filter((r) => r.outcome === 'ack').length}` : '백엔드 메모리에 보관된 ACK 수신 결과가 없습니다'}
              tone={lastAck ? 'ok' : 'idle'}
              testId="ov-card-ack"
            />
            <StatusCard
              icon={<GitBranch size={16} />}
              label="최근 경로 변경"
              value={lastReroute ? lastReroute.route.join(' → ') : '관측 기록 없음'}
              sub={lastReroute ? <span>이전 <s className="text-[#FFA9AC]">{lastReroute.previousRoute!.join('→')}</s> · {timeOf(lastReroute.updatedAt)} · {lastReroute.previousReason === 'retry' ? '같은 메시지 재시도' : '직전 메시지와 다른 경로'}</span> : '관측된 route 이벤트에서 경로 변경이 없었습니다'}
              tone={lastReroute ? 'warn' : 'idle'}
              testId="ov-card-reroute"
            />
            <StatusCard
              icon={<Clock3 size={16} />}
              label="마지막 관측 시각"
              value={network?.observed_at ? timeOf(network.observed_at) : '관측 기록 없음'}
              sub={network?.observed_at ? `${ago(network.observed_at, now)} · 실험 ${a.experiment?.status ?? '상태 없음'}` : network ? '노드 상태 관측이 아직 없습니다' : '백엔드 스냅샷 대기'}
              tone={network?.observed_at ? 'neutral' : 'idle'}
              testId="ov-card-observed"
            />
          </div>

          {/* LIVE 활동 기록: 실제로 받은 기록이 있을 때만 펼칩니다(빈 차트를 늘어놓지 않음) */}
          {lastRows.length || recent.length || plans.length ? (
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
              {lastRows.length > 0 && (
                <ChartCard
                  title="긴급 대피 안내 전달 결과"
                  origin="LIVE"
                  subtitle="최근 24건 전송 소요 시간(elapsed_ms), 막대 색 = 결과"
                  right={<NavLink to="/analytics" label="Analytics" />}
                  table={<SimpleTable head={['시각', '쌍', '결과', '소요', '재시도', '적용']} rows={[...lastRows].reverse().map((r) => [timeOf(r.at), r.pair, OUTCOME[r.outcome].label, r.elapsedMs !== null ? ms(r.elapsedMs) : '—', r.retries ?? '—', r.disposition ?? '미확인'])} />}
                >
                  <div className="h-[170px]">
                    <ResponsiveContainer>
                      <BarChart data={lastRows} margin={{ top: 4, right: 4, bottom: 0, left: -8 }} barCategoryGap={2}>
                        <CartesianGrid vertical={false} stroke={CH.grid} />
                        <XAxis dataKey="idx" {...axisProps} />
                        <YAxis {...axisProps} width={44} unit="ms" />
                        <Tooltip cursor={{ fill: '#ffffff08' }} content={({ payload }) => {
                          const r = payload?.[0]?.payload as (DeliveryRow & { idx: number }) | undefined;
                          return r ? <TipBox title={`#${r.idx} · ${timeOf(r.at)}`} rows={[{ label: '결과', value: OUTCOME[r.outcome].label, color: OUTCOME[r.outcome].color }, { label: '쌍', value: r.pair }, { label: '소요', value: r.elapsedMs !== null ? ms(r.elapsedMs) : '측정값 없음' }, { label: '재시도', value: r.retries ?? '—' }, { label: '경로', value: r.route?.join('→') ?? '—' }]} /> : null;
                        }} />
                        <Bar dataKey="elapsedMs" maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false}>
                          {lastRows.map((r) => <Cell key={r.messageId} fill={OUTCOME[r.outcome].color} />)}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="mt-2 flex items-center justify-between">
                    <Legend items={Object.values(OUTCOME).map((o) => ({ label: o.label, color: o.color }))} />
                    <span className="text-[10px] text-ink-3">전송 오류는 소요 시간 측정값이 없어 막대가 없습니다</span>
                  </div>
                </ChartCard>
              )}
              {recent.length > 0 && (
                <ChartCard title="최근 장애 · 경로 전환 이벤트" origin="LIVE" subtitle="통신 이벤트(노드 로그 시각)와 대피 경로 갱신(SIM)" right={<NavLink to="/network" label="Network Monitor" />}>
                  <ul className="divide-y divide-white/[0.06]">
                    {recent.map((t) => (
                      <li key={t.id} className="flex items-center gap-3 py-1.5 text-xs">
                        <span className="w-[66px] shrink-0 font-mono text-[10px] text-ink-3">{timeOf(t.at)}</span>
                        <SourceBadge origin={t.origin} />
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: t.severity === 'fail' ? '#E5484D' : t.severity === 'warn' ? '#E08A3C' : t.severity === 'action' ? '#7CC8FF' : '#3FB27F' }} />
                        <span className="min-w-0 flex-1 truncate">{t.title}</span>
                      </li>
                    ))}
                  </ul>
                </ChartCard>
              )}
              {plans.length > 0 && (
                <ChartCard title="대피 경로 계산 결과" origin="SIM" subtitle={scenario ? `갱신 ${timeOf(scenario.state.updated_at)} · 가상 데이터` : '가상 데이터'} right={<NavLink to="/twin" label="Digital Twin" />}>
                  <div className="space-y-1.5">
                    {plans.map((p) => (
                      <div key={p.start_location} className={cx('flex items-center justify-between rounded-xl border px-3 py-1.5 text-xs', p.status === 'no_route' ? 'border-fail/40 bg-fail/10' : 'border-white/[0.07] bg-white/[0.025]')}>
                        <span>{labels.get(p.start_location) ?? p.start_location}</span>
                        {p.status === 'route_found' ? <span className="font-mono text-ok">{p.exit_id} · {p.distance_m}m</span> : <span className="text-[#F2878A]">경로 없음 · {reasonLabel(p.reason)}</span>}
                      </div>
                    ))}
                  </div>
                </ChartCard>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2 px-1 text-[12.5px] text-ink-3" data-testid="ov-live-activity-empty">
              <Activity size={14} /> LIVE 활동 기록 없음 — 안내 전송 결과·장애·경로 전환 이벤트를 받으면 여기에 표시합니다.
            </div>
          )}
        </section>

        {/* ── C. RECORDED: 저장된 연구 결과 + 실험 기록 ── */}
        <div id="recorded" className="scroll-mt-6 space-y-16" data-zone="recorded">
          <ResearchSection />
          <RecordedCases />
        </div>

        {/* ── 바로가기 ── */}
        <section aria-labelledby="ov-nav" className="space-y-5">
          <ZoneHeader id="ov-nav" kicker="Explore" title="화면 바로가기" tone="neutral" />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <NavCard to="/twin" icon={<Box size={18} />} title="Digital Twin" desc="3D 건물 · 노드 · REPLAY · CINEMATIC" stat={scenario ? `화재 ${h!.fire_locations.length} · 경로 ${plans.length - noRoute}/${plans.length}` : 'LIVE 시나리오 없음'} />
            <NavCard to="/network" icon={<Network size={18} />} title="Network Monitor" desc="토폴로지 · Heartbeat · 메시지 · REPLAY" stat={a.latestFlow ? `최근 경로 ${a.latestFlow.route.join('→')}` : '관측된 메시지 없음'} />
            <NavCard to="/analytics" icon={<BarChart3 size={18} />} title="Analytics" desc="본 실험 조건별 결과 · LIVE 지표" stat={studyValid ? `본 실험 ${study.sample.valid_pairs}쌍 · ${study.measured_on}` : '본 실험 데이터 확인 불가'} />
            <NavCard to="/lab" icon={<FlaskConical size={18} />} title="Simulation Lab" desc="재난·장애 주입 · 안내 전송" stat={`실험 ${a.experiment?.status ?? '상태 없음'}`} />
            <NavCard to="/story" icon={<Presentation size={18} />} title="STORY" desc="발표용 스크롤 소개" stat="정상 → 장애 → 우회 → ACK" />
          </div>
        </section>
      </div>
    </div>
  );
}

// ── 저장된 연구 결과 ───────────────────────────────────────
function ResearchSection() {
  if (!studyValid) {
    return (
      <section className="rounded-[24px] border border-fail/40 bg-fail/[0.05] p-6" data-testid="ov-research-unavailable">
        <div className="text-[15px] text-ink">저장된 연구 결과를 확인할 수 없습니다</div>
        <p className="mt-1 text-[13px] text-ink-3">분석 데이터의 형식이나 무결성 표시가 올바르지 않아 수치를 표시하지 않습니다. <span className="font-mono">npm run verify:study</span>로 확인하세요.</p>
      </section>
    );
  }
  const d = rowOf(study.overall, 'overall', 'delivered');
  if (!d) {
    return (
      <section className="rounded-[24px] border border-fail/40 bg-fail/[0.05] p-6" data-testid="ov-research-unavailable">
        <div className="text-[15px] text-ink">전체 전달 성공률 행을 찾을 수 없어 수치를 표시하지 않습니다</div>
      </section>
    );
  }
  const strata = Object.values(study.sample.pairs_by_stratum);
  const normal = rowOf(study.by_stratum, 'normal/none', 'delivered');
  const noRoute = rowOf(study.by_stratum, 'no_route/before_send', 'delivered');
  const seqBefore = rowOf(study.by_stratum, 'sequential_failures/before_send', 'delivered');
  const caveats = [
    `단일 PC의 loopback TCP와 가상 6노드 토폴로지에서 측정한 통신 지표입니다. 실제 건물·무선 환경이나 대피 시간 단축은 검증하지 않았습니다.`,
    `Fixed 기준선은 장애 대상 N2를 지나는 고정 경로(N1→N2→N4)이며 재시도 ${study.settings.fixed_retries}회입니다. 단일 장애에서의 큰 차이는 우회 기능 유무를 확인한 결과에 가깝습니다.`,
    normal && noRoute ? `정상 조건(${pct(normal.fixed_rate)} → ${pct(normal.exit_link_rate)})과 경로 없음 조건(${pct(noRoute.fixed_rate)} → ${pct(noRoute.exit_link_rate)})에서는 두 방식의 차이가 없습니다.` : null,
    seqBefore ? `연속 장애 · 전송 전의 차이 ${pp(seqBefore.diff_exit_minus_fixed)}는 Holm 보정 후 p=${pValue(seqBefore.sign_test_p_holm_within_metric_8_strata)}로 통계적으로 유의하지 않습니다.` : null,
  ].filter((x): x is string => !!x);

  return (
    <section aria-labelledby="ov-research" className="relative space-y-6 overflow-hidden rounded-[28px] border border-ice/[0.14] bg-gradient-to-b from-[#101a2a]/80 via-[#0b111c]/70 to-[#080c14]/70 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_40px_80px_-40px_rgba(0,0,0,0.9)] md:p-8" data-testid="ov-research">
      <span aria-hidden className="pointer-events-none absolute -left-24 -top-32 h-72 w-[42rem] rounded-full bg-[radial-gradient(closest-side,rgba(169,199,255,0.12),transparent)] blur-2xl" />
      <span aria-hidden className="pointer-events-none absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-white/35 to-transparent" />
      <ZoneHeader
        id="ov-research"
        kicker="Recorded · Verified Research Results"
        title="저장된 연구 결과"
        desc={`과거 실험 결과입니다. 현재 실시간 운영 성능이 아니며, 백엔드 연결과 무관하게 저장된 분석 파일(${study.protocol})에서 읽습니다.`}
        tone="recorded"
        right={
          <span className="pill h-7 border-ice/30 bg-ice/[0.07] px-3 text-2xs text-ice" title={`원본: ${study.provenance.analysis_dir}`} data-testid="ov-study-label">
            <Archive size={12} aria-hidden /> {study.label}
          </span>
        }
      />

      <div className="relative grid grid-cols-1 gap-5 xl:grid-cols-[1fr_1.25fr]">
        {/* 핵심 수치 */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 xl:grid-cols-1">
          <Kpi accent={METHOD.fixed.color} label={`${METHOD.fixed.label} 전달 성공률`} value={pct(d.fixed_rate)} sub={`${d.fixed_success}/${d.fixed_n} 메시지 · 95% CI ${pctRange(d.fixed_ci_low, d.fixed_ci_high)}`} testId="ov-kpi-fixed" />
          <Kpi accent={METHOD.exit.color} label={`${METHOD.exit.label} 전달 성공률`} value={pct(d.exit_link_rate)} sub={`${d.exit_link_success}/${d.exit_link_n} 메시지 · 95% CI ${pctRange(d.exit_link_ci_low, d.exit_link_ci_high)}`} testId="ov-kpi-exit" />
          <Kpi accent="#A9C7FF" label="성공률 차이 (EXIT-LINK − Fixed)" value={pp(d.diff_exit_minus_fixed)} sub={`95% CI ${ppRange(d.diff_ci_low, d.diff_ci_high)} · 대응 쌍 bootstrap`} testId="ov-kpi-diff" />
        </div>

        {/* 비교 막대 */}
        <div className="glass rounded-2xl p-5" data-testid="ov-compare">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="text-[15px] font-medium text-ink">메시지 전달 성공률 비교</div>
            <div className="font-mono text-[11.5px] text-ink-3">delivered · 방식별 {d.fixed_n}건 · {d.pairs} 대응 쌍</div>
          </div>
          <div className="mt-5 space-y-5" role="img" aria-label={`Fixed ${pct(d.fixed_rate)}, EXIT-LINK ${pct(d.exit_link_rate)}, 차이 ${pp(d.diff_exit_minus_fixed)}`}>
            {[
              { m: METHOD.fixed, rate: d.fixed_rate, lo: d.fixed_ci_low, hi: d.fixed_ci_high, n: `${d.fixed_success}/${d.fixed_n}` },
              { m: METHOD.exit, rate: d.exit_link_rate, lo: d.exit_link_ci_low, hi: d.exit_link_ci_high, n: `${d.exit_link_success}/${d.exit_link_n}` },
            ].map((b, i) => (
              <div key={b.m.label}>
                <div className="mb-1.5 flex items-baseline justify-between text-[12.5px]">
                  <span className="text-ink">{b.m.label} <span className="text-ink-3">· {b.m.sub}</span></span>
                  <span className="font-mono text-[15px] text-ink">{pct(b.rate)} <span className="text-[11px] text-ink-3">{b.n}</span></span>
                </div>
                <div className="relative h-7 rounded-lg bg-white/[0.05] shadow-[inset_0_1px_2px_rgba(0,0,0,0.5)]">
                  <div className="ov-bar absolute inset-y-0 left-0 rounded-lg" style={{ width: `${b.rate * 100}%`, background: `linear-gradient(90deg, ${b.m.color}55, ${b.m.color})`, boxShadow: `0 0 18px -6px ${b.m.color}`, ['--d' as string]: `${200 + i * 160}ms` }} />
                  {/* 95% CI */}
                  <div className="absolute top-1/2 h-px -translate-y-1/2 bg-white/80" style={{ left: `${b.lo * 100}%`, width: `${(b.hi - b.lo) * 100}%` }} title={`95% CI ${pctRange(b.lo, b.hi)}`} />
                  <div className="absolute top-1/2 h-3 w-px -translate-y-1/2 bg-white/80" style={{ left: `${b.lo * 100}%` }} />
                  <div className="absolute top-1/2 h-3 w-px -translate-y-1/2 bg-white/80" style={{ left: `${b.hi * 100}%` }} />
                </div>
              </div>
            ))}
            <div className="relative flex justify-between font-mono text-[10.5px] text-ink-3">
              {[0, 25, 50, 75, 100].map((x) => <span key={x}>{x}%</span>)}
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.06] pt-4">
            <div className="text-[12.5px] text-ink-2">
              차이 <span className="font-mono text-[18px] text-[#CFE0FF]">{pp(d.diff_exit_minus_fixed)}</span>
              <span className="ml-2 text-ink-3">EXIT-LINK 우세 {d.pairs_exit_better}쌍 · Fixed 우세 {d.pairs_fixed_better}쌍 · 동일 {d.pairs_tied}쌍</span>
            </div>
            <Link to="/analytics" className="lift inline-flex items-center gap-1 rounded-full border border-white/12 bg-white/[0.04] px-3 py-1 text-[12px] text-ink-2 hover:text-ink">
              조건별 결과 · Analytics <ArrowUpRight size={12} />
            </Link>
          </div>
          <p className="mt-2 text-[11.5px] leading-relaxed text-ink-3">가로선은 95% 신뢰구간(대응 쌍 bootstrap). 분모는 실패를 포함한 방식별 전체 메시지입니다. 시간 추세가 아닌 전체 표본의 단일 비교입니다.</p>
        </div>
      </div>

      {/* 표본·범위 · 제약 */}
      <div className="relative grid grid-cols-1 gap-5 lg:grid-cols-2">
        <div className="glass-inset rounded-2xl p-5" data-testid="ov-sample">
          <div className="mb-3 text-[12px] font-medium uppercase tracking-[0.14em] text-ink-3">표본 · 측정 범위</div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-[13px]">
            <Def k="측정일 · 프로토콜" v={`${study.measured_on} · ${study.protocol}`} />
            <Def k="유효 셀" v={`${study.sample.valid_cells} / ${study.sample.planned_cells}${study.sample.excluded_cells.length ? ` (제외 ${study.sample.excluded_cells.join(', ')})` : ''}`} />
            <Def k="대응 쌍 · 조건" v={`${study.sample.valid_pairs}쌍 · ${STRATA.length}개 조건(조건당 ${Math.min(...strata)}–${Math.max(...strata)}쌍)`} />
            <Def k="메시지 · 방식별" v={`${d.messages_per_method}건 (셀당 3건)`} />
            <Def k="시간 제한" v={`클라이언트 ${study.settings.client_timeout_seconds}s · 노드 홉 ${study.settings.node_hop_timeout_seconds}s · 관측 ${study.settings.observation_window_seconds}s`} />
            <Def k="재시도" v={`Fixed ${study.settings.fixed_retries}회 · EXIT-LINK 최대 ${study.settings.exit_link_max_retries}회`} />
          </dl>
          <div className="mt-4 border-t border-white/[0.06] pt-3 font-mono text-[11px] leading-relaxed text-ink-3">
            출처 {study.provenance.analysis_dir} · 생성 {study.provenance.generated_at.slice(0, 10)} · 무결성 {study.provenance.integrity_status}
          </div>
        </div>
        <div className="glass-inset rounded-2xl p-5" data-testid="ov-caveats">
          <div className="mb-3 text-[12px] font-medium uppercase tracking-[0.14em] text-ink-3">해석 범위 · 주요 제약</div>
          <ul className="space-y-2 text-[13px] leading-relaxed text-ink-2">
            {caveats.map((t) => (
              <li key={t} className="flex gap-2.5"><span aria-hidden className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-ink-3" />{t}</li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

// ── 저장된 실험 기록(REPLAY) ───────────────────────────────
function RecordedCases() {
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
  const strataLabel = useMemo(() => new Map(STRATA.map((s) => [s.scope, s.label])), []);

  return (
    <section aria-labelledby="ov-cases" className="space-y-5" data-testid="ov-cases">
      <ZoneHeader
        id="ov-cases"
        kicker="Recorded Experiments"
        title="저장된 실험 기록"
        desc="본 실험의 실제 TCP 기록 3건입니다. 카드를 누르면 해당 사례가 선택된 CINEMATIC 화면으로 이동합니다. 메시지 이동은 시각적 보간이며 사람의 대피 동선이 아닙니다."
        tone="recorded"
      />
      {problem && <div role="alert" className="rounded-2xl border border-[#E9954A]/40 bg-[#E9954A]/[0.06] px-4 py-3 text-[13px] text-[#F6C79A]">저장된 실험 기록을 불러오지 못했습니다: {problem}</div>}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {!facts && !problem && [0, 1, 2].map((i) => <div key={i} className="glass h-[260px] animate-pulse rounded-[22px]" />)}
        {facts?.map((f) => {
          const failed = f.acked < f.total;
          const key = `${f.condition.split(' · ')[0]}/${f.condition.split(' · ')[1] ?? 'none'}`;
          return (
            <article key={f.id} className="glass spotlight lift group relative flex flex-col rounded-[22px] p-5 hover:border-white/20" data-testid={`ov-case-${f.id}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[12px] text-ink-3">{f.id}</span>
                <span className="flex gap-1.5">
                  <Chip tone={f.method === 'Fixed' ? 'neutral' : 'action'}>{f.method}</Chip>
                  <Chip>{strataLabel.get(key) ?? f.condition}</Chip>
                </span>
              </div>
              <h3 className="mt-3 text-[20px] font-medium tracking-[-0.015em] text-ink">{f.title}</h3>
              <p className="mt-1 text-[13px] text-ink-3">{f.description}</p>

              <div className="mt-4 rounded-xl border border-white/[0.07] bg-white/[0.025] px-3.5 py-3 font-mono text-[13.5px]">
                {f.reroute ? (
                  <>
                    <div className="text-[11px] uppercase tracking-[0.14em] text-ink-3">경로 변경 기록 · +{(f.reroute.t / 1000).toFixed(3)}s</div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-2">
                      {f.reroute.from && <s className="text-[#FF9EA1]/80">{f.reroute.from.join(' → ')}</s>}
                      <span className="text-ink-3">⇒</span>
                      <span className="text-[#BFE4FF]">{f.reroute.to.join(' → ')}</span>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="text-[11px] uppercase tracking-[0.14em] text-ink-3">기록된 경로</div>
                    <div className={cx('mt-1.5', failed ? 'text-[#FFB3B6]' : 'text-[#BFE4FF]')}>{f.firstRoute?.join(' → ') ?? '경로 기록 없음'}</div>
                  </>
                )}
              </div>

              <dl className="mt-4 grid grid-cols-3 gap-2 text-[12px]">
                <Fact k="ACK" v={`${f.acked} / ${f.total}`} tone={failed ? (f.acked ? 'warn' : 'fail') : 'ok'} />
                <Fact k="장애 기록" v={f.faults.length ? f.faults.map((x) => x.node).join(' · ') : '없음'} tone={f.faults.length ? 'fail' : 'idle'} />
                <Fact k="재전송" v={`${f.retries}회`} tone={f.retries ? 'warn' : 'idle'} />
              </dl>
              <div className="mt-2 text-[11.5px] text-ink-3">
                {f.latencies.length ? `측정 지연 ${f.latencies.map((x) => ms(x)).join(' · ')}` : `ACK 미수신 · ${[...new Set(f.errors)].join(', ')}`}
              </div>

              <div className="mt-auto flex items-center justify-between gap-2 pt-5">
                <Link
                  to={`/twin?mode=cinematic&case=${f.id}`}
                  className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[#CFEAFF] after:absolute after:inset-0 after:rounded-[22px] after:content-['']"
                  aria-label={`${f.id} ${f.title} CINEMATIC 으로 보기`}
                  data-testid={`ov-case-${f.id}-cinematic`}
                >
                  <Clapperboard size={14} /> CINEMATIC 으로 보기 <ArrowRight size={13} className="transition-transform group-hover:translate-x-0.5" />
                </Link>
                <Link
                  to={`/twin?mode=replay&case=${f.id}`}
                  className="relative z-10 inline-flex items-center gap-1 rounded-full border border-white/12 bg-white/[0.04] px-3 py-1 text-[12px] text-ink-2 hover:text-ink"
                  data-testid={`ov-case-${f.id}-replay`}
                >
                  REPLAY <ArrowUpRight size={12} />
                </Link>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

// ── 조각 ───────────────────────────────────────────────────
function ZoneHeader({ id, kicker, title, desc, tone, right }: { id: string; kicker: string; title: string; desc?: string; tone: 'live' | 'recorded' | 'neutral'; right?: ReactNode }) {
  const dot = tone === 'live' ? '#3FC28A' : tone === 'recorded' ? '#A9C7FF' : '#7C8799';
  return (
    <div className="relative flex flex-wrap items-end justify-between gap-4">
      <div>
        <div className="flex items-center gap-2 font-mono text-[11.5px] uppercase tracking-[0.18em]" style={{ color: dot }}>
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: dot, boxShadow: tone === 'neutral' ? undefined : `0 0 10px ${dot}` }} />
          {kicker}
        </div>
        <h2 id={id} className="mt-2 text-[clamp(24px,2.2vw,32px)] font-light tracking-[-0.025em] text-ink">{title}</h2>
        {desc && <p className="mt-1.5 max-w-[78ch] text-[13.5px] leading-relaxed text-ink-3">{desc}</p>}
      </div>
      {right}
    </div>
  );
}

function SummaryRow({ icon, label, value, tone, tag, testId }: { icon: ReactNode; label: string; value: string; tone: Tone; tag?: 'SIM'; testId?: string }) {
  return (
    <div className="flex items-center gap-3 py-2.5" data-testid={testId}>
      <span className="text-ink-3">{icon}</span>
      <dt className="w-[78px] shrink-0 text-[13px] text-ink-3 sm:w-[92px]">{label}</dt>
      <dd className="flex min-w-0 flex-1 items-center justify-end gap-2 text-right text-[14px]" style={{ color: TONE[tone] }}>
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: TONE[tone], boxShadow: tone === 'idle' ? undefined : `0 0 8px ${TONE[tone]}` }} />
        <span className="min-w-0 break-words sm:truncate">{value}</span>
        {tag && <SourceBadge origin={tag} />}
      </dd>
    </div>
  );
}

function StatusCard({ icon, label, value, sub, tone, tag, children, testId }: { icon: ReactNode; label: string; value: string; sub: ReactNode; tone: Tone; tag?: 'SIM'; children?: ReactNode; testId?: string }) {
  return (
    <div className="glass spotlight lift ov-in flex min-w-0 flex-col rounded-[20px] p-5 hover:border-white/15" data-testid={testId} data-tone={tone}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-[12.5px] font-medium text-ink-2"><span className="text-ink-3">{icon}</span>{label}</span>
        <SourceBadge origin={tag ?? 'LIVE'} />
      </div>
      <div className="mt-3 truncate text-[22px] font-medium leading-tight tracking-[-0.015em]" style={{ color: TONE[tone] }}>{value}</div>
      <div className="mt-1.5 text-[12.5px] leading-snug text-ink-3">{sub}</div>
      {children}
    </div>
  );
}

function Kpi({ label, value, sub, accent, testId }: { label: string; value: string; sub: string; accent: string; testId?: string }) {
  return (
    <div className="glass relative overflow-hidden rounded-2xl px-5 py-4" style={{ borderColor: `${accent}40` }} data-testid={testId}>
      <span aria-hidden className="pointer-events-none absolute inset-x-5 top-0 h-px" style={{ background: `linear-gradient(90deg, transparent, ${accent}, transparent)` }} />
      <span aria-hidden className="pointer-events-none absolute -right-10 -top-12 h-28 w-28 rounded-full opacity-25 blur-2xl" style={{ background: accent }} />
      <div className="text-[12.5px] text-ink-2">{label}</div>
      <div className="mt-1.5 font-mono text-[clamp(30px,2.6vw,40px)] font-medium leading-none tracking-[-0.03em] text-ink" style={{ textShadow: `0 0 26px ${accent}55` }} data-value>{value}</div>
      <div className="mt-2 truncate text-[11.5px] text-ink-3" title={sub}>{sub}</div>
    </div>
  );
}

function Def({ k, v }: { k: string; v: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11.5px] text-ink-3">{k}</dt>
      <dd className="mt-0.5 text-ink-2">{v}</dd>
    </div>
  );
}

function Fact({ k, v, tone }: { k: string; v: string; tone: Tone }) {
  return (
    <div className="rounded-lg bg-white/[0.03] px-2.5 py-2">
      <dt className="text-[10.5px] text-ink-3">{k}</dt>
      <dd className="mt-0.5 truncate font-mono text-[13px] font-medium" style={{ color: TONE[tone] }}>{v}</dd>
    </div>
  );
}

function NavLink({ to, label }: { to: string; label: string }) {
  return (
    <Link to={to} className="flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-0.5 text-[10.5px] text-ink-2 transition hover:border-glow/45 hover:text-ink">
      {label} <ArrowUpRight size={11} />
    </Link>
  );
}

function NavCard({ to, icon, title, desc, stat }: { to: string; icon: ReactNode; title: string; desc: string; stat: string }) {
  return (
    <Link to={to} className="glass spotlight lift group flex flex-col justify-between rounded-[20px] p-5 hover:border-action/45">
      <div className="flex items-center justify-between text-ink-2 group-hover:text-action">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-gradient-to-b from-white/[0.10] to-white/[0.02] shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]">{icon}</span>
        <ArrowUpRight size={15} className="transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
      </div>
      <div className="mt-5">
        <div className="text-[15px] font-semibold">{title}</div>
        <div className="mt-0.5 text-[12px] text-ink-3">{desc}</div>
        <div className="mt-3 truncate font-mono text-[11.5px] text-ink-2">{stat}</div>
      </div>
    </Link>
  );
}
