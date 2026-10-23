/**
 * 저장된 본 실험(aligned_v3) 결과. 실시간 데이터가 아닙니다.
 * 원본: outputs/final-analysis-20261022-claude-7f3a2c (scripts/import-study.ts 로 해시 검증 후 변환, verify:study 로 대조)
 * 이 모듈은 백엔드·WebSocket·스토어와 연결하지 않습니다. 값은 CSV 원문을 그대로 옮긴 것이며 여기서 재계산하지 않습니다.
 */
import raw from '@/data/study/aligned-v3-study.json';

export type StudyMetric = 'delivered' | 'delivered_6s' | 'ack' | 'ack_6s';

export interface RateRow {
  scope: string;
  metric: StudyMetric;
  metric_desc: string;
  pairs: number;
  messages_per_method: number;
  fixed_success: number;
  fixed_n: number;
  fixed_rate: number;
  fixed_ci_low: number;
  fixed_ci_high: number;
  exit_link_success: number;
  exit_link_n: number;
  exit_link_rate: number;
  exit_link_ci_low: number;
  exit_link_ci_high: number;
  diff_exit_minus_fixed: number;
  diff_ci_low: number;
  diff_ci_high: number;
  diff_ci_method: string;
  pairs_exit_better: number;
  pairs_fixed_better: number;
  pairs_tied: number;
  sign_test_p: number;
  sign_test_p_holm_within_metric_8_strata: number | null;
}

export interface LatencyRow {
  scope: string;
  pairs: number;
  note: string;
  fixed_ack_n: number;
  fixed_total_n: number;
  fixed_median_ms: number | null;
  fixed_p95_ms: number | null;
  exit_link_ack_n: number;
  exit_link_total_n: number;
  exit_link_median_ms: number | null;
  exit_link_p95_ms: number | null;
}

export interface OverheadRow {
  method: 'fixed' | 'exit_link';
  cells: number;
  control_bytes_per_second_mean: number;
  control_bytes_per_second_median: number;
  detection_observations_n: number;
  detection_ms_median: number | null;
  detection_ms_p95: number | null;
  messages: number;
  mean_retries: number;
}

export interface ExclusionRow {
  level: 'cell' | 'pair';
  item: string;
  source: string;
  method: string;
  condition: string;
  fault_timing: string;
  repetition: number;
  reason: string;
}

export interface StudyData {
  schema: 'exit-link-study-v1';
  data_kind: 'stored_study_result';
  live: false;
  label: string;
  protocol: string;
  measured_on: string;
  provenance: {
    analysis_dir: string;
    generated_at: string;
    generator: string;
    sums_file: string;
    sums_file_sha256: string;
    files: Record<string, string>;
    integrity_status: string;
    protected_inputs_unchanged: boolean;
  };
  sample: {
    planned_cells: number;
    valid_cells: number;
    valid_pairs: number;
    valid_by_method: Record<string, number>;
    pairs_by_stratum: Record<string, number>;
    pairs_by_source: Record<string, number>;
    excluded_cells: string[];
    excluded_pairs: string[][];
  };
  settings: {
    client_timeout_seconds: number;
    observation_window_seconds: number;
    fixed_retries: number;
    exit_link_max_retries: number;
    node_hop_timeout_seconds: number;
  };
  overall: RateRow[];
  by_stratum: RateRow[];
  by_fault_timing: RateRow[];
  latency: LatencyRow[];
  overhead: OverheadRow[];
  exclusions: ExclusionRow[];
}

export const study = raw as unknown as StudyData;
export const studyValid = study.schema === 'exit-link-study-v1' && study.live === false && study.provenance.integrity_status === 'passed';

/** 층 표시 순서와 이름(분석 보고서와 같은 순서) */
export const STRATA: { scope: string; label: string; short: string }[] = [
  { scope: 'normal/none', label: '정상 · 장애 없음', short: '정상' },
  { scope: 'single_failure/before_send', label: '단일 장애 · 전송 전', short: '단일·전' },
  { scope: 'single_failure/inflight', label: '단일 장애 · 전송 중', short: '단일·중' },
  { scope: 'sequential_failures/before_send', label: '연속 장애 · 전송 전', short: '연속·전' },
  { scope: 'sequential_failures/inflight', label: '연속 장애 · 전송 중', short: '연속·중' },
  { scope: 'restart/before_send', label: '재시작 · 전송 전', short: '재시작·전' },
  { scope: 'restart/inflight', label: '재시작 · 전송 중', short: '재시작·중' },
  { scope: 'no_route/before_send', label: '경로 없음 · 전송 전', short: '경로 없음' },
];

export const rowOf = (rows: RateRow[], scope: string, metric: StudyMetric) => rows.find((r) => r.scope === scope && r.metric === metric) ?? null;

/** 표시용 서식(값 자체는 바꾸지 않음) */
export const pct = (v: number, digits = 1) => `${(v * 100).toFixed(digits)}%`;
export const pp = (v: number, digits = 1) => `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(digits)}%p`;
export const ppRange = (lo: number, hi: number) => `[${pp(lo)}, ${pp(hi)}]`;
export const pctRange = (lo: number, hi: number) => `[${pct(lo)}, ${pct(hi)}]`;
export function pValue(p: number | null) {
  if (p === null) return '—';
  if (p >= 0.001) return p.toFixed(3);
  const [m, e] = p.toExponential(1).split('e');
  return `${m}×10^${Number(e)}`;
}
/** 대응 bootstrap 구간 폭이 0인 경우: 표본 안에서 변이가 없었다는 뜻이지 불확실성이 없다는 뜻이 아님 */
export const zeroWidth = (lo: number, hi: number) => lo === hi;
