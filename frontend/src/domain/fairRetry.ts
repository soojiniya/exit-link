/**
 * 저장된 공정 비교 본 실험(fair_retry_v1) 결과. 실시간 데이터가 아닙니다.
 * 원본: outputs/fair-retry-main-20261116 (scripts/import-fair-retry.ts 로 SHA-256 검증 후 변환, verify:fair-retry 로 대조)
 * 이 모듈은 백엔드·WebSocket·스토어와 연결하지 않습니다. 값은 분석 파일을 그대로 옮긴 것이며 여기서 재계산하지 않습니다.
 * aligned_v3(domain/study)와는 별개 실행이며 수치를 합치지 않습니다. 서식 함수와 조건 순서만 공유합니다.
 */
import raw from '@/data/study/fair-retry-v1-study.json';

export type FairMethod = 'fixed_retry' | 'exit_link';
export type FairMetric = 'delivered' | 'ack_6s';

export interface FairRow {
  scope: string;
  metric: FairMetric;
  role: string;
  blocks: number;
  fixed_retry_success: number;
  fixed_retry_n: number;
  fixed_retry_rate: number;
  fixed_retry_ci_low: number;
  fixed_retry_ci_high: number;
  exit_link_success: number;
  exit_link_n: number;
  exit_link_rate: number;
  exit_link_ci_low: number;
  exit_link_ci_high: number;
  diff_exit_minus_fixed_retry: number;
  diff_ci_low: number;
  diff_ci_high: number;
  ci_method: string;
  ci_note: string | null;
  bootstrap_seed: number;
  bootstrap_draws: number;
  blocks_exit_better: number;
  blocks_fixed_retry_better: number;
  blocks_tied: number;
  sign_test_p: number;
  multiplicity: string;
  sign_test_p_holm: number | string;
}

/** 화면 분류: 변환 단계에서 규칙으로 정함(원본 라벨은 stats 에 그대로 보존) */
export interface FairClass {
  scope: string;
  metric: FairMetric;
  display_role: 'primary' | 'secondary_stratum' | 'auxiliary';
  test: 'single_preregistered_primary_unadjusted' | 'sign_test_holm_8_strata' | 'all_blocks_tied_no_difference' | 'not_tested_separately';
  holm_p: number | null;
  significant_after_holm: boolean | null;
  same_as_delivered?: boolean;
}

export interface FairAttempts {
  source: string;
  messages: number;
  confirmed: number;
  unconfirmed: number;
  distribution: Record<string, number>;
  client_deadline_missed: number;
}

export interface FairStudy {
  schema: 'exit-link-fair-retry-study-v1';
  data_kind: 'stored_study_result';
  live: false;
  label: string;
  protocol: 'fair_retry_v1';
  stage: 'main';
  run_label: string;
  measured_on: string;
  measured_tz: string;
  use: string;
  provenance: {
    analysis_dir: string;
    generator: string;
    generated_at: string;
    sums_file: string;
    sums_file_sha256: string;
    files: Record<string, string>;
    hash_check: string;
    plan_design_sha256: string;
    seed: number;
    removed_fields: string[];
    raw_data_published: boolean;
  };
  sample: { cells_planned: number; cells_checkpointed: number; planned_blocks: number; valid_blocks: number; excluded_blocks: number; audited_exclusions: number };
  settings: {
    source: string;
    max_retries: number;
    max_attempts: number;
    retry_location: string;
    retry_backoff_seconds: number;
    node_hop_timeout_seconds: number;
    client_timeout_seconds: number;
    observation_window_seconds: number;
    ttl: number;
    messages_per_cell: number;
    repetitions_per_stratum: number;
    fixed_retry_route: string;
    exit_link_probe_interval_seconds: number;
    exit_link_failure_threshold: number;
    bootstrap: string;
  };
  primary: { metric: string; contrast: string; estimate: number; ci_low: number; ci_high: number; ci_method: string; sign_test_p: number; multiplicity: string };
  stats: FairRow[];
  classification: FairClass[];
  ack_6s_equals_delivered_everywhere: boolean;
  attempts_per_message: Record<FairMethod, FairAttempts>;
  ack_latency: Record<FairMethod, { ack_n: number; total_n: number; median_ms: number | null; p95_ms: number | null; note: string }>;
  control_overhead: Record<FairMethod, { definition: string; by_stratum_mean: Record<string, number> }>;
  not_reported: string[];
  exclusions: Record<string, string | number | null>[];
}

export const fair = raw as unknown as FairStudy;
export const fairValid = fair.schema === 'exit-link-fair-retry-study-v1' && fair.live === false && fair.stage === 'main'
  && fair.provenance.hash_check === 'passed' && fair.classification.filter((c) => c.display_role === 'primary').length === 1;

export const fairRow = (scope: string, metric: FairMetric) => fair.stats.find((r) => r.scope === scope && r.metric === metric) ?? null;
export const fairClass = (scope: string, metric: FairMetric) => fair.classification.find((c) => c.scope === scope && c.metric === metric) ?? null;

/** 조건 안에서 Fixed + Retry 의 블록 값이 모두 같았는지(성공률 0 또는 1) — CI 폭 0 의 이유를 데이터에서 판단 */
export const allOrNothing = (rate: number) => rate === 0 || rate === 1;
