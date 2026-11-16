/**
 * npm run import:fair-retry -- --analysis <분석 폴더 경로> [--force]
 *
 * fair_retry_v1 본 실험 분석 폴더(outputs/fair-retry-main-*)를 읽기 전용으로 검증해
 * 웹 화면용 공개 요약 JSON(src/data/study/fair-retry-v1-study.json)을 만듭니다.
 * 검증 조건은 scripts/fair-retry-source.ts 에 있습니다. 하나라도 어긋나면 아무것도 쓰지 않고 종료 코드 1.
 * 원본 실행 폴더(data/measured/fair-retry/main-*)는 읽지 않으며, 공개 JSON 에는 요약 통계만 들어갑니다.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { FAIR_OUT_FILE, FairStop, buildFairStudy } from './fair-retry-source';
import { PROJECT } from './study-source';

const i = process.argv.indexOf('--analysis');
const arg = i > -1 ? process.argv[i + 1] : undefined;
if (!arg) {
  console.error('STOP: --analysis <outputs/fair-retry-main-* 경로> 가 필요합니다');
  process.exit(1);
}
const force = process.argv.includes('--force');
if (existsSync(FAIR_OUT_FILE) && !force) {
  console.error(`STOP: ${relative(PROJECT, FAIR_OUT_FILE)} 이(가) 이미 있습니다. 다시 만들려면 --force`);
  process.exit(1);
}
try {
  const out = buildFairStudy(resolve(PROJECT, arg), new Date().toISOString());
  mkdirSync(dirname(FAIR_OUT_FILE), { recursive: true });
  writeFileSync(FAIR_OUT_FILE, JSON.stringify(out, null, 2) + '\n', { encoding: 'utf8', flag: force ? 'w' : 'wx' });
  console.log(`OK ${relative(PROJECT, FAIR_OUT_FILE)} · 파일 ${Object.keys(out.provenance.files).length}개 SHA-256 확인 · 유효 블록 ${out.sample.valid_blocks} · 제외 ${out.sample.excluded_blocks}`);
} catch (e) {
  console.error('STOP:', e instanceof FairStop || e instanceof Error ? e.message : e);
  process.exit(1);
}
