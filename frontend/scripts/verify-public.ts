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

setPublicDemoForTest(false);
setControlToken(null);
globalThis.fetch = originalFetch;
