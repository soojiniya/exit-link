/**
 * npm run import:study [-- --analysis <프로젝트 기준 경로>] [-- --force]
 *
 * 최종 분석 폴더를 읽기 전용으로 검증해 웹 화면용 정적 JSON(src/data/study/aligned-v3-study.json)을 만듭니다.
 * 진행 조건(하나라도 어긋나면 아무것도 쓰지 않고 종료 코드 1):
 *  - 사용하는 모든 파일의 SHA-256 = OUTPUT_SHA256SUMS.txt
 *  - integrity_report.json status = passed, errors = []
 *  - hashes_after_check.json all_unchanged = true (원본·후속·owner·승인 기록 해시 불변)
 *  - 대응 쌍 수가 integrity_report, stats_overall, stats_by_stratum 에서 서로 같음
 * 값은 CSV 원문을 형만 바꿔 그대로 옮기며, 계산·반올림·보정을 하지 않습니다.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import {
  CSV_FILES, JSON_FILES, OUT_FILE, PROJECT, SUMS_FILE, analysisDir, parseCsv, readSums, readVerified, type Row,
} from './study-source';

const fail = (msg: string): never => {
  console.error('STOP:', msg);
  process.exit(1);
};

const dir = analysisDir(process.argv);
const force = process.argv.includes('--force');
if (existsSync(OUT_FILE) && !force) fail(`${relative(PROJECT, OUT_FILE)} 이(가) 이미 있습니다. 다시 만들려면 --force`);

const { sums, sumsSha256 } = readSums(dir);
const files: Record<string, string> = {};
const tables: Record<string, Row[]> = {};
for (const [key, name] of Object.entries(CSV_FILES)) {
  const f = readVerified(dir, name, sums);
  files[name] = f.sha256;
  tables[key] = parseCsv(f.text);
}
const jsonDocs: Record<string, Record<string, unknown>> = {};
for (const [key, name] of Object.entries(JSON_FILES)) {
  const f = readVerified(dir, name, sums);
  files[name] = f.sha256;
  jsonDocs[key] = JSON.parse(f.text);
}

const integrity = jsonDocs.integrity as Record<string, any>;
const after = jsonDocs.hashes_after as Record<string, any>;
if (integrity.status !== 'passed' || (integrity.errors ?? []).length) fail(`integrity_report status=${integrity.status}`);
if (after.all_unchanged !== true) fail('hashes_after_check.all_unchanged 가 true 가 아닙니다');
const overallDelivered = tables.overall.find((r) => r.metric === 'delivered');
if (!overallDelivered) fail('stats_overall.csv 에 delivered 행이 없습니다');
const stratumPairs = tables.by_stratum.filter((r) => r.metric === 'delivered').reduce((s, r) => s + Number(r.pairs), 0);
if (!(integrity.valid_pairs === overallDelivered!.pairs && stratumPairs === integrity.valid_pairs)) {
  fail(`대응 쌍 수 불일치: integrity ${integrity.valid_pairs}, overall ${overallDelivered!.pairs}, 층 합 ${stratumPairs}`);
}

const pick = (o: Record<string, any>, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o[k] ?? null]));
const out = {
  schema: 'exit-link-study-v1',
  data_kind: 'stored_study_result',
  live: false,
  label: '저장된 실험 결과 · aligned_v3 · 2026-10-21 측정 · 실시간 아님',
  protocol: 'aligned_v3',
  measured_on: '2026-10-21',
  provenance: {
    analysis_dir: relative(PROJECT, dir).replaceAll('\\', '/'),
    generated_at: new Date().toISOString(),
    generator: 'frontend/scripts/import-study.ts',
    sums_file: SUMS_FILE,
    sums_file_sha256: sumsSha256,
    files,
    integrity_status: integrity.status,
    protected_inputs_unchanged: after.all_unchanged,
    protected_input_counts: after.counts ?? null,
    ids: integrity.ids ?? null,
    executed_network_operations: integrity.executed_network_operations ?? null,
    physical_merge: integrity.physical_merge ?? null,
  },
  sample: pick(integrity, ['planned_cells', 'original_checkpoints', 'continuation_checkpoints', 'attempted_cells', 'valid_cells',
    'valid_by_method', 'valid_pairs', 'pairs_by_stratum', 'pairs_by_source', 'excluded_cells', 'excluded_pairs']),
  settings: pick(integrity.settings ?? {}, ['client_timeout_seconds', 'observation_window_seconds', 'fixed_retries', 'exit_link_max_retries',
    'node_hop_timeout_seconds', 'probe_interval_seconds', 'failure_threshold', 'scheduling_tolerance_ms']),
  ...tables,
};

mkdirSync(dirname(OUT_FILE), { recursive: true });
writeFileSync(OUT_FILE, JSON.stringify(out, null, 2) + '\n', { encoding: 'utf8', flag: force ? 'w' : 'wx' });
console.log(`OK ${relative(PROJECT, OUT_FILE)} · 파일 ${Object.keys(files).length}개 해시 확인 · 유효 대응 쌍 ${integrity.valid_pairs}`);
