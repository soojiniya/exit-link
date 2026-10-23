import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Archive, ArrowUpRight, ChevronDown, Clapperboard, Info } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Cell, ErrorBar, LabelList, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CH, ChartCard, SimpleTable, TipBox, axisProps } from '@/ui/charts';
import { ms } from '@/domain/format';
import { STRATA, pValue, pct, pctRange, pp, ppRange, rowOf, study, studyValid, zeroWidth, type RateRow, type StudyMetric } from '@/domain/study';
import { cx } from '@/ui/primitives';
import { loadManifest, loadReplayCase } from '@/domain/replayEngine';
import { caseFacts, type CaseFacts } from '@/ui/overview/recordedCases';
import { caveatItems } from '@/ui/study/caveats';

/**
 * 본 실험 결과(RECORDED · 저장된 정적 데이터). 백엔드·WebSocket·스토어를 쓰지 않으므로 백엔드가 꺼져 있어도 표시됩니다.
 * 모든 수치는 domain/study(검증된 분석 JSON)의 값을 서식만 바꿔 표시하며 재계산하지 않습니다.
 * 방식 색: Fixed #C86A9A(모브), EXIT-LINK CH.good #4A8FE0(블루). 색만으로 구분하지 않도록 라벨·수치·범례·표를 함께 둡니다.
 * 배치 순서(이야기 흐름): 01 문제 → 02 두 방식 → 03 전체 성공률 → 04 조건별 → 05 비용 → 06 개선이 제한적인 조건 → 07 해석 범위.
 */
const M = {
  fixed: { label: 'Fixed (고정 경로)', short: 'Fixed', color: '#C86A9A' },
  exit_link: { label: 'EXIT-LINK (자동 재라우팅)', short: 'EXIT-LINK', color: CH.good },
} as const;
const LABEL_FILL = '#A3A9B1';
const nf = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 0 });

export function StudyResults() {
  if (!studyValid) {
    return (
      <section className="rounded-xl border border-fail/40 bg-panel p-4 text-xs text-ink-2" data-testid="study-unavailable">
        본 실험 결과 데이터의 형식이나 무결성 표시가 올바르지 않아 표시하지 않습니다. <span className="font-mono">npm run verify:study</span>로 확인하세요.
      </section>
    );
  }
  const delivered = rowOf(study.overall, 'overall', 'delivered')!;
  const ack6 = rowOf(study.overall, 'overall', 'ack_6s')!;
  const exit = study.overhead.find((o) => o.method === 'exit_link')!;
  const fixed = study.overhead.find((o) => o.method === 'fixed')!;
  const excludedPairs = study.exclusions.filter((e) => e.level === 'pair');
  const strataN = Object.values(study.sample.pairs_by_stratum);

  return (
    <div className="space-y-14" data-testid="study">
      {/* ── Hero ── */}
      <section aria-labelledby="study-title" className="relative overflow-hidden rounded-[30px] border border-white/[0.09] bg-gradient-to-b from-[#101a2a]/85 via-[#0b111c]/75 to-[#080c14]/70 p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_40px_80px_-40px_rgba(0,0,0,0.9)] md:p-10">
        <span aria-hidden className="pointer-events-none absolute -left-24 -top-32 h-72 w-[42rem] rounded-full bg-[radial-gradient(closest-side,rgba(111,211,255,0.14),transparent)] blur-2xl" />
        <span aria-hidden className="pointer-events-none absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-white/40 to-transparent" />
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="eyebrow">Recorded Study · {study.protocol}</div>
            <h2 id="study-title" className="mt-4 max-w-[26ch] text-[clamp(30px,3.4vw,52px)] font-light leading-[1.05] tracking-[-0.035em] text-ink">
              통신 장애 상황에서의 <span className="text-sheen font-normal">전달 성공률 비교</span>
            </h2>
            <p className="mt-3 max-w-[70ch] text-[14.5px] leading-relaxed text-ink-2">
              Fixed와 EXIT-LINK의 실제 TCP 메시지 전달 성능 비교. 실제 TCP loopback 노드 6개로 측정한 뒤 무결성 검증을 마친 저장된 분석 결과이며, 현재 운영 성능이나 실시간 값이 아닙니다.
            </p>
          </div>
          <span className="pill h-auto min-h-7 max-w-full whitespace-normal border-ice/30 bg-ice/[0.07] px-3 py-1 text-2xs text-ice" title={`원본: ${study.provenance.analysis_dir}`} data-testid="study-label">
            <Archive size={12} aria-hidden /> {study.label}
          </span>
        </div>

        <div className="relative mt-8 grid grid-cols-1 gap-3 md:grid-cols-3">
          <Kpi accent={M.fixed.color} label="Fixed 전달 성공률" value={pct(delivered.fixed_rate)} n={`${delivered.fixed_success}/${delivered.fixed_n} 메시지`} sub={`95% CI ${pctRange(delivered.fixed_ci_low, delivered.fixed_ci_high)}`} testId="kpi-fixed" />
          <Kpi accent={M.exit_link.color} label="EXIT-LINK 전달 성공률" value={pct(delivered.exit_link_rate)} n={`${delivered.exit_link_success}/${delivered.exit_link_n} 메시지`} sub={`95% CI ${pctRange(delivered.exit_link_ci_low, delivered.exit_link_ci_high)}`} testId="kpi-exit" />
          <Kpi accent="#A9C7FF" diff label="성공률 차이 (EXIT−Fixed)" value={pp(delivered.diff_exit_minus_fixed)} n="퍼센트포인트(%p) · 비율이 아닌 차이" sub={`95% CI ${ppRange(delivered.diff_ci_low, delivered.diff_ci_high)} · 대응 셀 bootstrap`} testId="kpi-diff" />
        </div>
        <dl className="relative mt-4 grid grid-cols-2 gap-x-6 gap-y-3 rounded-2xl border border-white/[0.07] bg-white/[0.02] px-5 py-4 text-[13px] md:grid-cols-4" data-testid="study-scope">
          <Def k="유효 대응 쌍" v={`${study.sample.valid_pairs}쌍`} sub={`셀 ${study.sample.valid_cells}/${study.sample.planned_cells} · 제외 쌍 ${excludedPairs.length}`} />
          <Def k="방식별 메시지 시도" v={`${delivered.messages_per_method}건`} sub="실패 포함 전체(분모)" />
          <Def k="조건" v={`${STRATA.length}개 조건`} sub={`조건당 ${Math.min(...strataN)}–${Math.max(...strataN)}쌍`} />
          <Def k="측정 · 범위" v={study.measured_on} sub="단일 PC loopback TCP · 가상 6노드" />
        </dl>
        <p className="relative mt-3 text-[12px] text-ink-3">
          성공률 분모는 실패 메시지를 포함한 전체 메시지(방식별 {delivered.fixed_n}건)입니다. 비율의 95% CI는 대응 쌍 단위 bootstrap(셀 내 메시지 3개를 함께 재표집)입니다.
        </p>
      </section>

      {/* ── 01 · 02 문제와 두 방식 ── */}
      <Chapter no="01–02" title="무엇을 비교했나" kicker="Problem · Methods">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.1fr_1fr_1fr]">
          <div className="glass rounded-2xl p-5">
            <div className="text-[12px] font-medium uppercase tracking-[0.14em] text-ink-3">해결하려는 문제</div>
            <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
              건물 통신망의 중계 노드가 멈추는 부분 장애 상황에서, 대피 안내 메시지가 목적지 노드까지 전달되고 ACK가 돌아오는지를 측정했습니다.
              장애 없음·단일 장애·연속 장애·재시작·경로 없음 {STRATA.length}개 조건에서 같은 조건의 두 방식을 대응 쌍으로 비교합니다.
            </p>
          </div>
          <MethodCard color={M.fixed.color} name="Fixed" sub="고정 경로 기준선" items={['정해진 경로 N1 → N2 → N4로만 전송', `재시도 ${study.settings.fixed_retries}회`, '이웃 장애 감지 기능 없음']} />
          <MethodCard color={M.exit_link.color} name="EXIT-LINK" sub="자동 재라우팅" items={[`heartbeat로 이웃 장애 감지(probe ${(study.settings as Record<string, number | undefined>).probe_interval_seconds ?? '—'}s · 실패 ${(study.settings as Record<string, number | undefined>).failure_threshold ?? '—'}회)`, '장애 링크를 제외한 대체 경로 선택', `최대 재시도 ${study.settings.exit_link_max_retries}회 · 노드 홉 제한 ${study.settings.node_hop_timeout_seconds}s`]} />
        </div>
      </Chapter>

      {/* ── 03 전체 성공률 ── */}
      <Chapter no="03" title="전체 전달 성공률" kicker="Overall">
        <OverallCompare r={delivered} ack6={ack6} />
      </Chapter>

      {/* ── 04 조건별 ── */}
      <Chapter no="04" title="장애 조건별 결과" kicker="By condition">
        <div className="grid grid-cols-1 gap-4 2xl:grid-cols-2">
          <StratumRates />
          <DifferenceChart />
        </div>
      </Chapter>

      {/* ── 05 비용 ── */}
      <Chapter no="05" title="지연 · 재전송 · 제어 트래픽" kicker="Costs">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="study-costs">
          <MiniStat label="6초 이내 ACK · Fixed → EXIT-LINK" value={`${pct(ack6.fixed_rate)} → ${pct(ack6.exit_link_rate)}`} sub={`${ack6.fixed_success}/${ack6.fixed_n} → ${ack6.exit_link_success}/${ack6.exit_link_n} · 차이 ${pp(ack6.diff_exit_minus_fixed)} ${ppRange(ack6.diff_ci_low, ack6.diff_ci_high)}`} />
          <MiniStat label="장애 감지 (EXIT-LINK, 중앙값)" value={exit.detection_ms_median !== null ? ms(exit.detection_ms_median) : '데이터 없음'} sub={`n=${exit.detection_observations_n} · p95 ${ms(exit.detection_ms_p95)} · Fixed는 감지 기능 없음`} />
          <MiniStat label="메시지당 평균 재시도" value={`${fixed.mean_retries} → ${exit.mean_retries.toFixed(3)}`} sub={`Fixed → EXIT-LINK · Fixed 설계상 재시도 ${study.settings.fixed_retries}회`} />
          <MiniStat label="제어 트래픽 평균 (B/s)" value={`${nf(fixed.control_bytes_per_second_mean)} → ${nf(exit.control_bytes_per_second_mean)}`} sub="Fixed → EXIT-LINK · heartbeat·상태 전파 비용" />
        </div>
        <div className="mt-4 space-y-3">
          <Accordion title="ACK 지연 (조건부 지표) · 조건별 표" testId="acc-latency"><LatencyTable /></Accordion>
          <Accordion title="장애 감지 · 제어 트래픽 · 재시도 · 상세 표" testId="acc-overhead">
            <div className="overflow-x-auto"><SimpleTable
              head={['지표', 'Fixed', 'EXIT-LINK']}
              rows={[
                ['제어 트래픽 평균 (B/s)', nf(fixed.control_bytes_per_second_mean), nf(exit.control_bytes_per_second_mean)],
                ['제어 트래픽 중앙값 (B/s)', nf(fixed.control_bytes_per_second_median), nf(exit.control_bytes_per_second_median)],
                ['장애 감지 관측 수', fixed.detection_observations_n, exit.detection_observations_n],
                ['장애 감지 중앙값 / p95', fixed.detection_ms_median === null ? '감지 기능 없음' : `${ms(fixed.detection_ms_median)} / ${ms(fixed.detection_ms_p95)}`, `${ms(exit.detection_ms_median)} / ${ms(exit.detection_ms_p95)}`],
                ['메시지당 평균 재시도', fixed.mean_retries, exit.mean_retries.toFixed(3)],
                ['셀 / 메시지', `${fixed.cells} / ${fixed.messages}`, `${exit.cells} / ${exit.messages}`],
              ]}
            /></div>
            <p className="mt-2 text-2xs leading-relaxed text-ink-3">
              유효 대응 쌍의 셀 기준 기술 통계입니다. EXIT-LINK는 장애가 없을 때도 heartbeat·상태 전파 트래픽이 계속 발생합니다. Fixed는 설계상 재시도 {study.settings.fixed_retries}회입니다.
            </p>
          </Accordion>
        </div>
      </Chapter>

      {/* ── 06 개선이 제한적인 조건 ── */}
      <Chapter no="06" title="성능 개선이 제한적인 조건" kicker="Where it does not help">
        <LimitedConditions />
      </Chapter>

      {/* ── 07 해석 범위 ── */}
      <Chapter no="07" title="해석할 수 있는 범위" kicker="Scope · Caveats">
        <Caveats />
        <div className="mt-4 space-y-3">
          <Accordion title={`표본 선정 · 제외 사유 · 계획 ${study.sample.planned_cells}셀 → 유효 ${study.sample.valid_cells}셀 → 유효 대응 쌍 ${study.sample.valid_pairs}개`} testId="acc-sample">
            <div className="overflow-x-auto"><SimpleTable
              head={['수준', '항목', '조건', '사유']}
              rows={study.exclusions.map((e) => [e.level === 'cell' ? '셀' : '쌍', e.item, `${e.condition} / ${e.fault_timing} #${e.repetition}`, e.reason])}
            /></div>
            <div className="mt-3 text-2xs text-ink-3">조건별 유효 대응 쌍</div>
            <div className="mt-1 grid grid-cols-1 gap-x-4 gap-y-0.5 text-2xs sm:grid-cols-2 lg:grid-cols-4">
              {STRATA.map((s) => (
                <div key={s.scope} className="flex justify-between gap-2 border-b border-white/[0.06] py-1">
                  <span className="text-ink-3">{s.label}</span>
                  <span className="font-mono text-ink-2">{study.sample.pairs_by_stratum[s.scope] ?? '—'}</span>
                </div>
              ))}
            </div>
          </Accordion>
          <Accordion title="출처 · 해시" testId="acc-provenance">
            <div className="space-y-1 text-2xs leading-relaxed text-ink-3">
              <div>원본 폴더: <span className="font-mono text-ink-2">{study.provenance.analysis_dir}</span> (읽기 전용)</div>
              <div>변환: <span className="font-mono">{study.provenance.generator}</span> · {study.provenance.generated_at} · 무결성 {study.provenance.integrity_status} · 원본·후속 입력 해시 불변 {String(study.provenance.protected_inputs_unchanged)}</div>
              <div>{study.provenance.sums_file}: <span className="break-all font-mono">{study.provenance.sums_file_sha256}</span></div>
              <ul className="mt-1 space-y-0.5 font-mono">
                {Object.entries(study.provenance.files).map(([f, h]) => (
                  <li key={f} className="break-all"><span className="text-ink-2">{f}</span> {h}</li>
                ))}
              </ul>
            </div>
          </Accordion>
        </div>
      </Chapter>

      {/* ── 대표 재생 사례 ── */}
      <Chapter no="↗" title="대표 재생 사례" kicker="Replay">
        <p className="mb-4 max-w-[80ch] text-[13px] leading-relaxed text-ink-3">
          아래 3건은 본 실험 기록 중 동작을 눈으로 확인하기 위한 대표 재생 사례입니다. 전체 통계 표본({study.sample.valid_pairs}쌍)을 대신하지 않으며, 여기서 사례를 열어도 데이터나 LIVE 상태는 바뀌지 않습니다.
        </p>
        <RecordedCaseCards />
      </Chapter>
    </div>
  );
}

/** 대표 재생 사례 카드: 문구·수치는 저장된 재생 기록(public/replay)에서 계산합니다. */
function RecordedCaseCards() {
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
  const strata = new Map(STRATA.map((x) => [x.scope, x.label]));
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3" data-testid="study-cases">
      {problem && <div role="alert" className="col-span-full text-[13px] text-[#F6C79A]">재생 기록을 불러오지 못했습니다: {problem}</div>}
      {!facts && !problem && [0, 1, 2].map((i) => <div key={i} className="glass h-[150px] animate-pulse rounded-2xl" />)}
      {facts?.map((f) => {
        const [cond, timing] = f.condition.split(' · ');
        return (
          <div key={f.id} className="glass lift spotlight group relative rounded-2xl p-4 hover:border-white/20" data-testid={`study-case-${f.id}`}>
            <div className="font-mono text-[12px] text-ink-3">{f.id} · 저장된 기록 · {f.method}</div>
            <div className="mt-1 text-[16px] font-medium text-ink">{f.title}</div>
            <div className="mt-1 text-[12px] text-ink-3">{strata.get(`${cond}/${timing ?? 'none'}`) ?? f.condition}</div>
            <div className="mt-2 font-mono text-[12.5px]">
              {f.reroute ? (
                <span><s className="text-[#FF9EA1]/80">{f.reroute.from?.join('→')}</s> <span className="text-ink-3">⇒</span> <span className="text-[#BFE4FF]">{f.reroute.to.join('→')}</span></span>
              ) : (
                <span className={f.acked < f.total ? 'text-[#FFB3B6]' : 'text-[#BFE4FF]'}>{f.firstRoute?.join('→') ?? '경로 기록 없음'}</span>
              )}
            </div>
            <div className="mt-1 text-[12px] text-ink-3">ACK {f.acked}/{f.total} · 장애 {f.faults.length ? f.faults.map((x) => x.node).join('·') : '없음'} · 재전송 {f.retries}회</div>
            <div className="mt-3 flex items-center justify-between">
              <Link to={`/twin?mode=cinematic&case=${f.id}`} className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-[#CFEAFF] after:absolute after:inset-0 after:rounded-2xl after:content-['']" data-testid={`study-case-${f.id}-cinematic`}>
                <Clapperboard size={13} /> CINEMATIC
              </Link>
              <span className="relative z-10 flex gap-1.5">
                <Link to={`/twin?mode=replay&case=${f.id}`} className="inline-flex items-center gap-1 rounded-full border border-white/12 bg-white/[0.04] px-2.5 py-0.5 text-[11.5px] text-ink-2 hover:text-ink">3D <ArrowUpRight size={11} /></Link>
                <Link to={`/network?mode=replay&case=${f.id}`} className="inline-flex items-center gap-1 rounded-full border border-white/12 bg-white/[0.04] px-2.5 py-0.5 text-[11.5px] text-ink-2 hover:text-ink" data-testid={`study-case-${f.id}-network`}>Network <ArrowUpRight size={11} /></Link>
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── 조각 ───────────────────────────────────────────────────
function Chapter({ no, title, kicker, children }: { no: string; title: string; kicker: string; children: ReactNode }) {
  return (
    <section className="study-chapter" aria-label={title}>
      <div className="mb-5 flex items-baseline gap-4 border-b border-white/[0.07] pb-3">
        <span className="font-mono text-[13px] text-ink-3">{no}</span>
        <h3 className="text-[clamp(22px,2vw,30px)] font-light tracking-[-0.025em] text-ink">{title}</h3>
        <span className="ml-auto hidden font-mono text-[11px] uppercase tracking-[0.18em] text-ink-3 sm:inline">{kicker}</span>
      </div>
      {children}
    </section>
  );
}

function Kpi({ label, value, n, sub, accent, diff, testId }: { label: string; value: string; n: string; sub: string; accent: string; diff?: boolean; testId?: string }) {
  return (
    <div className={cx('glass relative overflow-hidden rounded-2xl px-5 py-5', diff && 'bg-[#A9C7FF]/[0.04]')} style={{ borderColor: `${accent}45` }} data-testid={testId}>
      <span aria-hidden className="pointer-events-none absolute inset-x-5 top-0 h-px" style={{ background: `linear-gradient(90deg, transparent, ${accent}, transparent)` }} />
      <span aria-hidden className="pointer-events-none absolute -right-10 -top-12 h-28 w-28 rounded-full opacity-25 blur-2xl" style={{ background: accent }} />
      <div className="flex items-center gap-2 text-[12.5px] text-ink-2">
        <span className="rounded-full border border-ice/30 px-1.5 font-mono text-[9.5px] text-ice">RECORDED</span>
        <span>{label}</span>
      </div>
      <div className="mt-2 font-mono text-[clamp(36px,3.4vw,54px)] font-medium leading-none tracking-[-0.035em] text-ink" style={{ textShadow: `0 0 28px ${accent}55` }} data-value>{value}</div>
      <div className="mt-2 text-[13px] text-ink-2">{n}</div>
      <div className="mt-0.5 text-[11.5px] text-ink-3">{sub}</div>
    </div>
  );
}

function Def({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11.5px] text-ink-3">{k}</dt>
      <dd className="mt-0.5 font-mono text-[16px] text-ink">{v}</dd>
      {sub && <dd className="text-[11.5px] text-ink-3">{sub}</dd>}
    </div>
  );
}

function MethodCard({ color, name, sub, items }: { color: string; name: string; sub: string; items: string[] }) {
  return (
    <div className="glass rounded-2xl p-5" style={{ borderColor: `${color}40` }}>
      <div className="flex items-center gap-2">
        <span className="h-2.5 w-2.5 rounded-sm" style={{ background: color }} />
        <span className="text-[16px] font-semibold text-ink">{name}</span>
        <span className="text-[12.5px] text-ink-3">{sub}</span>
      </div>
      <ul className="mt-3 space-y-1.5 text-[13px] text-ink-2">
        {items.map((t) => <li key={t} className="flex gap-2"><span aria-hidden className="mt-[8px] h-1 w-1 shrink-0 rounded-full bg-ink-3" />{t}</li>)}
      </ul>
    </div>
  );
}

function MiniStat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="glass rounded-2xl px-4 py-3.5">
      <div className="text-[12px] text-ink-3">{label}</div>
      <div className="mt-1.5 font-mono text-[22px] leading-tight text-ink">{value}</div>
      <div className="mt-1 text-[11.5px] leading-snug text-ink-3">{sub}</div>
    </div>
  );
}

/** 상세 표: 필요할 때만 렌더링(펼칠 때 마운트) */
export function Accordion({ title, children, testId, defaultOpen = false }: { title: string; children: ReactNode; testId?: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="glass-inset rounded-2xl" data-testid={testId}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center justify-between gap-3 rounded-2xl px-4 py-3 text-left text-[13.5px] text-ink-2 transition hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#7CC8FF]">
        <span>{title}</span>
        <ChevronDown size={16} className={cx('shrink-0 text-ink-3 transition-transform', open && 'rotate-180')} />
      </button>
      {open && <div className="border-t border-white/[0.06] px-4 pb-4 pt-3">{children}</div>}
    </div>
  );
}

/** 막대 + 95% CI 가로선(값은 항상 글자로도 표시) */
function CiBar({ rate, lo, hi, color, label, n, big }: { rate: number; lo: number; hi: number; color: string; label: string; n: string; big?: boolean }) {
  return (
    <div className="group relative" aria-label={`${label} ${pct(rate)} (${n}), 95% CI ${pctRange(lo, hi)}`} role="img" tabIndex={0}>
      <div className={cx('relative rounded-lg bg-white/[0.05] shadow-[inset_0_1px_2px_rgba(0,0,0,0.5)]', big ? 'h-9' : 'h-4')}>
        <div className="study-bar absolute inset-y-0 left-0 rounded-lg" style={{ width: `${rate * 100}%`, background: `linear-gradient(90deg, ${color}66, ${color})`, boxShadow: `0 0 16px -6px ${color}` }} />
        <div className="absolute top-1/2 h-px -translate-y-1/2 bg-white/85" style={{ left: `${lo * 100}%`, width: `${(hi - lo) * 100}%` }} />
        <div className={cx('absolute top-1/2 w-px -translate-y-1/2 bg-white/85', big ? 'h-4' : 'h-2.5')} style={{ left: `${lo * 100}%` }} />
        <div className={cx('absolute top-1/2 w-px -translate-y-1/2 bg-white/85', big ? 'h-4' : 'h-2.5')} style={{ left: `${hi * 100}%` }} />
      </div>
      {/* 호버·포커스 시 정확한 값 */}
      <div className="pointer-events-none absolute -top-2 left-0 z-20 hidden -translate-y-full whitespace-nowrap rounded-lg border border-white/10 bg-[#0c121b]/95 px-2.5 py-1.5 text-[11.5px] text-ink-2 shadow-xl group-hover:block group-focus:block">
        <span style={{ color }}>{label}</span> {pct(rate, 2)} · {n} · 95% CI {pctRange(lo, hi)}
      </div>
    </div>
  );
}

/** 03 전체 비교(가장 큰 차트) */
function OverallCompare({ r, ack6 }: { r: RateRow; ack6: RateRow }) {
  return (
    <div className="glass rounded-[24px] p-6 md:p-8" data-testid="study-overall">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <div className="text-[16px] font-medium text-ink">메시지 전달 성공률 (delivered)</div>
          <div className="mt-0.5 text-[12.5px] text-ink-3">방식별 {r.fixed_n}건 · {r.pairs} 대응 쌍 · 가로선 = 95% CI</div>
        </div>
        <div className="text-right">
          <div className="font-mono text-[clamp(28px,2.6vw,40px)] text-[#CFE0FF]" data-testid="overall-diff">{pp(r.diff_exit_minus_fixed)}</div>
          <div className="text-[11.5px] text-ink-3">차이 95% CI {ppRange(r.diff_ci_low, r.diff_ci_high)}</div>
        </div>
      </div>
      <div className="mt-7 space-y-6">
        {[
          { m: M.fixed, rate: r.fixed_rate, lo: r.fixed_ci_low, hi: r.fixed_ci_high, n: `${r.fixed_success}/${r.fixed_n}` },
          { m: M.exit_link, rate: r.exit_link_rate, lo: r.exit_link_ci_low, hi: r.exit_link_ci_high, n: `${r.exit_link_success}/${r.exit_link_n}` },
        ].map((b) => (
          <div key={b.m.label}>
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <span className="flex items-center gap-2 text-[14px] text-ink"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: b.m.color }} />{b.m.label}</span>
              <span className="font-mono text-[22px] text-ink">{pct(b.rate)} <span className="text-[12.5px] text-ink-3">{b.n} · CI {pctRange(b.lo, b.hi)}</span></span>
            </div>
            <CiBar rate={b.rate} lo={b.lo} hi={b.hi} color={b.m.color} label={b.m.short} n={b.n} big />
          </div>
        ))}
        <div className="flex justify-between font-mono text-[11px] text-ink-3" aria-hidden>{[0, 25, 50, 75, 100].map((x) => <span key={x}>{x}%</span>)}</div>
      </div>
      <div className="mt-6 grid grid-cols-1 gap-3 border-t border-white/[0.06] pt-5 text-[13px] text-ink-2 md:grid-cols-3">
        <div>대응 쌍 우열 <span className="font-mono text-ink">EXIT-LINK {r.pairs_exit_better} · Fixed {r.pairs_fixed_better} · 동률 {r.pairs_tied}</span></div>
        <div>부호 검정 p <span className="font-mono text-ink">{pValue(r.sign_test_p)}</span> <span className="text-ink-3">(전체, 보정 없음)</span></div>
        <div>6초 이내 ACK <span className="font-mono text-ink">{pct(ack6.fixed_rate)} → {pct(ack6.exit_link_rate)}</span> <span className="text-ink-3">({pp(ack6.diff_exit_minus_fixed)})</span></div>
      </div>
    </div>
  );
}

/** 04 조건별 성공률: 가로 막대(조건명 전체 표시) · 지표 전환 · 정렬 · 표본 수 */
function StratumRates() {
  const [metric, setMetric] = useState<Extract<StudyMetric, 'delivered' | 'ack_6s'>>('delivered');
  const [order, setOrder] = useState<'default' | 'diff'>('default');
  const data = useMemo(() => {
    const rows = STRATA.map((s) => ({ ...s, r: rowOf(study.by_stratum, s.scope, metric)! }));
    return order === 'diff' ? [...rows].sort((a, b) => b.r.diff_exit_minus_fixed - a.r.diff_exit_minus_fixed) : rows;
  }, [metric, order]);
  return (
    <ChartCard
      title="장애 조건별 성공률"
      subtitle="조건마다 Fixed · EXIT-LINK 를 나란히 표시. 가로선 = 대응 쌍 단위 bootstrap 95% CI. 오른쪽 숫자 = 차이(%p)"
      table={<SimpleTable head={['조건', 'Fixed', 'EXIT-LINK', '쌍']} rows={data.map((d) => [d.label,
        `${pct(d.r.fixed_rate)} (${d.r.fixed_success}/${d.r.fixed_n})`, `${pct(d.r.exit_link_rate)} (${d.r.exit_link_success}/${d.r.exit_link_n})`, d.r.pairs])} />}
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" aria-label="지표 선택" className="seg">
          {([['delivered', '전달 성공'], ['ack_6s', '6초 이내 ACK']] as const).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={metric === k} onClick={() => setMetric(k)}>{l}</button>
          ))}
        </div>
        <div role="tablist" aria-label="정렬" className="seg">
          {([['default', '조건 순서'], ['diff', '차이 큰 순']] as const).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={order === k} onClick={() => setOrder(k)} data-testid={`sort-${k}`}>{l}</button>
          ))}
        </div>
      </div>
      <ul className="space-y-3.5" data-testid="strata-rows">
        {data.map((d) => (
          <li key={d.scope} className="grid grid-cols-[1fr_64px] items-center gap-x-3 gap-y-1.5 sm:grid-cols-[minmax(120px,170px)_1fr_64px]" data-scope={d.scope}>
            <div className="col-span-2 min-w-0 sm:col-span-1">
              <div className="text-[13px] text-ink">{d.label}</div>
              <div className="font-mono text-[10.5px] text-ink-3">{d.r.pairs}쌍 · 방식별 {d.r.fixed_n}건</div>
            </div>
            <div className="space-y-1.5">
              <div className="grid grid-cols-[1fr_92px] items-center gap-2">
                <CiBar rate={d.r.fixed_rate} lo={d.r.fixed_ci_low} hi={d.r.fixed_ci_high} color={M.fixed.color} label="Fixed" n={`${d.r.fixed_success}/${d.r.fixed_n}`} />
                <span className="font-mono text-[11.5px] text-ink-2">{pct(d.r.fixed_rate)} <span className="text-ink-3">{d.r.fixed_success}/{d.r.fixed_n}</span></span>
              </div>
              <div className="grid grid-cols-[1fr_92px] items-center gap-2">
                <CiBar rate={d.r.exit_link_rate} lo={d.r.exit_link_ci_low} hi={d.r.exit_link_ci_high} color={M.exit_link.color} label="EXIT-LINK" n={`${d.r.exit_link_success}/${d.r.exit_link_n}`} />
                <span className="font-mono text-[11.5px] text-ink-2">{pct(d.r.exit_link_rate)} <span className="text-ink-3">{d.r.exit_link_success}/{d.r.exit_link_n}</span></span>
              </div>
            </div>
            <div className={cx('text-right font-mono text-[13px]', d.r.diff_exit_minus_fixed > 0 ? 'text-[#CFE0FF]' : d.r.diff_exit_minus_fixed < 0 ? 'text-[#E6A3C4]' : 'text-ink-3')}>{pp(d.r.diff_exit_minus_fixed)}</div>
          </li>
        ))}
      </ul>
      <div className="mt-4 flex flex-wrap items-center gap-4 text-[11.5px] text-ink-3">
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: M.fixed.color }} />{M.fixed.label}</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: M.exit_link.color }} />{M.exit_link.label}</span>
        <span>막대 위에 마우스를 올리거나 포커스하면 소수점 둘째 자리 값과 CI 를 표시합니다.</span>
      </div>
    </ChartCard>
  );
}

/** ACK 지연(조건부) 표 */
function LatencyTable() {
  const rows = [{ scope: 'overall', label: '전체' }, ...STRATA].map((s) => ({ s, r: study.latency.find((l) => l.scope === s.scope) }));
  const cell = (n: number, total: number, med: number | null, p95: number | null) =>
    n ? `${n}/${total} · ${med!.toFixed(1)} / ${p95!.toFixed(1)}` : `0/${total} · 계산 불가`;
  return (
    <>
      <div className="overflow-x-auto"><SimpleTable
        head={['조건', 'Fixed: ACK n/전체 · 중앙값 / p95 ms', 'EXIT-LINK: ACK n/전체 · 중앙값 / p95 ms']}
        rows={rows.filter((x) => x.r).map(({ s, r }) => [s.label,
          cell(r!.fixed_ack_n, r!.fixed_total_n, r!.fixed_median_ms, r!.fixed_p95_ms),
          cell(r!.exit_link_ack_n, r!.exit_link_total_n, r!.exit_link_median_ms, r!.exit_link_p95_ms)])}
      /></div>
      <p className="mt-2 flex gap-1.5 text-2xs leading-relaxed text-ink-3">
        <Info size={12} className="mt-0.5 shrink-0" aria-hidden />
        ACK를 받은 메시지만으로 계산한 클라이언트 왕복 시간입니다. 실패 메시지는 지연을 0이나 6초로 대체하지 않고 제외합니다. 두 방식의 성공 메시지 집합이 다르므로 같은 메시지끼리의 비교가 아닙니다.
        EXIT-LINK의 긴 꼬리(p95)는 장애 직후 첫 메시지를 노드 홉 제한 {study.settings.node_hop_timeout_seconds}초 뒤 우회한 경우에서 나오며, Fixed는 그 메시지를 전달하지 못했습니다.
      </p>
    </>
  );
}

/** 06 개선이 제한적인 조건: 차이가 0%p 이거나 보정 후 유의하지 않은 조건(데이터에서 그대로 선별) */
function LimitedConditions() {
  const rows = STRATA.map((s) => ({ ...s, r: rowOf(study.by_stratum, s.scope, 'delivered')! }));
  const none = rows.filter((x) => x.r.diff_exit_minus_fixed === 0);
  const ns = rows.filter((x) => x.r.diff_exit_minus_fixed !== 0 && (x.r.sign_test_p_holm_within_metric_8_strata ?? 0) >= 0.05);
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2" data-testid="study-limited">
      {[...none.map((x) => ({ x, kind: '차이 없음' as const })), ...ns.map((x) => ({ x, kind: '보정 후 유의하지 않음' as const }))].map(({ x, kind }) => (
        <div key={x.scope} className="glass rounded-2xl p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[14.5px] text-ink">{x.label}</span>
            <span className="rounded-full border border-[#E9954A]/40 bg-[#E9954A]/[0.08] px-2 py-0.5 text-[11px] text-[#F6C79A]">{kind}</span>
          </div>
          <div className="mt-2 font-mono text-[13px] text-ink-2">
            Fixed {pct(x.r.fixed_rate)} ({x.r.fixed_success}/{x.r.fixed_n}) → EXIT-LINK {pct(x.r.exit_link_rate)} ({x.r.exit_link_success}/{x.r.exit_link_n}) · 차이 {pp(x.r.diff_exit_minus_fixed)}
          </div>
          <div className="mt-1 text-[12px] text-ink-3">
            {kind === '차이 없음'
              ? `${x.r.pairs}쌍 모두 동률(${x.r.pairs_tied}쌍) · CI ${ppRange(x.r.diff_ci_low, x.r.diff_ci_high)}${zeroWidth(x.r.diff_ci_low, x.r.diff_ci_high) ? ' (폭 0: 표본 내 변이 없음)' : ''}`
              : `부호 검정 p=${pValue(x.r.sign_test_p)} · Holm 보정 후 p=${pValue(x.r.sign_test_p_holm_within_metric_8_strata)} · CI ${ppRange(x.r.diff_ci_low, x.r.diff_ci_high)}`}
          </div>
        </div>
      ))}
    </div>
  );
}

function Caveats() {
  const items = caveatItems();
  return (
    <div className="glass rounded-2xl p-5" data-testid="study-caveats">
      <div className="mb-3 text-[13px] font-medium text-ink">해석 주의사항 · 한계 <span className="font-normal text-ink-3">— 수치를 인용할 때 함께 밝혀야 하는 조건</span></div>
      <ul className="grid grid-cols-1 gap-x-8 gap-y-2 text-[13px] leading-relaxed text-ink-2 lg:grid-cols-2">
        {items.map((t) => (
          <li key={t} className="flex gap-2.5"><span aria-hidden className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-ink-3" />{t}</li>
        ))}
      </ul>
    </div>
  );
}

type LabelProps = { x?: number | string; y?: number | string; width?: number | string; height?: number | string; value?: number | string };
const num = (v: unknown) => Number(v ?? 0);

/** 가로 막대 값 라벨: 신뢰구간 오른쪽 끝 뒤에 둡니다. */
function RightOfCi({ x, y, width, height, value, err }: LabelProps & { err: number }) {
  const v = num(value);
  const scale = v > 0 ? num(width) / v : 0;
  return (
    <text x={num(x) + num(width) + err * scale + 8} y={num(y) + num(height) / 2} dominantBaseline="central" fill={LABEL_FILL} fontSize={10}>
      {`${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}`}
    </text>
  );
}

/** 대응 쌍 차이(EXIT−Fixed)와 95% CI. 폭 0 구간은 별도 표시 */
function DifferenceChart() {
  const rows = [...STRATA.map((s) => ({ ...s, r: rowOf(study.by_stratum, s.scope, 'delivered')! })),
    { scope: 'overall', label: `전체 (${study.sample.valid_pairs}쌍)`, short: '전체', r: rowOf(study.overall, 'overall', 'delivered')! }];
  const data = rows.map((d) => ({
    ...d,
    diff: d.r.diff_exit_minus_fixed * 100,
    err: [(d.r.diff_exit_minus_fixed - d.r.diff_ci_low) * 100, (d.r.diff_ci_high - d.r.diff_exit_minus_fixed) * 100],
    zero: zeroWidth(d.r.diff_ci_low, d.r.diff_ci_high),
  }));
  return (
    <ChartCard
      title="전달 성공률 차이 (EXIT-LINK − Fixed)"
      subtitle="대응 셀 단위 평균 차이, 95% CI (paired_cell_percentile_bootstrap, 5,000회). 부호 검정 p는 층 8개에 Holm 보정"
      table={<SimpleTable head={['조건', '차이', '95% CI', '쌍 우열 E/F/동률', '부호 검정 p (Holm)']} rows={data.map((d) => [
        d.label, pp(d.r.diff_exit_minus_fixed), `${ppRange(d.r.diff_ci_low, d.r.diff_ci_high)}${d.zero ? ' · 폭 0' : ''}`,
        `${d.r.pairs_exit_better}/${d.r.pairs_fixed_better}/${d.r.pairs_tied}`,
        `${pValue(d.r.sign_test_p)}${d.r.sign_test_p_holm_within_metric_8_strata !== null ? ` (${pValue(d.r.sign_test_p_holm_within_metric_8_strata)})` : ' (전체, 보정 없음)'}`])} />}
    >
      <div style={{ height: 330 }}>
        <ResponsiveContainer>
          <BarChart data={data} layout="vertical" margin={{ top: 0, right: 56, bottom: 0, left: 0 }}>
            <CartesianGrid horizontal={false} stroke={CH.grid} />
            <XAxis type="number" {...axisProps} domain={[-10, 110]} ticks={[0, 25, 50, 75, 100]} unit="%p" />
            <YAxis type="category" dataKey="label" {...axisProps} width={150} tick={{ ...axisProps.tick, fontSize: 12, fontFamily: 'Pretendard Variable, sans-serif' }} />
            <ReferenceLine x={0} stroke="#6B727C" strokeDasharray="3 3" />
            <Tooltip cursor={{ fill: '#ffffff08' }} content={({ payload }) => {
              const d = payload?.[0]?.payload as (typeof data)[number] | undefined;
              if (!d) return null;
              return <TipBox title={d.label} rows={[
                { label: '차이', value: pp(d.r.diff_exit_minus_fixed) },
                { label: '95% CI', value: ppRange(d.r.diff_ci_low, d.r.diff_ci_high) },
                ...(d.zero ? [{ label: '주의', value: '구간 폭 0: 표본 내 변이 없음' }] : []),
                { label: '쌍 E우세/F우세/동률', value: `${d.r.pairs_exit_better}/${d.r.pairs_fixed_better}/${d.r.pairs_tied}` },
                { label: 'Holm 보정 p', value: d.r.sign_test_p_holm_within_metric_8_strata !== null ? pValue(d.r.sign_test_p_holm_within_metric_8_strata) : '해당 없음(전체)' },
              ]} />;
            }} />
            <Bar dataKey="diff" maxBarSize={14} radius={[0, 4, 4, 0]} isAnimationActive={false}>
              {data.map((d) => <Cell key={d.scope} fill={d.scope === 'overall' ? '#E8EAED' : d.diff < 0 ? M.fixed.color : CH.good} fillOpacity={d.diff === 0 ? 0.35 : 0.9} />)}
              <ErrorBar dataKey="err" direction="x" width={4} strokeWidth={1.2} stroke="#E8EAED" />
              <LabelList dataKey="diff" content={(p) => <RightOfCi {...(p as LabelProps)} err={data[Number(p.index)]?.err[1] ?? 0} />} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-1 text-2xs leading-relaxed text-ink-3">
        0%p는 차이 없음입니다. 여러 층에서 구간 폭이 0인 것은 30쌍 안에서 결과가 모두 같았다는 뜻이며, 불확실성이 없다는 뜻이 아닙니다.
      </p>
    </ChartCard>
  );
}
