/**
 * fair_retry_v1 본 실험 분석 폴더(읽기 전용) → 웹 화면용 공개 요약 객체.
 * import-fair-retry.ts 와 verify-fair-retry.ts 가 함께 씁니다.
 *  - 분석 폴더에는 아무것도 쓰지 않습니다(readFileSync 만 사용, study-source.ts 의 해시 확인 함수 재사용).
 *  - 사용하는 3개 파일은 모두 OUTPUT_SHA256SUMS.txt 의 SHA-256 과 같아야 합니다.
 *  - 값은 계산·반올림·보정 없이 형만 바꿔 옮깁니다. 화면 분류(classification)만 규칙으로 덧붙입니다.
 *  - 공개하지 않는 값: summary.run(PC 절대경로), run_id. 결과에 경로·사용자명·토큰 문자열이 없어야 합니다.
 */
import { basename, resolve } from 'node:path';
import { FRONTEND, SUMS_FILE, parseCsv, readSums, readVerified, type Row } from './study-source';

export const FAIR_OUT_FILE = resolve(FRONTEND, 'src', 'data', 'study', 'fair-retry-v1-study.json');
export const FAIR_FILES = { summary: 'summary.json', stats: 'stats.csv', exclusions: 'exclusions.csv' } as const;
export const FAIR_SCHEMA = 'exit-link-fair-retry-study-v1';
export const FAIR_LABEL = '저장된 실험 결과 · fair_retry_v1 · 2026-11-16 측정(KST) · 실시간 아님';

/** 사전 등록 설정(research/fair-fixed-retry 의 docs/fair-retry-main-study-design.md §3·§6). 분석 출력에는 없으므로 출처와 함께 고정합니다. */
export const FAIR_SETTINGS = {
  source: 'docs/fair-retry-main-study-design.md (branch research/fair-fixed-retry)',
  max_retries: 3,
  max_attempts: 4,
  retry_location: 'N1',
  retry_backoff_seconds: 0,
  node_hop_timeout_seconds: 1.5,
  client_timeout_seconds: 6,
  observation_window_seconds: 9,
  ttl: 16,
  messages_per_cell: 3,
  repetitions_per_stratum: 30,
  fixed_retry_route: 'N1→N2→N4',
  exit_link_probe_interval_seconds: 0.1,
  exit_link_failure_threshold: 2,
  bootstrap: 'stratified block percentile bootstrap, 10,000 draws',
} as const;

const STRATA = [
  'normal/none', 'single_failure/before_send', 'single_failure/inflight', 'sequential_failures/before_send',
  'sequential_failures/inflight', 'restart/before_send', 'restart/inflight', 'no_route/before_send',
];

/** 공개 JSON 에 있으면 안 되는 문자열(개인 경로·사용자명·토큰) */
export const FORBIDDEN = [/[A-Za-z]:\\/, /[A-Za-z]:\//, /\\Users\\/i, /\/Users\//, /\/home\//, /\/mnt\//, /Documents/i, /\bUser\b/, /token/i, /secret/i, /password/i, /run_id/];

export class FairStop extends Error {}
const need = (ok: unknown, msg: string) => { if (!ok) throw new FairStop(msg); };

export function buildFairStudy(dir: string, generatedAt: string) {
  const { sums, sumsSha256 } = readSums(dir);
  need(Object.keys(sums).sort().join('|') === Object.values(FAIR_FILES).sort().join('|'), `${SUMS_FILE} 목록이 예상(3개 파일)과 다릅니다: ${Object.keys(sums).join(', ')}`);
  const files: Record<string, string> = {};
  const read = (name: string) => { const f = readVerified(dir, name, sums); files[name] = f.sha256; return f.text; };
  const summary = JSON.parse(read(FAIR_FILES.summary)) as Record<string, any>;
  const stats = parseCsv(read(FAIR_FILES.stats));
  const exclusions = parseCsv(read(FAIR_FILES.exclusions));

  // ── 실행 단위 조건
  need(summary.protocol === 'fair_retry_v1', `protocol=${summary.protocol}`);
  need(summary.stage === 'main' && /^MAIN/.test(summary.use), `stage=${summary.stage}, use=${summary.use}`);
  need(summary.seed === 20261117, `seed=${summary.seed}`);
  need(summary.cells_planned === 480 && summary.cells_checkpointed === summary.cells_planned, `셀 ${summary.cells_checkpointed}/${summary.cells_planned}`);
  need(summary.valid_blocks + summary.excluded_blocks === summary.planned_blocks, '블록 수 합계 불일치');
  need(exclusions.length === summary.excluded_blocks, `exclusions.csv ${exclusions.length}행 ≠ excluded_blocks ${summary.excluded_blocks}`);
  const runName = basename(String(summary.run).replaceAll('\\', '/'));
  need(/^main-[0-9a-f]{8}$/.test(runName), `실행 폴더 이름 형식: ${runName}`);

  // ── 표 구조와 합계
  const row = (scope: string, metric: string) => stats.find((r) => r.scope === scope && r.metric === metric);
  const overall = row('overall', 'delivered')!;
  need(overall && overall.role === 'primary' && stats.filter((r) => r.role === 'primary').length === 1, '1차 행(overall/delivered, role=primary)이 하나여야 합니다');
  need(stats.length === 2 + STRATA.length * 2, `stats.csv 행 수 ${stats.length}`);
  for (const m of ['delivered', 'ack_6s']) {
    const parts = STRATA.map((s) => row(s, m));
    need(parts.every(Boolean), `${m}: 조건 행 누락`);
    const total = row('overall', m)!;
    for (const k of ['blocks', 'fixed_retry_success', 'fixed_retry_n', 'exit_link_success', 'exit_link_n']) {
      need(parts.reduce((s, r) => s + Number(r![k]), 0) === total[k], `${m}: 조건별 ${k} 합 ≠ 전체`);
    }
  }
  need(overall.blocks === summary.valid_blocks, '전체 블록 수 ≠ valid_blocks');
  const p = summary.primary;
  need(p.metric === 'delivered' && p.scope === 'overall' && Object.is(p.estimate, overall.diff_exit_minus_fixed_retry)
    && Object.is(p.ci_low, overall.diff_ci_low) && Object.is(p.ci_high, overall.diff_ci_high) && Object.is(p.sign_test_p, overall.sign_test_p), 'summary.primary ≠ stats.csv 1차 행');

  // ── 시도 횟수·ACK
  for (const [method, successKey] of [['fixed_retry', 'fixed_retry_success'], ['exit_link', 'exit_link_success']] as const) {
    const a = summary.attempts_per_message[method];
    const sum = Object.values(a.distribution as Record<string, number>).reduce((s, v) => s + v, 0);
    need(sum === a.messages && a.confirmed === a.messages && a.unconfirmed === 0, `${method}: 시도 분포 합 ${sum}, 확인 ${a.confirmed}/${a.messages}`);
    need(a.messages === overall[method === 'fixed_retry' ? 'fixed_retry_n' : 'exit_link_n'], `${method}: 메시지 수 ≠ 분모`);
    need(summary.ack_latency[method].ack_n === overall[successKey] && summary.ack_latency[method].total_n === a.messages, `${method}: ACK 수 ≠ 전달 성공 수`);
    need(Object.keys(summary.control_overhead[method].by_stratum_mean).sort().join('|') === [...STRATA].sort().join('|'), `${method}: 제어 트래픽 조건 목록`);
  }

  // ── 화면 분류(원본 라벨은 stats 에 그대로 두고, 화면은 이 분류만 씀)
  //  delivered/overall = 사전 등록 1차 검정(보정 없음) · delivered/조건 = 2차, Holm(8개 조건)
  //  ack_6s = 보조 지표. 원본 행의 multiplicity·Holm 문자열이 1차 행에서 물려받은 값이므로 화면에서 검정으로 표시하지 않음
  const sameAsDelivered = (s: string) => {
    const a = row(s, 'ack_6s')!, d = row(s, 'delivered')!;
    return ['fixed_retry_success', 'fixed_retry_n', 'exit_link_success', 'exit_link_n', 'diff_ci_low', 'diff_ci_high'].every((k) => Object.is(a[k], d[k]));
  };
  const classification = stats.map((r) => {
    const s = String(r.scope);
    if (r.metric === 'delivered' && s === 'overall') return { scope: s, metric: 'delivered', display_role: 'primary', test: 'single_preregistered_primary_unadjusted', holm_p: null, significant_after_holm: null };
    if (r.metric === 'delivered') {
      need(r.role === 'secondary_stratum' && r.multiplicity === 'holm_over_8_strata' && typeof r.sign_test_p_holm === 'number', `${s}: 조건 행 라벨`);
      const tied = r.blocks_exit_better === 0 && r.blocks_fixed_retry_better === 0;
      return { scope: s, metric: 'delivered', display_role: 'secondary_stratum', test: tied ? 'all_blocks_tied_no_difference' : 'sign_test_holm_8_strata',
        holm_p: r.sign_test_p_holm as number, significant_after_holm: tied ? null : (r.sign_test_p_holm as number) < 0.05 };
    }
    need(r.metric === 'ack_6s', `알 수 없는 지표 ${r.metric}`);
    return { scope: s, metric: 'ack_6s', display_role: 'auxiliary', test: 'not_tested_separately', holm_p: null, significant_after_holm: null, same_as_delivered: sameAsDelivered(s) };
  });
  const ackSameEverywhere = classification.filter((c) => c.metric === 'ack_6s').every((c) => (c as { same_as_delivered?: boolean }).same_as_delivered);

  const out = {
    schema: FAIR_SCHEMA,
    data_kind: 'stored_study_result',
    live: false,
    label: FAIR_LABEL,
    protocol: 'fair_retry_v1',
    stage: 'main',
    run_label: runName,
    measured_on: '2026-11-16',
    measured_tz: 'KST',
    use: summary.use,
    provenance: {
      analysis_dir: basename(dir),
      generator: 'frontend/scripts/import-fair-retry.ts',
      generated_at: generatedAt,
      sums_file: SUMS_FILE,
      sums_file_sha256: sumsSha256,
      files,
      hash_check: 'passed',
      plan_design_sha256: summary.plan_design_sha256,
      seed: summary.seed,
      removed_fields: ['run (local absolute path)', 'run UUID'],
      raw_data_published: false,
    },
    sample: {
      cells_planned: summary.cells_planned,
      cells_checkpointed: summary.cells_checkpointed,
      planned_blocks: summary.planned_blocks,
      valid_blocks: summary.valid_blocks,
      excluded_blocks: summary.excluded_blocks,
      audited_exclusions: summary.audited_exclusions,
    },
    settings: FAIR_SETTINGS,
    primary: p,
    stats: stats as Row[],
    classification,
    ack_6s_equals_delivered_everywhere: ackSameEverywhere,
    attempts_per_message: summary.attempts_per_message,
    ack_latency: summary.ack_latency,
    control_overhead: summary.control_overhead,
    not_reported: summary.not_reported,
    exclusions: exclusions as Row[],
  };
  const text = JSON.stringify(out);
  for (const re of FORBIDDEN) need(!re.test(text), `공개 JSON 에 금지 문자열 ${re}`);
  return out;
}
