/**
 * P1-4: the public demo (VITE_DEMO_MODE=1) must be read-only in the browser.
 * Unit fixtures only — no backend, no TCP. fetch is replaced and must never be called for writes.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { actions } from '../src/api/actions';
import { call, hasControlToken, setControlToken } from '../src/api/client';
import { setPublicDemoForTest } from '../src/domain/mode';
import SimulationLab from '../src/pages/SimulationLab';
import { useApp } from '../src/store/store';
import { PUBLIC_READONLY_HINT } from '../src/domain/mode';
import { eventStream } from '../src/realtime/socket';
import { TopBar } from '../src/ui/TopBar';
import { IncidentPanel } from '../src/ui/IncidentPanel';
import { needToken } from '../src/ui/lab/useAction';
import { labSteps } from '../src/ui/lab/LabOverview';

const TOKEN = 'unit-public-token-' + 'x'.repeat(32);
const originalFetch = globalThis.fetch;
let writes: string[] = [];

function reset(publicDemo: boolean) {
  setPublicDemoForTest(publicDemo);
  setControlToken(null);
  useApp.setState(useApp.getInitialState(), true);
  writes = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? 'GET') !== 'GET') writes.push(`${init?.method} ${String(input)}`);
    return new Response(JSON.stringify({ detail: { code: 'unit', message: 'unit' } }), { status: 418 });
  }) as typeof fetch;
}

const renderLab = () => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SimulationLab)));

await test('public mode never stores a control token', () => {
  reset(true);
  setControlToken(TOKEN);
  assert.equal(hasControlToken(), false);
});

await test('public mode blocks every write action before any request is sent', async () => {
  reset(true);
  const results = [
    await actions.createScenario(['F2_E']),
    await actions.replaceHazards('unit', 1, { fire_locations: ['F2_SW'] } as never),
    await actions.addPlan('unit', 'F3_W'),
    await actions.sendGuidance('unit', { start_location: 'F3_W', source_node: 'N1', destination_node: 'N4' } as never),
    await actions.startExperiment(),
    await actions.stopExperiment(),
    await actions.failNode('N2'),
    await actions.recoverNode('N2'),
    await actions.refreshNetwork(),
  ];
  assert.deepEqual(writes, []);
  for (const r of results) {
    assert.equal(r.ok, false);
    assert.equal((r as { code: string }).code, 'public_read_only');
  }
  assert.deepEqual(useApp.getState().recoverRequested, {});
});

await test('public mode still allows read-only GET requests', async () => {
  reset(true);
  let seen = '';
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    seen = String(input);
    return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
  }) as typeof fetch;
  await call('GET /health' as never);
  assert.ok(seen.endsWith('/health'));
});

await test('public Simulation Lab renders no token input or write controls and points to REPLAY', () => {
  reset(true);
  const html = renderLab();
  assert.ok(!html.includes('토큰 붙여넣기'), 'token input must not be rendered');
  // Markers rendered only by the write components (experiment, scenario, guidance controls).
  for (const marker of ['lab-node-grid', 'experiment-disabled-reason', 'scenario-disabled-reason', 'guidance-disabled-reason', 'aria-label="출발지 선택"', 'aria-label="발신 노드"']) {
    assert.ok(!html.includes(marker), `write control rendered: ${marker}`);
  }
  assert.ok(html.includes('data-testid="lab-public-readonly"'));
  assert.ok(html.includes('/twin?mode=replay&amp;case=t010') || html.includes('/replay'));
});

await test('local mode keeps the existing control surface', () => {
  reset(false);
  const html = renderLab();
  assert.ok(html.includes('토큰 붙여넣기'));
  assert.ok(html.includes('lab-node-grid') && html.includes('aria-label="출발지 선택"') && html.includes('aria-label="발신 노드"'));
  assert.ok(!html.includes('data-testid="lab-public-readonly"'));
});

await test('local mode still sends a write with the token', async () => {
  reset(false);
  setControlToken(TOKEN);
  await actions.startExperiment();
  assert.equal(writes.length, 1);
  assert.ok(writes[0].startsWith('POST ') && writes[0].endsWith('/api/v1/experiment'));
});


// ---- PR #2 (L1·L2·L3): public read-only UI. Unit fixtures only — no backend, no TCP. ----
type Handle = { handle: (f: unknown) => Promise<void> };
const snapshotFrame = (stream_id: string, sequence: number) => ({ type: 'snapshot', payload: { stream_id, sequence, scenarios: [], deliveries: [], network: null, experiment: null } });
const streamEvent = (stream_id: string, sequence: number) => ({ schema_version: '1.0', stream_id, sequence, event_id: `pr2-${sequence}`, timestamp: '2026-10-31T00:00:00Z', type: 'scenario.deleted', payload: { scenario_id: 'none' } });

/** fetch 를 GET 경로 기록용으로 바꿉니다. /snapshot 은 빈 스냅샷, 나머지는 404 를 돌려줍니다(공개 API 에 없는 경로 재현). */
function recordGets() {
  const gets: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if ((init?.method ?? 'GET') !== 'GET') writes.push(`${init?.method} ${url}`);
    else gets.push(new URL(url, 'http://unit.test').pathname);
    if (url.includes('/api/v1/snapshot')) return new Response(JSON.stringify(snapshotFrame('pr2-stream', 9).payload), { status: 200 });
    return new Response(JSON.stringify({ detail: 'Not Found' }), { status: 404 });
  }) as typeof fetch;
  return gets;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

await test('L1: public mode never requests GET /api/v1/events (history load and gap fill)', async () => {
  reset(true);
  const gets = recordGets();
  const stream = eventStream as unknown as Handle;
  await stream.handle(snapshotFrame('pr2-stream', 3)); // fresh stream → history load in local mode
  await tick();
  await stream.handle(streamEvent('pr2-stream', 7)); // sequence gap → /events in local mode
  await tick();
  assert.ok(!gets.some((p) => p.endsWith('/api/v1/events')), `unexpected /events request: ${gets.join(', ')}`);
  assert.ok(gets.some((p) => p.endsWith('/api/v1/snapshot')), 'gap must fall back to /snapshot');
  assert.equal(useApp.getState().streamId, 'pr2-stream');
  assert.equal(useApp.getState().conn, 'open');
  assert.deepEqual(writes, []);
});

await test('L1: local mode keeps using /api/v1/events for history and gaps', async () => {
  reset(false);
  const gets = recordGets();
  const stream = eventStream as unknown as Handle;
  await stream.handle(snapshotFrame('pr2-local', 3));
  await tick();
  await stream.handle(streamEvent('pr2-local', 7));
  await tick();
  assert.equal(gets.filter((p) => p.endsWith('/api/v1/events')).length, 2);
});

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(createElement(MemoryRouter, null, el));

await test('L2: public TopBar has no control-panel button, only a read-only label', () => {
  reset(true);
  const out = html(createElement(TopBar));
  assert.ok(out.includes('data-testid="topbar-readonly"'));
  assert.ok(!out.includes('data-testid="topbar-control"') && !out.includes('제어 패널 열기'));
  assert.ok(!out.includes('제어 패널에서 생성'));
});

await test('L2: local TopBar keeps the control-panel button', () => {
  reset(false);
  const out = html(createElement(TopBar));
  assert.ok(out.includes('data-testid="topbar-control"') && out.includes('제어 패널 열기'));
  assert.ok(!out.includes('data-testid="topbar-readonly"'));
});

await test('L2: public incident panel replaces 관제 제어 / 안내 전송 with a read-only note', () => {
  reset(true);
  const out = html(createElement(IncidentPanel, { highlightStart: null, onHighlightStart: () => {} }));
  assert.ok(out.includes('data-testid="incident-readonly"'));
  assert.ok(!out.includes('관제 제어</button>') && !out.includes('안내 전송</button>'));
  reset(false);
  const local = html(createElement(IncidentPanel, { highlightStart: null, onHighlightStart: () => {} }));
  assert.ok(local.includes('관제 제어') && !local.includes('data-testid="incident-readonly"'));
});

await test('L3: public screens show no token-requiring wording', () => {
  reset(true);
  const screens = [renderLab(), html(createElement(TopBar)), html(createElement(IncidentPanel, { highlightStart: null, onHighlightStart: () => {} }))];
  for (const out of screens) {
    for (const bad of ['토큰', '제어 패널에서 생성']) assert.ok(!out.includes(bad), `public wording contains "${bad}"`);
  }
  assert.ok(screens[0].includes('읽기 전용'));
  assert.equal(needToken(false), PUBLIC_READONLY_HINT);
  assert.equal(needToken(true), PUBLIC_READONLY_HINT);
  for (const step of labSteps(publicEnv())) assert.ok(!step.detail.includes('토큰'), step.detail);
});

await test('L3: local mode keeps the token guidance', () => {
  reset(false);
  assert.equal(needToken(false), '제어 토큰이 필요합니다');
  assert.equal(needToken(true), undefined);
  assert.ok(renderLab().includes('제어 토큰'));
});

/** labSteps 입력: 백엔드 연결·실험 비활성·토큰 없음(공개 환경의 실제 상태). */
function publicEnv() {
  return { hasToken: false, conn: 'open', labLog: [], timeline: [], deliveries: 0, scenarioCount: 0, scenario: null, network: null,
    experiment: { enabled: false, status: 'stopped', nodes: [] }, nodes: [], observed: false, reachable: 0, allOffline: false } as unknown as Parameters<typeof labSteps>[0];
}

setPublicDemoForTest(false);
setControlToken(null);
globalThis.fetch = originalFetch;
