import { useMemo, useState } from 'react';
import { Archive, Info } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Cell, ErrorBar, LabelList, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CH, ChartCard, SimpleTable, TipBox, axisProps } from '@/ui/charts';
import { ms } from '@/domain/format';
import { STRATA, pValue, pct, pctRange, pp, ppRange, zeroWidth } from '@/domain/study';
import { allOrNothing, fair, fairClass, fairRow, fairValid, type FairClass, type FairMethod, type FairRow } from '@/domain/fairRetry';
import { cx } from '@/ui/primitives';
import { useMediaQuery } from '@/ui/useMediaQuery';
import { Accordion, Chapter, CiBar, Def, Kpi, M, MethodCard, MiniStat, RightOfCi, nf, type LabelProps } from '@/ui/study/StudyResults';
import { fairCaveatItems } from '@/ui/study/fairRetryCaveats';

/**
 * 공정 비교 본 실험(fair_retry_v1 · RECORDED · 저장된 정적 데이터). 백엔드·WebSocket·스토어를 쓰지 않습니다.
 * 모든 수치는 domain/fairRetry(SHA-256 검증된 요약 JSON)의 값을 서식만 바꿔 표시하며 재계산하지 않습니다.
 * aligned_v3 화면(StudyResults)의 장 구조·부품·색을 그대로 씁니다. Fixed + Retry 는 Fixed 와 같은 모브색입니다.
 */
const F = {
  fixed_retry: { label: 'Fixed + Retry (고정 경로 + 재시도)', short: 'Fixed + Retry', color: M.fixed.color },
  exit_link: { label: 'EXIT-LINK (자동 재라우팅)', short: 'EXIT-LINK', color: M.exit_link.color },
} as const;
const METHODS: FairMethod[] = ['fixed_retry', 'exit_link'];
/** 방식 색(#RRGGBB)에 투명도만 더함 — 새 색을 만들지 않고 농도 단계로 구분 */
const alpha = (hex: string, a: number) => `${hex}${Math.round(a * 255).toString(16).padStart(2, '0')}`;
/** 좁은 화면에서는 조건 약칭과 좁은 축 라벨을 써서 막대 영역을 확보 */
const NARROW_AXIS = '(min-width: 640px)';
const kbs = (bps: number) => `${(bps / 1000).toLocaleString('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} KB/s`;

/** 조건별 판정 문구(변환 단계의 분류를 그대로 표시) */
function verdict(c: FairClass) {
  if (c.test === 'all_blocks_tied_no_difference') return { text: '차이 없음 · 모든 블록 동률', tone: 'muted' as const };
  if (c.significant_after_holm) return { text: 'Holm 보정 후 유의', tone: 'good' as const };
  return { text: 'Holm 보정 후 유의하지 않음', tone: 'warn' as const };
}

export function FairRetryResults() {
  if (!fairValid) {
    return (
      <section className="rounded-xl border border-fail/40 bg-panel p-4 text-xs text-ink-2" data-testid="fair-unavailable">
        공정 비교 결과 데이터의 형식이나 무결성 표시가 올바르지 않아 표시하지 않습니다. <span className="font-mono">npm run verify:fair-retry</span>로 확인하세요.
      </section>
    );
  }
  const o = fairRow('overall', 'delivered')!;
  const s = fair.settings;
  const fixedZero = zeroWidth(o.fixed_retry_ci_low, o.fixed_retry_ci_high);

  return (
    <div className="space-y-14" data-testid="fair-study">
      {/* ── Hero ── */}
      <section aria-labelledby="fair-title" className="relative overflow-hidden rounded-[30px] border border-white/[0.09] bg-gradient-to-b from-[#101a2a]/85 via-[#0b111c]/75 to-[#080c14]/70 p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_40px_80px_-40px_rgba(0,0,0,0.9)] md:p-10">
        <span aria-hidden className="pointer-events-none absolute -left-24 -top-32 h-72 w-[42rem] rounded-full bg-[radial-gradient(closest-side,rgba(111,211,255,0.14),transparent)] blur-2xl" />
        <span aria-hidden className="pointer-events-none absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-white/40 to-transparent" />
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="eyebrow">Recorded Study · {fair.protocol} · 공정 비교</div>
            <h2 id="fair-title" className="mt-4 max-w-[26ch] text-[clamp(30px,3.4vw,52px)] font-light leading-[1.05] tracking-[-0.035em] text-ink">
              재시도 예산을 맞춘 <span className="text-sheen font-normal">전달 성공률 비교</span>
            </h2>
            <p className="mt-3 max-w-[70ch] text-[14.5px] leading-relaxed text-ink-2">
              두 방식 모두 최대 {s.max_attempts}회 시도(재시도 {s.max_retries}회)와 같은 시간 예산으로 실제 TCP loopback 노드 6개에서 측정했습니다. 남은 차이는 경로 정책과 Heartbeat입니다.
              사전 등록된 분석을 SHA-256으로 검증한 저장 결과이며, 현재 운영 성능이나 실시간 값이 아닙니다.
            </p>
          </div>
          <span className="pill h-auto min-h-7 max-w-full whitespace-normal border-ice/30 bg-ice/[0.07] px-3 py-1 text-2xs text-ice" title={`분석 폴더: ${fair.provenance.analysis_dir}`} data-testid="fair-label">
            <Archive size={12} aria-hidden /> {fair.label}
          </span>
        </div>

        <div className="relative mt-8 grid grid-cols-1 gap-3 md:grid-cols-3">
          <Kpi accent={F.fixed_retry.color} label="Fixed + Retry 전달 성공률" value={pct(o.fixed_retry_rate)} n={`${o.fixed_retry_success}/${o.fixed_retry_n} 메시지`}
            sub={`95% CI ${pctRange(o.fixed_retry_ci_low, o.fixed_retry_ci_high)}${fixedZero ? ' · 폭 0(아래 설명)' : ''}`} testId="fair-kpi-fixed" />
          <Kpi accent={F.exit_link.color} label="EXIT-LINK 전달 성공률" value={pct(o.exit_link_rate)} n={`${o.exit_link_success}/${o.exit_link_n} 메시지`}
            sub={`95% CI ${pctRange(o.exit_link_ci_low, o.exit_link_ci_high)}`} testId="fair-kpi-exit" />
          <Kpi accent="#A9C7FF" diff label="차이 (EXIT − Fixed + Retry) · 1차 지표" value={pp(o.diff_exit_minus_fixed_retry, 2)} n="퍼센트포인트(%p) · 비율이 아닌 차이"
            sub={`95% CI ${ppRange(o.diff_ci_low, o.diff_ci_high)} · 층화 블록 bootstrap`} testId="fair-kpi-diff" />
        </div>
        <dl className="relative mt-4 grid grid-cols-2 gap-x-6 gap-y-3 rounded-2xl border border-white/[0.07] bg-white/[0.02] px-5 py-4 text-[13px] md:grid-cols-4" data-testid="fair-scope">
          <Def k="유효 대응 블록" v={`${fair.sample.valid_blocks}개`} sub={`셀 ${fair.sample.cells_checkpointed}/${fair.sample.cells_planned} · 제외 블록 ${fair.sample.excluded_blocks}`} />
          <Def k="방식별 메시지" v={`${o.fixed_retry_n}건`} sub="실패 포함 전체(분모)" />
          <Def k="조건" v={`${STRATA.length}개 조건`} sub={`조건당 ${s.repetitions_per_stratum}블록 · 셀당 메시지 ${s.messages_per_cell}개`} />
          <Def k="측정 · 범위" v={`${fair.measured_on} (${fair.measured_tz})`} sub="단일 PC loopback TCP · 가상 6노드" />
        </dl>
        <p className="relative mt-3 text-[12px] text-ink-3">
          블록 = 같은 조건·타이밍·반복 번호의 두 방식 셀 한 쌍입니다. 성공률 분모는 실패 메시지를 포함한 전체 메시지입니다. 메시지 단위 Wilson 구간은 같은 셀의 메시지가 독립이 아니어서 보고하지 않습니다.
        </p>
      </section>

      {/* ── 01 비교 조건 ── */}
      <Chapter no="01" title="무엇을 비교했나" kicker="Same budget · Methods">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.1fr_1fr_1fr]">
          <div className="glass rounded-2xl p-5">
            <div className="text-[12px] font-medium uppercase tracking-[0.14em] text-ink-3">두 방식에 같은 예산</div>
            <ul className="mt-2 space-y-1.5 text-[13.5px] text-ink-2" data-testid="fair-budget">
              <li>최대 {s.max_attempts}회 시도 = 최초 전송 + 재시도 {s.max_retries}회 · 재시도 위치 {s.retry_location} · 간격 {s.retry_backoff_seconds}초</li>
              <li>홉 타임아웃 {s.node_hop_timeout_seconds}초 · 클라이언트 마감 {s.client_timeout_seconds}초 · 관측 창 {s.observation_window_seconds}초 · TTL {s.ttl}</li>
              <li>장애 주입·재시작·전송 시각은 두 방식 동일(같은 시간표)</li>
            </ul>
          </div>
          <MethodCard color={F.fixed_retry.color} name="Fixed + Retry" sub="고정 경로 + 재시도" items={[`항상 ${s.fixed_retry_route} 경로로 전송`, `실패하면 같은 경로로 최대 ${s.max_retries}회 재시도`, 'Heartbeat 없음(이웃 장애 감지 없음)']} />
          <MethodCard color={F.exit_link.color} name="EXIT-LINK" sub="자동 재라우팅" items={[`Heartbeat로 이웃 장애 감지(probe ${s.exit_link_probe_interval_seconds}s · 실패 ${s.exit_link_failure_threshold}회)`, '장애 링크를 뺀 대체 경로로 재시도', `경로가 없으면 전송하지 않고 no_route로 종료`]} />
        </div>
      </Chapter>

      {/* ── 02 전체 ── */}
      <Chapter no="02" title="전체 전달 성공률" kicker="Primary">
        <FairOverall r={o} />
      </Chapter>

      {/* ── 03 조건별 ── */}
      <Chapter no="03" title="장애 조건별 결과" kicker="By condition">
        <div className="grid grid-cols-1 gap-4 2xl:grid-cols-2">
          <FairStratumRates />
          <FairDifferenceChart />
        </div>
      </Chapter>

      {/* ── 04 시도 횟수 ── */}
      <Chapter no="04" title="메시지당 시도 횟수" kicker="Attempts">
        <AttemptsChart />
      </Chapter>

      {/* ── 05 지연 · 제어 트래픽 ── */}
      <Chapter no="05" title="ACK 지연 · Heartbeat 제어 트래픽" kicker="Costs">
        <div className="grid grid-cols-1 gap-4 2xl:grid-cols-2">
          <AckLatency />
          <ControlOverhead />
        </div>
      </Chapter>

      {/* ── 06 해석 범위 ── */}
      <Chapter no="06" title="해석할 수 있는 범위" kicker="Scope · Caveats">
        <div className="glass rounded-2xl p-5" data-testid="fair-caveats">
          <div className="mb-3 text-[13px] font-medium text-ink">해석 주의사항 · 한계 <span className="font-normal text-ink-3">— 수치를 인용할 때 함께 밝혀야 하는 조건</span></div>
          <ul className="grid grid-cols-1 gap-x-8 gap-y-2 text-[13px] leading-relaxed text-ink-2 lg:grid-cols-2">
            {fairCaveatItems().map((t) => (
              <li key={t} className="flex gap-2.5"><span aria-hidden className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-ink-3" />{t}</li>
            ))}
          </ul>
        </div>
        <div className="mt-4 space-y-3">
          <Accordion title={`표본 · 제외 · 계획 ${fair.sample.cells_planned}셀 → 완료 ${fair.sample.cells_checkpointed}셀 → 유효 블록 ${fair.sample.valid_blocks}개 · 제외 ${fair.sample.excluded_blocks}`} testId="fair-acc-sample">
            {fair.exclusions.length
              ? <div className="overflow-x-auto"><SimpleTable head={['조건', '타이밍', '반복', '사유']} rows={fair.exclusions.map((e) => [String(e.condition), String(e.fault_timing), String(e.repetition), String(e.reason)])} /></div>
              : <p className="text-2xs text-ink-3">제외된 블록이 없습니다(감사 기록에 따른 제외 {fair.sample.audited_exclusions}건). 시각 위반·정리 실패·중단 셀이 없었습니다.</p>}
            <div className="mt-3 text-2xs text-ink-3">조건별 유효 블록</div>
            <div className="mt-1 grid grid-cols-1 gap-x-4 gap-y-0.5 text-2xs sm:grid-cols-2 lg:grid-cols-4">
              {STRATA.map((x) => (
                <div key={x.scope} className="flex justify-between gap-2 border-b border-white/[0.06] py-1">
                  <span className="text-ink-3">{x.label}</span>
                  <span className="font-mono text-ink-2">{fairRow(x.scope, 'delivered')?.blocks ?? '—'}</span>
                </div>
              ))}
            </div>
          </Accordion>
          <Accordion title="출처 · SHA-256 검증" testId="fair-acc-provenance">
            <div className="space-y-1 text-2xs leading-relaxed text-ink-3" data-testid="fair-provenance">
              <div>분석 폴더: <span className="font-mono text-ink-2">{fair.provenance.analysis_dir}</span> · 실행 <span className="font-mono text-ink-2">{fair.run_label}</span> · seed {fair.provenance.seed} · {fair.use}</div>
              <div>검증: 아래 파일의 SHA-256 = {fair.provenance.sums_file} 기록 → <span className="text-ink-2">{fair.provenance.hash_check}</span> · 변환 <span className="font-mono">{fair.provenance.generator}</span> · {fair.provenance.generated_at}</div>
              <div>{fair.provenance.sums_file}: <span className="break-all font-mono">{fair.provenance.sums_file_sha256}</span></div>
              <ul className="mt-1 space-y-0.5 font-mono">
                {Object.entries(fair.provenance.files).map(([f, h]) => (
                  <li key={f} className="break-all"><span className="text-ink-2">{f}</span> {h}</li>
                ))}
              </ul>
              <div className="pt-1">사전 등록 설계 해시(plan_design_sha256): <span className="break-all font-mono">{fair.provenance.plan_design_sha256}</span> · 설정 출처 {s.source}</div>
              <div>공개 범위: 요약 통계만 포함합니다. 480셀 원본 기록과 노드 로그는 공개하지 않으며, 로컬 절대경로 등 {fair.provenance.removed_fields.length}개 항목을 변환 때 제거했습니다.</div>
            </div>
          </Accordion>
        </div>
      </Chapter>
    </div>
  );
}

/** 02 전체 비교 */
function FairOverall({ r }: { r: FairRow }) {
  const ack = fairRow('overall', 'ack_6s')!;
  const ackClass = fairClass('overall', 'ack_6s')!;
  const zero = STRATA.every((x) => allOrNothing(fairRow(x.scope, 'delivered')!.fixed_retry_rate)) && zeroWidth(r.fixed_retry_ci_low, r.fixed_retry_ci_high);
  return (
    <div className="glass rounded-[24px] p-6 md:p-8" data-testid="fair-overall">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <div className="text-[16px] font-medium text-ink">메시지 전달 성공률 (delivered) · 사전 등록 1차 지표</div>
          <div className="mt-0.5 text-[12.5px] text-ink-3">방식별 {r.fixed_retry_n}건 · {r.blocks} 대응 블록 · 가로선 = 95% CI(층화 블록 bootstrap {r.bootstrap_draws.toLocaleString('en-US')}회)</div>
        </div>
        <div className="text-right">
          <div className="font-mono text-[clamp(28px,2.6vw,40px)] text-[#CFE0FF]" data-testid="fair-overall-diff">{pp(r.diff_exit_minus_fixed_retry, 2)}</div>
          <div className="text-[11.5px] text-ink-3">차이 95% CI {ppRange(r.diff_ci_low, r.diff_ci_high)}</div>
        </div>
      </div>
      <div className="mt-7 space-y-6">
        {METHODS.map((m) => {
          const rate = m === 'fixed_retry' ? r.fixed_retry_rate : r.exit_link_rate;
          const lo = m === 'fixed_retry' ? r.fixed_retry_ci_low : r.exit_link_ci_low;
          const hi = m === 'fixed_retry' ? r.fixed_retry_ci_high : r.exit_link_ci_high;
          const n = m === 'fixed_retry' ? `${r.fixed_retry_success}/${r.fixed_retry_n}` : `${r.exit_link_success}/${r.exit_link_n}`;
          return (
            <div key={m}>
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="flex items-center gap-2 text-[14px] text-ink"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: F[m].color }} />{F[m].label}</span>
                <span className="font-mono text-[22px] text-ink">{pct(rate)} <span className="text-[12.5px] text-ink-3">{n} · CI {pctRange(lo, hi)}</span></span>
              </div>
              <CiBar rate={rate} lo={lo} hi={hi} color={F[m].color} label={F[m].short} n={n} big />
            </div>
          );
        })}
        <div className="flex justify-between font-mono text-[11px] text-ink-3" aria-hidden>{[0, 25, 50, 75, 100].map((x) => <span key={x}>{x}%</span>)}</div>
      </div>
      <div className="mt-6 grid grid-cols-1 gap-3 border-t border-white/[0.06] pt-5 text-[13px] text-ink-2 md:grid-cols-3">
        <div>블록 우열 <span className="font-mono text-ink">EXIT-LINK {r.blocks_exit_better} · Fixed + Retry {r.blocks_fixed_retry_better} · 동률 {r.blocks_tied}</span></div>
        <div>부호 검정 p <span className="font-mono text-ink" data-testid="fair-primary-p">{pValue(r.sign_test_p)}</span> <span className="text-ink-3">(사전 등록 단일 1차 검정, 보정 없음)</span></div>
        <div data-testid="fair-ack6">
          6초 이내 ACK <span className="font-mono text-ink">{pct(ack.fixed_retry_rate)} → {pct(ack.exit_link_rate)}</span>{' '}
          <span className="text-ink-3">보조 지표{ackClass.same_as_delivered ? ' · delivered와 같은 값' : ''} · 별도 검정 아님</span>
        </div>
      </div>
      {zero && (
        <p className="mt-4 flex gap-1.5 text-2xs leading-relaxed text-ink-3" data-testid="fair-zero-width">
          <Info size={12} className="mt-0.5 shrink-0" aria-hidden />
          Fixed + Retry의 95% CI 폭이 0인 이유: {STRATA.length}개 조건 각각에서 모든 블록이 성공하거나 모두 실패했습니다(조건별 성공률 0% 또는 100%). 층화 bootstrap은 조건 안에서만 블록을 다시 뽑으므로 평균이 바뀌지 않습니다. 표본 안에 변이가 없었다는 뜻이며 불확실성이 없다는 뜻이 아닙니다.
        </p>
      )}
    </div>
  );
}

/** 03 조건별 성공률 */
function FairStratumRates() {
  const [order, setOrder] = useState<'default' | 'diff'>('default');
  const data = useMemo(() => {
    const rows = STRATA.map((x) => ({ ...x, r: fairRow(x.scope, 'delivered')!, c: fairClass(x.scope, 'delivered')! }));
    return order === 'diff' ? [...rows].sort((a, b) => b.r.diff_exit_minus_fixed_retry - a.r.diff_exit_minus_fixed_retry) : rows;
  }, [order]);
  return (
    <ChartCard
      title="장애 조건별 전달 성공률"
      subtitle="조건마다 Fixed + Retry · EXIT-LINK 를 나란히 표시. 가로선 = 조건 안 블록 bootstrap 95% CI. 오른쪽 = 차이(%p)"
      table={<SimpleTable head={['조건', 'Fixed + Retry', 'EXIT-LINK', '블록']} rows={data.map((d) => [d.label,
        `${pct(d.r.fixed_retry_rate)} (${d.r.fixed_retry_success}/${d.r.fixed_retry_n})`, `${pct(d.r.exit_link_rate)} (${d.r.exit_link_success}/${d.r.exit_link_n})`, d.r.blocks])} />}
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <span className="text-[12px] text-ink-3">지표: 전달 성공(delivered). 6초 이내 ACK는 보조 지표{fair.ack_6s_equals_delivered_everywhere ? '이며 모든 조건에서 같은 값' : ''}입니다.</span>
        <div role="tablist" aria-label="정렬" className="seg">
          {([['default', '조건 순서'], ['diff', '차이 큰 순']] as const).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={order === k} onClick={() => setOrder(k)} data-testid={`fair-sort-${k}`}>{l}</button>
          ))}
        </div>
      </div>
      <ul className="space-y-3.5" data-testid="fair-strata-rows">
        {data.map((d) => (
          <li key={d.scope} className="grid grid-cols-[1fr_64px] items-center gap-x-3 gap-y-1.5 sm:grid-cols-[minmax(120px,170px)_1fr_64px]" data-scope={d.scope}>
            <div className="col-span-2 min-w-0 sm:col-span-1">
              <div className="text-[13px] text-ink">{d.label}</div>
              <div className="font-mono text-[10.5px] text-ink-3">{d.r.blocks}블록 · 방식별 {d.r.fixed_retry_n}건</div>
            </div>
            <div className="space-y-1.5">
              {METHODS.map((m) => {
                const rate = m === 'fixed_retry' ? d.r.fixed_retry_rate : d.r.exit_link_rate;
                const n = m === 'fixed_retry' ? `${d.r.fixed_retry_success}/${d.r.fixed_retry_n}` : `${d.r.exit_link_success}/${d.r.exit_link_n}`;
                return (
                  <div key={m} className="grid grid-cols-[1fr_92px] items-center gap-2">
                    <CiBar rate={rate} lo={m === 'fixed_retry' ? d.r.fixed_retry_ci_low : d.r.exit_link_ci_low} hi={m === 'fixed_retry' ? d.r.fixed_retry_ci_high : d.r.exit_link_ci_high} color={F[m].color} label={F[m].short} n={n} />
                    <span className="font-mono text-[11.5px] text-ink-2">{pct(rate)} <span className="text-ink-3">{n}</span></span>
                  </div>
                );
              })}
            </div>
            <div className={cx('text-right font-mono text-[13px]', d.r.diff_exit_minus_fixed_retry > 0 ? 'text-[#CFE0FF]' : d.r.diff_exit_minus_fixed_retry < 0 ? 'text-[#E6A3C4]' : 'text-ink-3')}>{pp(d.r.diff_exit_minus_fixed_retry)}</div>
          </li>
        ))}
      </ul>
      <div className="mt-4 flex flex-wrap items-center gap-4 text-[11.5px] text-ink-3">
        {METHODS.map((m) => <span key={m} className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: F[m].color }} />{F[m].label}</span>)}
        <span>막대에 마우스를 올리거나 포커스하면 소수점 둘째 자리 값과 CI 를 표시합니다.</span>
      </div>
    </ChartCard>
  );
}

/** 03 조건별 차이 + 95% CI + Holm 판정 */
function FairDifferenceChart() {
  const rows = [...STRATA.map((x) => ({ ...x, r: fairRow(x.scope, 'delivered')!, c: fairClass(x.scope, 'delivered')! })),
    { scope: 'overall', label: `전체 (${fair.sample.valid_blocks}블록)`, short: '전체', r: fairRow('overall', 'delivered')!, c: fairClass('overall', 'delivered')! }];
  const data = rows.map((d) => ({
    ...d,
    diff: d.r.diff_exit_minus_fixed_retry * 100,
    err: [(d.r.diff_exit_minus_fixed_retry - d.r.diff_ci_low) * 100, (d.r.diff_ci_high - d.r.diff_exit_minus_fixed_retry) * 100],
    zero: zeroWidth(d.r.diff_ci_low, d.r.diff_ci_high),
    axis: d.short,
  }));
  const wide = useMediaQuery(NARROW_AXIS);
  const judge = (d: (typeof data)[number]) => (d.scope === 'overall' ? '1차 검정(보정 없음)' : verdict(d.c).text);
  const notSig = data.filter((d) => d.c.significant_after_holm === false);
  return (
    <ChartCard
      title="전달 성공률 차이 (EXIT-LINK − Fixed + Retry)"
      subtitle="블록 단위 평균 차이, 95% CI (층화 블록 bootstrap). 조건별 부호 검정 p는 8개 조건에 Holm 보정"
      table={<SimpleTable head={['조건', '차이', '95% CI', '블록 E/F/동률', '부호 검정 p (Holm)', '판정']} rows={data.map((d) => [
        d.label, pp(d.r.diff_exit_minus_fixed_retry), `${ppRange(d.r.diff_ci_low, d.r.diff_ci_high)}${d.zero ? ' · 폭 0' : ''}`,
        `${d.r.blocks_exit_better}/${d.r.blocks_fixed_retry_better}/${d.r.blocks_tied}`,
        `${pValue(d.r.sign_test_p)}${d.c.holm_p !== null ? ` (${pValue(d.c.holm_p)})` : ' (보정 없음)'}`, judge(d)])} />}
    >
      <div style={{ height: 330 }}>
        <ResponsiveContainer>
          <BarChart data={data} layout="vertical" margin={{ top: 0, right: 56, bottom: 0, left: 0 }}>
            <CartesianGrid horizontal={false} stroke={CH.grid} />
            <XAxis type="number" {...axisProps} domain={[-10, 110]} ticks={[0, 25, 50, 75, 100]} unit="%p" />
            <YAxis type="category" dataKey={wide ? 'label' : 'axis'} {...axisProps} width={wide ? 150 : 72} tick={{ ...axisProps.tick, fontSize: wide ? 12 : 11, fontFamily: 'Pretendard Variable, sans-serif' }} />
            <ReferenceLine x={0} stroke="#6B727C" strokeDasharray="3 3" />
            <Tooltip cursor={{ fill: '#ffffff08' }} content={({ payload }) => {
              const d = payload?.[0]?.payload as (typeof data)[number] | undefined;
              if (!d) return null;
              return <TipBox title={d.label} rows={[
                { label: '차이', value: pp(d.r.diff_exit_minus_fixed_retry) },
                { label: '95% CI', value: ppRange(d.r.diff_ci_low, d.r.diff_ci_high) },
                ...(d.zero ? [{ label: '주의', value: '구간 폭 0: 표본 내 변이 없음' }] : []),
                { label: '블록 E우세/F우세/동률', value: `${d.r.blocks_exit_better}/${d.r.blocks_fixed_retry_better}/${d.r.blocks_tied}` },
                { label: d.scope === 'overall' ? '부호 검정 p' : 'Holm 보정 p', value: d.scope === 'overall' ? pValue(d.r.sign_test_p) : pValue(d.c.holm_p) },
                { label: '판정', value: judge(d) },
              ]} />;
            }} />
            <Bar dataKey="diff" maxBarSize={14} radius={[0, 4, 4, 0]} isAnimationActive={false}>
              {data.map((d) => <Cell key={d.scope} fill={d.scope === 'overall' ? '#E8EAED' : d.diff < 0 ? F.fixed_retry.color : CH.good} fillOpacity={d.diff === 0 ? 0.35 : d.c.significant_after_holm === false ? 0.5 : 0.9} />)}
              <ErrorBar dataKey="err" direction="x" width={4} strokeWidth={1.2} stroke="#E8EAED" />
              <LabelList dataKey="diff" content={(p) => <RightOfCi {...(p as LabelProps)} err={data[Number(p.index)]?.err[1] ?? 0} />} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <ul className="mt-2 space-y-1 text-2xs leading-relaxed text-ink-3" data-testid="fair-significance">
        {notSig.map((d) => (
          <li key={d.scope} className="flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-[#E9954A]/40 bg-[#E9954A]/[0.08] px-2 py-0.5 text-[11px] text-[#F6C79A]">Holm 보정 후 유의하지 않음</span>
            <span>{d.label}: 차이 {pp(d.r.diff_exit_minus_fixed_retry)}, 보정 전 p={pValue(d.r.sign_test_p)} → Holm 보정 후 p={pValue(d.c.holm_p)}. 막대를 흐리게 표시했습니다.</span>
          </li>
        ))}
        <li>0%p는 차이 없음입니다. 모든 블록이 동률인 조건은 검정할 차이가 없어 “차이 없음”으로 표시합니다. 구간 폭 0은 표본 안에서 결과가 모두 같았다는 뜻이며 불확실성이 없다는 뜻이 아닙니다.</li>
      </ul>
    </ChartCard>
  );
}

/** 04 시도 횟수 분포: 방식별 100% 누적 막대(색은 방식 색의 농도 단계) */
function AttemptsChart() {
  const keys = [...new Set(METHODS.flatMap((m) => Object.keys(fair.attempts_per_message[m].distribution)))].sort((a, b) => Number(a) - Number(b));
  const maxKey = Math.max(...keys.map(Number));
  const name = (k: string) => (k === '0' ? '0회(경로 없음, 전송 안 함)' : `${k}회`);
  return (
    <ChartCard
      title="메시지당 전송 시도 횟수"
      subtitle={`출발 노드 N1의 delivery_result 로그로 집계(route_* 이벤트와 대조). 최대 ${fair.settings.max_attempts}회 = 최초 + 재시도 ${fair.settings.max_retries}회`}
      table={<SimpleTable head={['방식', ...keys.map(name), '확인/전체', '6초 마감 이후 종료']} rows={METHODS.map((m) => {
        const a = fair.attempts_per_message[m];
        return [F[m].short, ...keys.map((k) => a.distribution[k] ?? 0), `${a.confirmed}/${a.messages}`, a.client_deadline_missed];
      })} />}
    >
      <div className="space-y-5" data-testid="fair-attempts">
        {METHODS.map((m) => {
          const a = fair.attempts_per_message[m];
          return (
            <div key={m}>
              <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3 text-[13px]">
                <span className="flex items-center gap-2 text-ink"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: F[m].color }} />{F[m].label}</span>
                <span className="font-mono text-[11.5px] text-ink-3">N1 로그 확인 {a.confirmed}/{a.messages}</span>
              </div>
              <div className="flex h-8 overflow-hidden rounded-lg bg-white/[0.05]" role="img" aria-label={`${F[m].short} 시도 횟수 분포: ${keys.filter((k) => a.distribution[k]).map((k) => `${name(k)} ${a.distribution[k]}건`).join(', ')}`}>
                {keys.filter((k) => a.distribution[k]).map((k) => {
                  const n = a.distribution[k];
                  const share = n / a.messages;
                  return (
                    <div key={k} className="flex items-center justify-center overflow-hidden whitespace-nowrap border-r border-[#0D131D] font-mono text-[11px] text-ink last:border-r-0"
                      style={{ width: `${share * 100}%`, background: alpha(F[m].color, 0.3 + 0.7 * (Number(k) / maxKey)) }} title={`${name(k)} · ${n}건 · ${pct(share)}`}>
                      {share >= 0.07 ? `${k}회 ${n}` : ''}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
        <div className="flex justify-between font-mono text-[11px] text-ink-3" aria-hidden>{[0, 25, 50, 75, 100].map((x) => <span key={x}>{x}%</span>)}</div>
      </div>
      <p className="mt-3 flex gap-1.5 text-2xs leading-relaxed text-ink-3">
        <Info size={12} className="mt-0.5 shrink-0" aria-hidden />
        진할수록 시도가 많습니다. Fixed + Retry는 장애 노드를 지나는 같은 경로로 재시도하므로 실패 메시지가 최대 시도까지 갑니다. 그중 {fair.attempts_per_message.fixed_retry.client_deadline_missed}건은 마지막 시도가 {fair.settings.client_timeout_seconds}초 클라이언트 마감 뒤에 끝나, 시도 횟수를 클라이언트 응답이 아니라 N1 로그로 셌습니다.
        EXIT-LINK의 0회는 살아 있는 경로가 없어 전송하지 않고 no_route로 끝난 메시지입니다.
      </p>
    </ChartCard>
  );
}

/** 05 ACK 지연(조건부) */
function AckLatency() {
  const fixedOk = STRATA.filter((x) => (fairRow(x.scope, 'delivered')?.fixed_retry_success ?? 0) > 0).map((x) => x.label);
  return (
    <ChartCard title="ACK 지연 (조건부 지표)" subtitle="ACK를 받은 메시지만으로 계산한 클라이언트 왕복 시간 · 실패 메시지는 제외하며 대체값 없음">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid="fair-latency">
        {METHODS.map((m) => {
          const l = fair.ack_latency[m];
          return <MiniStat key={m} label={`${F[m].short} · 중앙값 / p95`} value={l.median_ms !== null ? `${ms(l.median_ms)} / ${ms(l.p95_ms)}` : '계산 불가'} sub={`ACK ${l.ack_n}/${l.total_n} 메시지에서 계산`} />;
        })}
      </div>
      <p className="mt-3 flex gap-1.5 text-2xs leading-relaxed text-ink-3">
        <Info size={12} className="mt-0.5 shrink-0" aria-hidden />
        성공 메시지에 한정된 값입니다. Fixed + Retry의 성공은 {fixedOk.join(', ')} 조건에서만 나왔고, EXIT-LINK의 성공에는 장애를 우회한 메시지가 포함됩니다. 두 집합이 달라 지연을 같은 메시지끼리 비교한 값이 아니며, 우열 판단에 쓰지 않습니다. 조건별 지연은 분석 산출물에 없어 표시하지 않습니다.
      </p>
    </ChartCard>
  );
}

/** 05 Heartbeat 제어 트래픽(애플리케이션 프레임 기준) */
function ControlOverhead() {
  const exit = fair.control_overhead.exit_link.by_stratum_mean;
  const fixed = fair.control_overhead.fixed_retry.by_stratum_mean;
  const fixedAllZero = Object.values(fixed).every((v) => v === 0);
  const wide = useMediaQuery(NARROW_AXIS);
  const data = STRATA.map((x) => ({ label: x.label, axis: x.short, scope: x.scope, kb: exit[x.scope] / 1000, bps: exit[x.scope] }));
  return (
    <ChartCard
      title="Heartbeat 제어 트래픽 · EXIT-LINK"
      subtitle={`조건별 셀 평균. Heartbeat + HeartbeatReply 애플리케이션 프레임 바이트 ÷ 관측 창 ${fair.settings.observation_window_seconds}초`}
      table={<SimpleTable head={['조건', 'EXIT-LINK', 'Fixed + Retry']} rows={STRATA.map((x) => [x.label, `${kbs(exit[x.scope])} (${nf(exit[x.scope])} B/s)`, `${nf(fixed[x.scope])} B/s`])} />}
    >
      <div style={{ height: 300 }} data-testid="fair-overhead">
        <ResponsiveContainer>
          <BarChart data={data} layout="vertical" margin={{ top: 0, right: 64, bottom: 0, left: 0 }}>
            <CartesianGrid horizontal={false} stroke={CH.grid} />
            <XAxis type="number" {...axisProps} unit={wide ? ' KB/s' : ''} />
            <YAxis type="category" dataKey={wide ? 'label' : 'axis'} {...axisProps} width={wide ? 150 : 72} tick={{ ...axisProps.tick, fontSize: wide ? 12 : 11, fontFamily: 'Pretendard Variable, sans-serif' }} />
            <Tooltip cursor={{ fill: '#ffffff08' }} content={({ payload }) => {
              const d = payload?.[0]?.payload as (typeof data)[number] | undefined;
              return d ? <TipBox title={d.label} rows={[{ label: 'EXIT-LINK', value: `${kbs(d.bps)} (${nf(d.bps)} B/s)`, color: F.exit_link.color }, { label: 'Fixed + Retry', value: `${nf(fixed[d.scope])} B/s` }]} /> : null;
            }} />
            <Bar dataKey="kb" fill={F.exit_link.color} fillOpacity={0.9} maxBarSize={14} radius={[0, 4, 4, 0]} isAnimationActive={false}>
              <LabelList dataKey="kb" position="right" fill="#A3A9B1" fontSize={10} formatter={(v: number) => v.toFixed(1)} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-2 flex gap-1.5 text-2xs leading-relaxed text-ink-3">
        <Info size={12} className="mt-0.5 shrink-0" aria-hidden />
        {fixedAllZero ? 'Fixed + Retry는 Heartbeat를 실행하지 않아 모든 조건에서 0 B/s입니다. ' : ''}
        애플리케이션 프레임(4바이트 길이 + JSON) 기준이며 TCP/IP 헤더·연결 수립·데이터 프레임·계측 로그는 포함하지 않습니다. 정지한 노드가 많을수록 Heartbeat를 보내는 노드가 줄어 값이 낮아집니다. 단일 PC loopback에서 측정한 값입니다.
      </p>
    </ChartCard>
  );
}
