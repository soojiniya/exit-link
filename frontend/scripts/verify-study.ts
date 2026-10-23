/**
 * npm run verify:study [-- --analysis <프로젝트 기준 경로>]
 *
 * src/data/study/aligned-v3-study.json 이 최종 분석 원본과 일치하는지 검사합니다(읽기 전용).
 *  1. 분석 파일 해시 = OUTPUT_SHA256SUMS.txt = JSON provenance.files
 *  2. JSON 의 모든 표(행 순서·열·값)가 원본 CSV 와 같음 (숫자는 같은 배정밀도 값)
 *  3. 요약값(유효 대응 쌍, 제외 쌍, 무결성 상태)이 integrity_report.json 과 같음
 *  4. JSON 이 실시간 데이터가 아님을 명시(live=false, label)
 */
import { readFileSync } from 'node:fs';
import {
  CSV_FILES, JSON_FILES, OUT_FILE, analysisDir, parseCsv, readSums, readVerified, type Row,
} from './study-source';

const dir = analysisDir(process.argv);
const study = JSON.parse(readFileSync(OUT_FILE, 'utf8')) as Record<string, any>;
const { sums, sumsSha256 } = readSums(dir);
let checks = 0;
const problems: string[] = [];
const check = (ok: boolean, msg: string) => { checks++; if (!ok) problems.push(msg); };

check(study.schema === 'exit-link-study-v1' && study.live === false && study.data_kind === 'stored_study_result', '실시간 아님 표시');
check(study.label === '저장된 실험 결과 · aligned_v3 · 2026-10-21 측정 · 실시간 아님', '출처 문구');
check(study.provenance.sums_file_sha256 === sumsSha256, 'OUTPUT_SHA256SUMS.txt 해시가 생성 시점과 다릅니다');

let cells = 0;
for (const [key, name] of Object.entries(CSV_FILES)) {
  const f = readVerified(dir, name, sums);
  check(study.provenance.files[name] === f.sha256, `${name}: provenance 해시`);
  const source = parseCsv(f.text);
  const copy = study[key] as Row[];
  check(Array.isArray(copy) && copy.length === source.length, `${name}: 행 수 ${copy?.length} ≠ ${source.length}`);
  source.forEach((row, i) => {
    const target = copy?.[i] ?? {};
    check(Object.keys(target).join('|') === Object.keys(row).join('|'), `${name}:${i + 2} 열 구성`);
    for (const [col, v] of Object.entries(row)) {
      cells++;
      check(Object.is(target[col], v), `${name}:${i + 2} ${col}: JSON ${String(target[col])} ≠ CSV ${String(v)}`);
    }
  });
}
const integrity = JSON.parse(readVerified(dir, JSON_FILES.integrity, sums).text);
const after = JSON.parse(readVerified(dir, JSON_FILES.hashes_after, sums).text);
check(integrity.status === 'passed' && study.provenance.integrity_status === 'passed', '무결성 상태');
check(after.all_unchanged === true && study.provenance.protected_inputs_unchanged === true, '보호 입력 해시 불변');
for (const k of ['valid_pairs', 'valid_cells', 'planned_cells', 'excluded_pairs', 'excluded_cells', 'pairs_by_stratum', 'valid_by_method']) {
  check(JSON.stringify(study.sample[k]) === JSON.stringify(integrity[k]), `sample.${k}`);
}

// 화면에 크게 나오는 핵심 수치를 원본 CSV 원문과 한 번 더 대조
const raw = parseCsv(readVerified(dir, CSV_FILES.overall, sums).text).find((r) => r.metric === 'delivered')!;
check(Object.is(raw.fixed_success, 210) && Object.is(raw.fixed_n, 714) && Object.is(raw.exit_link_success, 487), '전체 전달 성공 분자·분모');

// Overview · Analytics 연구 지표: 같은 study 모듈·같은 행(overall/delivered)을 읽고, 수치를 코드에 직접 적지 않았는지
{
  const ov = readFileSync(new URL('../src/pages/Overview.tsx', import.meta.url), 'utf8');
  const an = readFileSync(new URL('../src/ui/study/StudyResults.tsx', import.meta.url), 'utf8');
  check(/from '@\/domain\/study'/.test(ov) && /from '@\/domain\/study'/.test(an), 'Overview·Analytics 모두 domain/study 모듈 사용');
  check(/rowOf\(study\.overall, 'overall', 'delivered'\)/.test(ov) && /rowOf\(study\.overall, 'overall', 'delivered'\)/.test(an), 'Overview·Analytics 같은 행(overall · delivered)');
  for (const lit of ['29.4', '68.2', '38.8', '210/714', '487/714', '0.294', '0.682', '0.388']) check(!ov.includes(lit), `Overview 에 연구 수치 ${lit} 하드코딩 금지`);
  const ap = readFileSync(new URL('../src/pages/Analytics.tsx', import.meta.url), 'utf8');
  for (const lit of ['29.4', '68.2', '38.8', '210/714', '487/714', '0.294', '0.682', '0.388', '238쌍', '714건']) {
    check(!an.includes(lit), `Analytics(StudyResults) 에 연구 수치 ${lit} 하드코딩 금지`);
    check(!ap.includes(lit), `Analytics 페이지에 연구 수치 ${lit} 하드코딩 금지`);
  }
}

// STORY 장면 05: 같은 study 모듈·같은 행, 수치 하드코딩 금지 · 주의사항은 Analytics 와 같은 공용 모듈
{
  const st = readFileSync(new URL('../src/pages/Story.tsx', import.meta.url), 'utf8');
  const an = readFileSync(new URL('../src/ui/study/StudyResults.tsx', import.meta.url), 'utf8');
  check(/from '@\/domain\/study'/.test(st) && /rowOf\(study\.overall, 'overall', 'delivered'\)/.test(st), 'STORY: domain/study · overall/delivered 행 사용');
  for (const lit of ['29.4', '68.2', '38.8', '210/714', '487/714', '0.294', '0.682', '0.388', '238', '714']) check(!st.includes(lit), `STORY 에 연구 수치 ${lit} 하드코딩 금지`);
  check(/from '@\/ui\/study\/caveats'/.test(st) && /from '@\/ui\/study\/caveats'/.test(an), 'STORY·Analytics 주의사항 공용 모듈(caveats.ts)');
}

if (problems.length) {
  console.error(`FAIL ${problems.length}/${checks}`);
  problems.slice(0, 40).forEach((p) => console.error(' -', p));
  process.exit(1);
}
console.log(`OK verify:study · 검사 ${checks}개 · CSV 값 ${cells}개 일치 · 유효 대응 쌍 ${study.sample.valid_pairs}`);
