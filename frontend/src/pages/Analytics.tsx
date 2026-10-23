import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Activity, Archive, ArrowRight, ChevronDown, Info } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useAnalytics } from '@/store/useAnalytics';
import { ms, timeOf } from '@/domain/format';
import type { DeliveryRow, Stats } from '@/domain/analytics';
import { CH, ChartCard, Legend, NoData, SimpleTable, StatTile, TipBox, axisProps } from '@/ui/charts';
import { RetentionNotice } from '@/ui/RetentionNotice';
import { SourceBadge } from '@/ui/primitives';
import { Accordion, StudyResults } from '@/ui/study/StudyResults';
import { cx } from '@/ui/primitives';

const OUTCOME: Record<DeliveryRow['outcome'], { label: string; color: string }> = {
  ack: { label: 'ACK 수신·성공', color: CH.good },
  no_ack: { label: 'ACK 없음·실패', color: CH.bad },
  transport_error: { label: '전송 오류', color: CH.warn },
};
const DISP: Record<string, string> = { applied: '적용', stale: '이전 버전', duplicate: '중복', version_conflict: '버전 충돌', publisher_conflict: '발신자 충돌', query_error: '조회 오류', none: '미확인' };

const statText = (s: Stats | null) => (s ? `${ms(s.median)}` : '데이터 없음');
const statSub = (s: Stats | null, unit = '건') => (s ? `n=${s.n}${unit === '건' ? '' : unit} · 최소 ${ms(s.min)} · 최대 ${ms(s.max)}` : '측정 표본 없음');
const H = 210;

/**
 * Analytics — 두 영역을 탭으로 나눕니다.
 *  - RECORDED STUDY(기본): 저장된 본 실험 결과(domain/study, 정적·검증된 JSON). 백엔드와 무관.
 *  - LIVE ANALYTICS(?tab=live): 현재 세션에서 실제로 수집한 값만(useAnalytics, WebSocket·REST). 데이터가 없으면 간결한 빈 상태.
 * 두 영역의 값은 섞지 않습니다.
 */
export default function Analytics() {
  const [params, setParams] = useSearchParams();
  const tab: 'recorded' | 'live' = params.get('tab') === 'live' ? 'live' : 'recorded';
  const a = useAnalytics();
  const liveCount = a.rows.length + a.detections.length + a.recoveries.length + a.flows.length;
  return (
    <div className="panel-scroll h-full">
      <div className="mx-auto max-w-[1600px] space-y-8 px-6 pb-16 pt-8 md:px-8">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="eyebrow">Analytics</div>
            <h1 className="mt-3 text-[clamp(30px,3vw,44px)] font-light leading-none tracking-[-0.035em] text-ink">연구 분석</h1>
            <p className="mt-2 max-w-[80ch] text-[13.5px] leading-relaxed text-ink-3">모든 수치는 실제 TCP 프로세스 로그와 전송 결과에서 계산한 값입니다. 표본이 없으면 0이 아니라 “데이터 없음”으로 표시합니다.</p>
          </div>
          <div className="seg" role="tablist" aria-label="Analytics 보기">
            <button role="tab" aria-selected={tab === 'recorded'} onClick={() => setParams({}, { replace: true })} data-testid="tab-recorded">
              <Archive size={13} className="mr-1 inline" /> RECORDED STUDY
            </button>
            <button role="tab" aria-selected={tab === 'live'} onClick={() => setParams({ tab: 'live' }, { replace: true })} data-testid="tab-live">
              <span className={cx('mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle', liveCount ? 'bg-ok shadow-[0_0_8px_rgba(63,194,138,0.9)]' : 'bg-ink-3')} /> LIVE ANALYTICS
            </button>
          </div>
        </header>
        <div key={tab} className="page-enter">{tab === 'recorded' ? <StudyResults /> : <LiveAnalytics />}</div>
      </div>
    </div>
  );
}

/** LIVE 지표 정의(데이터 유무와 함께 보여 주는 카탈로그). 정의 문구는 기존 차트 설명과 같습니다. */
function LiveAnalytics() {
  const a = useAnalytics();
  const [showAll, setShowAll] = useState(false);
  const faultEvents = a.nodeFaults.reduce((s, n) => s + n.suspect + n.down + n.recovered + n.restarts, 0);
  const expN = a.experiments.filter((e) => e.deliveries > 0 || e.detection).length;
  const catalog = [
    { key: 'detect', title: '장애 감지 시간', n: a.detections.length, def: 'neighbor_down 로그의 detection_since_first_failure_ms (첫 실패 → 장애 확정, 노드가 직접 측정)', cond: '실험 실행 중 노드에 장애를 주입해 Heartbeat 가 장애를 확정할 때' },
    { key: 'recover', title: '복구 시간', n: a.recoveries.length, def: '재시작(node_started) → 첫 복구 확인, 장애 의심 → 복구 확인(통신 단절 구간). 노드 로그 시각 차이', cond: '장애 확정 뒤 노드를 재시작하고 이웃 노드가 복구를 확인할 때' },
    { key: 'delivery', title: '메시지 전달 성공 · 실패', n: a.rows.length, def: 'GuidanceDelivery 기준 전송 결과와 수신 노드의 안내 적용 상태(disposition)', cond: 'Simulation Lab 에서 대피 안내를 전송할 때' },
    { key: 'latency', title: '전송 지연 · 재전송', n: a.rows.length, def: '전송 순서별 elapsed_ms 와 재시도 횟수', cond: '안내 전송 결과가 보관될 때' },
    { key: 'route', title: '장애 발생 전후 통신 경로', n: a.reroutes.length, def: 'route_selected 이벤트에서 같은 발신·수신 쌍의 경로가 바뀐 메시지(또는 같은 메시지의 재시도)', cond: `안내 전송으로 route_selected 이벤트가 관측될 때(현재 관측 메시지 ${a.flows.length}건)` },
    { key: 'faults', title: '노드별 장애 이벤트', n: faultEvents, def: '이웃 노드들이 해당 노드를 판정한 보고 수(관측 노드마다 1건)', cond: '실험 실행 중 이웃 판정(suspect·down·recovered)이 기록될 때' },
    { key: 'exp', title: '실험별 성능 비교', n: expN, def: 'experiment.changed 이벤트로 만든 실험 구간에 전송 결과·감지 측정값을 배정', cond: '실험 구간 안에서 전송·장애 측정값이 쌓일 때' },
  ];
  const hasLive = catalog.some((c) => c.n > 0);
  return (
    <div className="space-y-6" data-testid="live">
      <div className="flex flex-wrap items-center gap-2">
        <SourceBadge origin="LIVE" />
        <h2 className="text-[18px] font-medium text-ink">실시간 관제 지표</h2>
        <span className="text-[12.5px] text-ink-3">백엔드가 실행 중일 때 WebSocket·REST 로 갱신되는 현재 세션 데이터입니다. RECORDED STUDY 결과와 섞이지 않습니다.</span>
      </div>
      <RetentionNotice />
      {!hasLive && (
        <div className="glass rounded-[24px] px-6 py-10 text-center md:px-10" data-testid="live-empty">
          <Activity size={22} className="mx-auto text-ink-3" />
          <div className="mt-3 text-[20px] font-light text-ink">현재 실시간 측정 데이터가 없습니다.</div>
          <p className="mx-auto mt-2 max-w-[62ch] text-[13.5px] leading-relaxed text-ink-3">
            LIVE 실험이 실행되지 않았거나 현재 세션에서 관측된 기록이 없습니다. 기존 연구 결과는 RECORDED STUDY 탭에서 확인할 수 있습니다. 이 화면은 실험을 시작하거나 가상의 값을 만들지 않습니다.
          </p>
        </div>
      )}
      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="text-[13px] font-medium text-ink-2">LIVE 지표 정의 · 수집 조건 · 데이터 유무</div>
          <button type="button" onClick={() => setShowAll((x) => !x)} aria-expanded={showAll || hasLive} disabled={hasLive} data-testid="live-show-all" className="lift inline-flex items-center gap-1.5 rounded-full border border-white/12 bg-white/[0.04] px-3 py-1 text-[12px] text-ink-2 hover:text-ink disabled:opacity-40">
            <ChevronDown size={13} className={cx('transition-transform', (showAll || hasLive) && 'rotate-180')} /> {hasLive ? '측정 데이터가 있어 차트를 표시 중' : showAll ? '상세 측정 화면 접기' : '상세 측정 화면 모두 펼치기'}
          </button>
        </div>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3" data-testid="live-catalog">
          {catalog.map((c) => (
            <Accordion key={c.key} title={`${c.title} · ${c.n ? `측정 ${c.n}건` : '데이터 없음'}`} testId={`live-metric-${c.key}`}>
              <dl className="space-y-2 text-[12.5px]">
                <div><dt className="text-ink-3">정의</dt><dd className="text-ink-2">{c.def}</dd></div>
                <div><dt className="text-ink-3">수집 조건</dt><dd className="text-ink-2">{c.cond}</dd></div>
                <div><dt className="text-ink-3">현재 데이터</dt><dd className={c.n ? 'text-[#7CE0B2]' : 'text-ink-3'}>{c.n ? `${c.n}건 관측` : '없음 — 0 으로 간주하지 않음'}</dd></div>
              </dl>
            </Accordion>
          ))}
        </div>
        <p className="mt-2 flex gap-1.5 text-[11.5px] text-ink-3"><Info size={12} className="mt-0.5 shrink-0" />측정값이 하나라도 들어오면 아래에 기존 LIVE 차트가 그대로 표시됩니다.</p>
      </div>
      {(hasLive || showAll) && <LiveCharts />}
    </div>
  );
}

/** 기존 실시간 관제 지표 차트(계산·표시 로직 변경 없음) */
function LiveCharts() {
  const a = useAnalytics();
  const total = a.rows.length;
  const acked = a.rows.filter((r) => r.outcome === 'ack').length;
  const retriesTotal = a.rows.some((r) => r.retries !== null) ? a.rows.reduce((s, r) => s + (r.retries ?? 0), 0) : null;

  const outcomeData = (Object.keys(OUTCOME) as DeliveryRow['outcome'][]).map((k) => ({ key: k, label: OUTCOME[k].label, count: a.rows.filter((r) => r.outcome === k).length, color: OUTCOME[k].color }));
  const dispData = Object.entries(
    a.rows.reduce<Record<string, number>>((acc, r) => ((acc[r.disposition ?? 'none'] = (acc[r.disposition ?? 'none'] ?? 0) + 1), acc), {}),
  ).map(([k, v]) => ({ key: k, label: DISP[k] ?? k, count: v }));
  const latency = a.rows.map((r, i) => ({ ...r, idx: i + 1 }));
  const detections = a.detections.map((d, i) => ({ ...d, idx: i + 1, name: `${d.target}←${d.observer}` }));
  const recov = a.recoveries.map((r, i) => ({ ...r, idx: i + 1 }));
  const faultsAny = a.nodeFaults.some((n) => n.suspect + n.down + n.recovered + n.restarts > 0);
  const expRows = a.experiments.filter((e) => e.deliveries > 0 || e.detection);

  return (
    <div className="space-y-5" data-testid="live-charts">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-6">
          <StatTile label="장애 감지 시간(중앙값)" origin="LIVE" value={statText(a.detection)} sub={statSub(a.detection)} tone={a.detection ? undefined : 'muted'} />
          <StatTile label="재시작→복구 확인(중앙값)" origin="LIVE" value={statText(a.restartToConfirm)} sub={statSub(a.restartToConfirm)} tone={a.restartToConfirm ? undefined : 'muted'} />
          <StatTile label="전달 성공(ACK)" origin="LIVE" value={total ? `${acked}/${total}` : '데이터 없음'} sub={total ? `${Math.round((acked / total) * 100)}% · 보관된 전송 결과 기준` : '보관된 전송 결과 없음'} tone={!total ? 'muted' : acked === total ? 'ok' : 'warn'} />
          <StatTile label="전송 지연(중앙값)" origin="LIVE" value={statText(a.elapsed)} sub={statSub(a.elapsed)} tone={a.elapsed ? undefined : 'muted'} />
          <StatTile label="재전송 합계" origin="LIVE" value={retriesTotal ?? '데이터 없음'} sub={retriesTotal !== null ? `${a.rows.filter((r) => (r.retries ?? 0) > 0).length}건에서 재시도` : '측정값 없음'} tone={retriesTotal === null ? 'muted' : undefined} />
          <StatTile label="경로 전환 관측" origin="LIVE" value={a.flows.length ? a.reroutes.length : '데이터 없음'} sub={a.flows.length ? `관측 메시지 ${a.flows.length}건 중` : 'route_selected 이벤트 없음'} tone={a.flows.length ? undefined : 'muted'} />
        </div>

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {/* 장애 감지 */}
          <ChartCard
            title="장애 감지 시간"
            origin="LIVE"
            subtitle="neighbor_down 로그의 detection_since_first_failure_ms (첫 실패 → 장애 확정, 노드가 직접 측정)"
            table={<SimpleTable head={['시각', '대상←관측 노드', '감지 시간']} rows={detections.map((d) => [timeOf(d.at), d.name, ms(d.ms)])} />}
          >
            {!detections.length ? (
              <NoData title="데이터 없음" hint="실험 실행 중 노드에 장애를 주입하면 Heartbeat가 장애를 확정할 때 측정값이 기록됩니다." height={H} />
            ) : (
              <div style={{ height: H }}>
                <ResponsiveContainer>
                  <BarChart data={detections} margin={{ top: 4, right: 4, bottom: 0, left: -8 }}>
                    <CartesianGrid vertical={false} stroke={CH.grid} />
                    <XAxis dataKey="name" {...axisProps} interval="preserveStartEnd" />
                    <YAxis {...axisProps} width={48} unit="ms" />
                    <Tooltip cursor={{ fill: '#ffffff08' }} content={({ payload }) => {
                      const d = payload?.[0]?.payload as (typeof detections)[number] | undefined;
                      return d ? <TipBox title={`${d.target} 장애 확정 · ${timeOf(d.at)}`} rows={[{ label: '관측 노드', value: d.observer }, { label: '감지 시간', value: ms(d.ms) }]} /> : null;
                    }} />
                    <Bar dataKey="ms" fill={CH.single} maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </ChartCard>

          {/* 복구 */}
          <ChartCard
            title="복구 시간"
            origin="LIVE"
            subtitle="장애 확정 후 재시작한 노드: 재시작(node_started) → 첫 복구 확인, 장애 의심 → 복구 확인(통신 단절 구간). 노드 로그 시각 차이"
            table={<SimpleTable head={['노드', '재시작', '재시작→확인', '단절 구간', '확인 노드']} rows={recov.map((r) => [r.node, timeOf(r.startedAt), ms(r.restartToConfirmMs), r.outageMs !== null ? ms(r.outageMs) : '—', r.confirmedBy])} />}
          >
            {!recov.length ? (
              <NoData title="데이터 없음" hint="장애 확정 뒤 복구(재시작)하고 이웃 노드가 복구를 확인하면 기록됩니다." height={H} />
            ) : (
              <>
                <div style={{ height: H - 24 }}>
                  <ResponsiveContainer>
                    <BarChart data={recov} margin={{ top: 4, right: 4, bottom: 0, left: -8 }} barGap={2}>
                      <CartesianGrid vertical={false} stroke={CH.grid} />
                      <XAxis dataKey="node" {...axisProps} />
                      <YAxis {...axisProps} width={56} unit="ms" />
                      <Tooltip cursor={{ fill: '#ffffff08' }} content={({ payload }) => {
                        const r = payload?.[0]?.payload as (typeof recov)[number] | undefined;
                        return r ? <TipBox title={`${r.node} · ${timeOf(r.startedAt)}`} rows={[{ label: '재시작→복구 확인', value: ms(r.restartToConfirmMs), color: CH.good }, { label: '장애 의심→복구 확인', value: r.outageMs !== null ? ms(r.outageMs) : '—', color: CH.warn }, { label: '확인 노드', value: r.confirmedBy }]} /> : null;
                      }} />
                      <Bar dataKey="restartToConfirmMs" name="재시작→복구 확인" fill={CH.good} maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false} />
                      <Bar dataKey="outageMs" name="장애 의심→복구 확인" fill={CH.warn} maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <Legend items={[{ label: '재시작 → 복구 확인', color: CH.good }, { label: '장애 의심 → 복구 확인(단절 구간)', color: CH.warn }]} />
              </>
            )}
          </ChartCard>

          {/* 전달 성공·실패 */}
          <ChartCard
            title="메시지 전달 성공 · 실패"
            origin="LIVE"
            subtitle="GuidanceDelivery 기준. 왼쪽: 전송 결과, 오른쪽: 수신 노드의 안내 적용 상태(disposition)"
            table={<SimpleTable head={['구분', '건수']} rows={[...outcomeData.map((d) => [d.label, d.count]), ...dispData.map((d) => [`적용: ${d.label}`, d.count])]} />}
          >
            {!total ? (
              <NoData title="데이터 없음" hint="Simulation Lab에서 대피 안내를 전송하면 실제 결과가 집계됩니다." height={H} />
            ) : (
              <div className="grid grid-cols-2 gap-4">
                <HBar data={outcomeData} colorOf={(d) => d.color} />
                <HBar data={dispData} colorOf={(d) => (d.key === 'applied' ? CH.good : d.key === 'none' || d.key === 'query_error' ? CH.single : CH.warn)} />
              </div>
            )}
          </ChartCard>

          {/* 지연·재전송 */}
          <ChartCard
            title="전송 지연시간 · 재전송"
            origin="LIVE"
            subtitle="전송 순서별 elapsed_ms(막대 색 = 결과)와 재시도 횟수"
            table={<SimpleTable head={['#', '시각', '쌍', '결과', '소요', '재시도', '시도 수']} rows={latency.map((r) => [r.idx, timeOf(r.at), r.pair, OUTCOME[r.outcome].label, r.elapsedMs !== null ? ms(r.elapsedMs) : '—', r.retries ?? '—', r.attempts ?? '—'])} />}
          >
            {!total ? (
              <NoData title="데이터 없음" height={H} />
            ) : (
              <>
                <div style={{ height: 140 }}>
                  <ResponsiveContainer>
                    <BarChart data={latency} margin={{ top: 4, right: 4, bottom: 0, left: -8 }} barCategoryGap={2}>
                      <CartesianGrid vertical={false} stroke={CH.grid} />
                      <XAxis dataKey="idx" {...axisProps} />
                      <YAxis {...axisProps} width={48} unit="ms" />
                      <Tooltip cursor={{ fill: '#ffffff08' }} content={({ payload }) => {
                        const r = payload?.[0]?.payload as (typeof latency)[number] | undefined;
                        return r ? <TipBox title={`#${r.idx} · ${timeOf(r.at)}`} rows={[{ label: '결과', value: OUTCOME[r.outcome].label, color: OUTCOME[r.outcome].color }, { label: '소요', value: r.elapsedMs !== null ? ms(r.elapsedMs) : '측정값 없음' }, { label: '재시도', value: r.retries ?? '—' }, { label: '최종 경로', value: r.route?.join('→') ?? '—' }]} /> : null;
                      }} />
                      <Bar dataKey="elapsedMs" maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false}>
                        {latency.map((r) => <Cell key={r.messageId} fill={OUTCOME[r.outcome].color} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-1 text-[10px] text-ink-3">재시도 횟수</div>
                <div style={{ height: 70 }}>
                  <ResponsiveContainer>
                    <BarChart data={latency} margin={{ top: 4, right: 4, bottom: 0, left: -8 }} barCategoryGap={2}>
                      <CartesianGrid vertical={false} stroke={CH.grid} />
                      <XAxis dataKey="idx" hide />
                      <YAxis {...axisProps} width={48} allowDecimals={false} domain={[0, 'dataMax + 1']} />
                      <Tooltip cursor={{ fill: '#ffffff08' }} content={({ payload }) => {
                        const r = payload?.[0]?.payload as (typeof latency)[number] | undefined;
                        return r ? <TipBox title={`#${r.idx}`} rows={[{ label: '재시도', value: r.retries ?? '측정값 없음' }, { label: '시도 수', value: r.attempts ?? '—' }]} /> : null;
                      }} />
                      <Bar dataKey="retries" fill={CH.single} maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <Legend items={Object.values(OUTCOME).map((o) => ({ label: o.label, color: o.color }))} />
              </>
            )}
          </ChartCard>

          {/* 경로 비교 */}
          <ChartCard title="장애 발생 전후 통신 경로" origin="LIVE" subtitle="route_selected 이벤트에서 같은 발신·수신 쌍의 경로가 바뀐 메시지(또는 같은 메시지의 재시도)">
            {!a.reroutes.length ? (
              <NoData title="경로 전환 관측 없음" hint={a.flows.length ? `관측된 메시지 ${a.flows.length}건 모두 직전과 같은 경로입니다.` : '안내를 전송하면 메시지 경로가 기록됩니다.'} height={H} />
            ) : (
              <div className="panel-scroll max-h-[260px] space-y-2">
                {[...a.reroutes].reverse().map((r) => (
                  <div key={r.messageId} className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 rounded-lg border border-line px-3 py-2">
                    <div>
                      <div className="text-[10px] text-ink-3">{r.reason === 'retry' ? '이전 시도' : '직전 메시지'}</div>
                      <div className="font-mono text-xs text-ink-2 line-through decoration-[#D84560]/70">{r.before.join(' → ')}</div>
                    </div>
                    <ArrowRight size={14} className="text-ink-3" />
                    <div>
                      <div className="text-[10px] text-ink-3">{timeOf(r.at)} · {r.messageId.slice(0, 8)}</div>
                      <div className="font-mono text-xs text-action">{r.after.join(' → ')}</div>
                    </div>
                    <div className="col-span-3 text-[10px] text-ink-3">
                      제외 <span className="font-mono text-[#F2878A]">{r.excluded.join(', ') || '—'}</span> · 소요 {r.elapsedMs !== null ? ms(r.elapsedMs) : '결과 없음'} · 시도 {r.attempts ?? '—'}회
                    </div>
                  </div>
                ))}
              </div>
            )}
          </ChartCard>

          {/* 노드별 장애 */}
          <ChartCard
            title="노드별 장애 이벤트"
            origin="LIVE"
            subtitle="이웃 노드들이 해당 노드를 판정한 보고 수(관측 노드마다 1건)"
            table={<SimpleTable head={['노드', '의심', '장애', '복구 확인', '프로세스 시작']} rows={a.nodeFaults.map((n) => [n.node, n.suspect, n.down, n.recovered, n.restarts])} />}
          >
            {!faultsAny ? (
              <NoData title="데이터 없음" hint="이 기록 범위에서 장애 판정 이벤트가 없습니다." height={H} />
            ) : (
              <>
                <div style={{ height: H - 24 }}>
                  <ResponsiveContainer>
                    <BarChart data={a.nodeFaults} margin={{ top: 4, right: 4, bottom: 0, left: -16 }} barGap={2}>
                      <CartesianGrid vertical={false} stroke={CH.grid} />
                      <XAxis dataKey="node" {...axisProps} />
                      <YAxis {...axisProps} width={40} allowDecimals={false} />
                      <Tooltip cursor={{ fill: '#ffffff08' }} content={({ payload }) => {
                        const n = payload?.[0]?.payload as (typeof a.nodeFaults)[number] | undefined;
                        return n ? <TipBox title={n.node} rows={[{ label: '장애 의심', value: n.suspect, color: CH.warn }, { label: '장애 확정', value: n.down, color: CH.bad }, { label: '복구 확인', value: n.recovered, color: CH.good }, { label: '프로세스 시작', value: n.restarts }]} /> : null;
                      }} />
                      <Bar dataKey="suspect" name="장애 의심" fill={CH.warn} maxBarSize={18} radius={[4, 4, 0, 0]} isAnimationActive={false} />
                      <Bar dataKey="down" name="장애 확정" fill={CH.bad} maxBarSize={18} radius={[4, 4, 0, 0]} isAnimationActive={false} />
                      <Bar dataKey="recovered" name="복구 확인" fill={CH.good} maxBarSize={18} radius={[4, 4, 0, 0]} isAnimationActive={false} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <Legend items={[{ label: '장애 의심(suspect)', color: CH.warn }, { label: '장애 확정(down)', color: CH.bad }, { label: '복구 확인(recovered)', color: CH.good }]} />
              </>
            )}
          </ChartCard>
        </div>

        {/* 실험별 비교 */}
        <ChartCard
          title="실험별 성능 비교"
          origin="LIVE"
          subtitle="experiment.changed 이벤트로 만든 실험 구간에 전송 결과·감지 측정값을 배정합니다. 구간을 알 수 없는 결과는 “구간 미상”으로 따로 묶습니다."
          table={
            <SimpleTable
              head={['실험', '구간', '전송', 'ACK', '지연 중앙값', '지연 최대', '재시도 합', '감지 중앙값']}
              rows={a.experiments.map((e) => [
                e.label + (e.current ? ' (실행 중)' : ''),
                `${e.from ? timeOf(e.from) : '시작 미상'} ~ ${e.to ? timeOf(e.to) : e.current ? '현재' : '—'}`,
                e.deliveries || '데이터 없음',
                e.deliveries ? `${e.acked}/${e.deliveries}` : '—',
                e.elapsed ? ms(e.elapsed.median) : '데이터 없음',
                e.elapsed ? ms(e.elapsed.max) : '—',
                e.retries ?? '—',
                e.detection ? `${ms(e.detection.median)} (n=${e.detection.n})` : '데이터 없음',
              ])}
            />
          }
        >
          {!expRows.length ? (
            <NoData title="데이터 없음" hint="실험 구간 안에서 전송·장애 측정값이 쌓이면 실험끼리 비교합니다. 백엔드 메모리 범위 밖의 이전 실험은 조회할 수 없습니다." height={180} />
          ) : (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <MetricBars title="전송 지연 중앙값(ms)" data={expRows.map((e) => ({ label: e.label, value: e.elapsed?.median ?? null, n: e.elapsed?.n ?? 0 }))} />
              <MetricBars title="장애 감지 시간 중앙값(ms)" data={expRows.map((e) => ({ label: e.label, value: e.detection?.median ?? null, n: e.detection?.n ?? 0 }))} />
            </div>
          )}
        </ChartCard>
    </div>
  );
}

function HBar<T extends { label: string; count: number }>({ data, colorOf }: { data: T[]; colorOf: (d: T) => string }) {
  return (
    <div style={{ height: Math.max(90, data.length * 34 + 20) }}>
      <ResponsiveContainer>
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 28, bottom: 0, left: 0 }}>
          <XAxis type="number" hide allowDecimals={false} />
          <YAxis type="category" dataKey="label" {...axisProps} width={96} tick={{ ...axisProps.tick, fontFamily: 'Pretendard Variable, sans-serif' }} />
          <Tooltip cursor={{ fill: '#ffffff08' }} content={({ payload }) => {
            const d = payload?.[0]?.payload as T | undefined;
            return d ? <TipBox rows={[{ label: d.label, value: `${d.count}건`, color: colorOf(d) }]} /> : null;
          }} />
          <Bar dataKey="count" maxBarSize={20} radius={[0, 4, 4, 0]} isAnimationActive={false} label={{ position: 'right', fill: '#A3A9B1', fontSize: 11 }}>
            {data.map((d) => <Cell key={d.label} fill={colorOf(d)} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function MetricBars({ title, data }: { title: string; data: { label: string; value: number | null; n: number }[] }) {
  const has = data.some((d) => d.value !== null);
  return (
    <div>
      <div className="mb-1 text-2xs text-ink-3">{title}</div>
      {!has ? (
        <NoData title="데이터 없음" height={150} />
      ) : (
        <div style={{ height: 160 }}>
          <ResponsiveContainer>
            <BarChart data={data} margin={{ top: 14, right: 4, bottom: 0, left: -8 }}>
              <CartesianGrid vertical={false} stroke={CH.grid} />
              <XAxis dataKey="label" {...axisProps} tick={{ ...axisProps.tick, fontSize: 10 }} />
              <YAxis {...axisProps} width={48} />
              <Tooltip cursor={{ fill: '#ffffff08' }} content={({ payload }) => {
                const d = payload?.[0]?.payload as (typeof data)[number] | undefined;
                return d ? <TipBox title={d.label} rows={[{ label: '중앙값', value: d.value !== null ? ms(d.value) : '데이터 없음' }, { label: '표본', value: `${d.n}건` }]} /> : null;
              }} />
              <Bar dataKey="value" fill={CH.single} maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false} label={{ position: 'top', fill: '#A3A9B1', fontSize: 10, formatter: (v: number | null) => (v === null ? '데이터 없음' : ms(v)) }} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
