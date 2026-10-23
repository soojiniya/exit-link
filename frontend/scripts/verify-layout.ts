/**
 * npm run verify:layout
 * 백엔드 저장소의 building.json / communication.json(읽기 전용)과 src/data/building-layout.json을 대조합니다.
 * 실행 중인 서버가 있으면 `--api http://127.0.0.1:8000`으로 실제 /api/v1/building 응답과도 대조할 수 있습니다.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { verifyLayout, type GraphBuilding, type GraphTopologyNode, type LayoutLike } from '../src/domain/layoutCheck';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const read = <T,>(p: string) => JSON.parse(readFileSync(p, 'utf8')) as T;

const layout = read<LayoutLike>(resolve(here, '..', 'src', 'data', 'building-layout.json'));
const apiIdx = process.argv.indexOf('--api');
let building: GraphBuilding;
let topology: GraphTopologyNode[];
let source: string;
if (apiIdx > -1) {
  const origin = process.argv[apiIdx + 1] ?? 'http://127.0.0.1:8000';
  building = ((await (await fetch(`${origin}/api/v1/building`)).json()) as { building: GraphBuilding }).building;
  topology = ((await (await fetch(`${origin}/api/v1/network`)).json()) as { topology: { nodes: GraphTopologyNode[] } }).topology.nodes;
  source = `${origin}/api/v1/building, /api/v1/network`;
} else {
  const sim = resolve(root, 'src', 'exit_link', 'data', 'simulation');
  building = read<GraphBuilding>(resolve(sim, 'building.json'));
  topology = read<{ nodes: GraphTopologyNode[] }>(resolve(sim, 'communication.json')).nodes;
  source = sim;
}

const r = verifyLayout(building, layout, topology);
console.log(`비교 대상: ${source}`);
let group = '';
for (const i of r.items) {
  if (i.group !== group) console.log(`\n[${(group = i.group)}]`);
  console.log(`  ${i.ok ? 'PASS' : 'FAIL'}  ${i.name.padEnd(16)} ${i.detail}`);
}
console.log(`\n결과: ${r.passed} 통과 / ${r.failed} 실패 — 배치는 시각화 전용 가정 좌표(m_assumed)입니다.`);
process.exit(r.ok ? 0 : 1);
