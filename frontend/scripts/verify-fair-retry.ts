/**
 * npm run verify:fair-retry [-- --analysis <분석 폴더 경로>]
 *
 * 1. (원본이 있을 때, --analysis) 분석 폴더에서 공개 요약을 다시 만들어 저장된 JSON 과 완전히 같은지 비교합니다
 *    (generated_at 만 제외). SHA-256·합계·분류 검사는 fair-retry-source.ts 의 같은 규칙을 다시 통과해야 합니다.
 * 2. (항상) 원본 없이 할 수 있는 검사: 실시간 아님 표시, 개인 경로·사용자명·토큰 없음, JSON 내부 합계와 분류 규칙,
 *    화면 코드에 연구 수치 하드코딩 없음, 연구 화면이 스토어·WebSocket·REST 를 쓰지 않음, Analytics 기본 연구.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FAIR_LABEL, FAIR_OUT_FILE, FAIR_SCHEMA, FORBIDDEN, buildFairStudy } from './fair-retry-source';
import { PROJECT } from './study-source';

const text = readFileSync(FAIR_OUT_FILE, 'utf8');
const data = JSON.parse(text) as Record<string, any>;
let checks = 0;
const problems: string[] = [];
const check = (ok: unknown, msg: string) => { checks++; if (!ok) problems.push(msg); };
const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');

// ── 1. 원본 대조
const i = process.argv.indexOf('--analysis');
let compared = false;
if (i > -1) {
  const rebuilt = buildFairStudy(resolve(PROJECT, process.argv[i + 1]), data.provenance.generated_at);
  check(JSON.stringify(rebuilt) === JSON.stringify(data), '원본에서 다시 만든 요약이 저장된 JSON 과 다릅니다');
  let cells = 0;
  for (const key of ['stats', 'exclusions'] as const) {
    rebuilt[key].forEach((row: Record<string, unknown>, r: number) => {
      for (const [col, v] of Object.entries(row)) { cells++; check(Object.is(data[key][r]?.[col], v), `${key}:${r + 2} ${col}`); }
    });
  }
  console.log(`원본 대조: SHA-256 ${Object.keys(rebuilt.provenance.files).length}개 일치 · CSV 값 ${cells}개 일치`);
  compared = true;
}

// ── 2. 정적 검사
check(data.schema === FAIR_SCHEMA && data.data_kind === 'stored_study_result' && data.live === false, '실시간 아님 표시');
check(data.label === FAIR_LABEL && data.protocol === 'fair_retry_v1' && data.stage === 'main', '라벨·프로토콜·단계');
check(data.provenance.hash_check === 'passed' && data.provenance.raw_data_published === false, 'provenance 상태');
check(/^[0-9a-f]{64}$/.test(data.provenance.sums_file_sha256) && Object.values(data.provenance.files).every((h) => /^[0-9a-f]{64}$/.test(String(h))), '해시 형식');
for (const re of FORBIDDEN) check(!re.test(text), `금지 문자열 ${re}`);

const row = (scope: string, metric: string) => data.stats.find((r: any) => r.scope === scope && r.metric === metric);
const o = row('overall', 'delivered');
check(o.role === 'primary' && data.primary.estimate === o.diff_exit_minus_fixed_retry, '1차 행 = primary');
const strata = data.stats.filter((r: any) => r.metric === 'delivered' && r.scope !== 'overall');
check(strata.length === 8, '조건 8개');
for (const k of ['blocks', 'fixed_retry_success', 'fixed_retry_n', 'exit_link_success', 'exit_link_n']) {
  check(strata.reduce((s: number, r: any) => s + r[k], 0) === o[k], `조건별 ${k} 합 = 전체`);
}
check(o.blocks === data.sample.valid_blocks && data.sample.valid_blocks + data.sample.excluded_blocks === data.sample.planned_blocks, '블록 수');
check(data.exclusions.length === data.sample.excluded_blocks, '제외 행 수');
for (const m of ['fixed_retry', 'exit_link']) {
  const a = data.attempts_per_message[m];
  check(Object.values(a.distribution as Record<string, number>).reduce((s, v) => s + v, 0) === a.messages && a.unconfirmed === 0, `${m} 시도 분포 합`);
  check(data.ack_latency[m].ack_n === o[`${m}_success`], `${m} ACK 수 = 성공 수`);
}
for (const c of data.classification) {
  if (c.metric === 'ack_6s') check(c.display_role === 'auxiliary' && c.test === 'not_tested_separately' && c.holm_p === null, `${c.scope} ack_6s 는 보조 지표`);
  else if (c.scope === 'overall') check(c.display_role === 'primary' && c.holm_p === null, '전체 delivered 는 1차·보정 없음');
  else check(c.display_role === 'secondary_stratum' && (c.significant_after_holm === null || c.significant_after_holm === (c.holm_p < 0.05)), `${c.scope} Holm 판정`);
}
check(data.classification.filter((c: any) => c.display_role === 'primary').length === 1, '1차 검정은 하나');

// 화면 코드: 같은 모듈 사용 · 수치 하드코딩 금지 · 실시간 데이터 의존 금지
const ui = src('ui/study/FairRetryResults.tsx');
const dom = src('domain/fairRetry.ts');
const cav = src('ui/study/fairRetryCaveats.ts');
const page = src('pages/Analytics.tsx');
check(/from '@\/domain\/fairRetry'/.test(ui) && /fair-retry-v1-study\.json/.test(dom), 'FairRetryResults → domain/fairRetry → JSON');
for (const [name, code] of [['FairRetryResults', ui], ['fairRetryCaveats', cav], ['Analytics', page], ['domain/fairRetry', dom]] as const) {
  for (const lit of ['37.5', '68.5', '68.4', '30.97', '31.0', '270/720', '493/720', '0.375', '0.6847', '0.3097', '240블록', '720건', '0.156']) {
    check(!code.includes(lit), `${name} 에 연구 수치 ${lit} 하드코딩 금지`);
  }
}
const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
for (const [name, code] of [['FairRetryResults', ui], ['domain/fairRetry', dom], ['fairRetryCaveats', cav]] as const) {
  check(!/from '@\/(store|api|net|socket)|useApp\(|new WebSocket|fetch\(|axios/.test(stripComments(code)), `${name} 은 스토어·WebSocket·REST 를 쓰지 않음`);
}
check(/DEFAULT_STUDY\s*[:=][^\n]*'fair_retry_v1'/.test(page), 'Analytics 기본 연구 = fair_retry_v1');
check(/'aligned_v3'/.test(page) && /<StudyResults \/>/.test(page), 'aligned_v3 화면 유지');

if (problems.length) {
  console.error(`FAIL ${problems.length}/${checks}`);
  problems.slice(0, 40).forEach((p) => console.error(' -', p));
  process.exit(1);
}
console.log(`OK verify:fair-retry · 검사 ${checks}개${compared ? ' · 원본 대조 포함' : ' · 정적 검사만(원본 대조는 --analysis)'} · 유효 블록 ${data.sample.valid_blocks}`);
