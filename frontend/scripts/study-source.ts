/**
 * 최종 분석 폴더(읽기 전용) 공통 읽기 도구. import-study.ts 와 verify-study.ts 가 함께 씁니다.
 * - 분석 폴더에는 아무것도 쓰지 않습니다(readFileSync 만 사용).
 * - 각 입력 파일은 OUTPUT_SHA256SUMS.txt 에 적힌 SHA-256 과 같아야 합니다.
 * - CSV 값은 손대지 않고 형만 바꿉니다: 숫자 문자열 → number, 빈 칸 → null, True/False → boolean.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PROJECT = resolve(FRONTEND, '..');
export const DEFAULT_ANALYSIS = 'outputs/final-analysis-20261022-claude-7f3a2c';
export const OUT_FILE = resolve(FRONTEND, 'src', 'data', 'study', 'aligned-v3-study.json');

/** 웹 화면이 쓰는 분석 파일. 이 목록 밖의 파일은 읽지 않습니다. */
export const CSV_FILES = {
  overall: 'stats_overall.csv',
  by_stratum: 'stats_by_stratum.csv',
  by_fault_timing: 'stats_by_fault_timing.csv',
  by_condition: 'stats_by_condition.csv',
  by_position: 'stats_by_position_mcnemar.csv',
  latency: 'latency_conditional.csv',
  latency_by_position: 'latency_by_position.csv',
  overhead: 'overhead_detection.csv',
  exclusions: 'exclusions.csv',
} as const;
export const JSON_FILES = { integrity: 'integrity_report.json', hashes_after: 'hashes_after_check.json' } as const;
export const SUMS_FILE = 'OUTPUT_SHA256SUMS.txt';

export type Cell = number | string | boolean | null;
export type Row = Record<string, Cell>;

export const sha256 = (buf: Buffer | string) => createHash('sha256').update(buf).digest('hex');

export function analysisDir(argv: string[]) {
  const i = argv.indexOf('--analysis');
  const rel = i > -1 ? argv[i + 1] : DEFAULT_ANALYSIS;
  if (!rel) throw new Error('--analysis 경로가 비어 있습니다');
  return resolve(PROJECT, rel);
}

/** OUTPUT_SHA256SUMS.txt → { 'stats_overall.csv': hash, ... } */
export function readSums(dir: string) {
  const text = readFileSync(resolve(dir, SUMS_FILE), 'utf8');
  const sums: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = /^([0-9a-f]{64})\s+\*?(?:\.\/)?(.+)$/.exec(line);
    if (!m) throw new Error(`${SUMS_FILE} 형식 오류: ${line}`);
    sums[m[2]] = m[1];
  }
  return { sums, sumsSha256: sha256(text) };
}

/** 해시를 확인한 뒤에만 내용을 돌려줍니다. */
export function readVerified(dir: string, name: string, sums: Record<string, string>) {
  const expected = sums[name];
  if (!expected) throw new Error(`${name}: ${SUMS_FILE}에 없는 파일입니다`);
  const buf = readFileSync(resolve(dir, name));
  const actual = sha256(buf);
  if (actual !== expected) throw new Error(`${name}: 해시 불일치 (기록 ${expected}, 현재 ${actual})`);
  return { text: buf.toString('utf8'), sha256: actual };
}

const NUMERIC = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

export function convert(raw: string): Cell {
  if (raw === '') return null;
  if (raw === 'True') return true;
  if (raw === 'False') return false;
  if (NUMERIC.test(raw)) return Number(raw);
  return raw; // 'inf', 설명 문자열, 경로 등은 그대로
}

/** RFC 4180 CSV(따옴표·쉼표·줄바꿈 포함 필드, UTF-8 BOM) → 원문 문자열 행 */
export function parseCsvRaw(text: string): Record<string, string>[] {
  const s = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (quoted) throw new Error('CSV: 닫히지 않은 따옴표');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows.filter((r) => !(r.length === 1 && r[0] === ''));
  if (!head) throw new Error('CSV: 머리글 없음');
  return body.map((r, n) => {
    if (r.length !== head.length) throw new Error(`CSV: ${n + 2}행 열 수 ${r.length} ≠ ${head.length}`);
    return Object.fromEntries(head.map((h, k) => [h, r[k]]));
  });
}

export const parseCsv = (text: string): Row[] =>
  parseCsvRaw(text).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, convert(v)])));
