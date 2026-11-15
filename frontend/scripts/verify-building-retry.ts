/** Unit fixtures for the building GET lifecycle; no backend or measured TCP data. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadBuilding } from '../src/realtime/socket';
import { useApp } from '../src/store/store';
import { setPublicDemoForTest } from '../src/domain/mode';

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function clock() {
  const timers = new Map<number, () => void>();
  let next = 1;
  globalThis.window = {
    setTimeout: (fn: () => void) => { const id = next++; timers.set(id, fn); return id; },
    clearTimeout: (id: number) => { timers.delete(id); },
  } as unknown as Window & typeof globalThis;
  return {
    pending: () => timers.size,
    fire: () => { const [id, fn] = timers.entries().next().value ?? []; assert.ok(fn); timers.delete(id); fn(); },
    restore: () => { globalThis.window = originalWindow; },
  };
}

async function withFixture(run: (timer: ReturnType<typeof clock>) => Promise<void>) {
  useApp.setState(useApp.getInitialState(), true);
  setPublicDemoForTest(false);
  const timer = clock();
  try { await run(timer); }
  finally { timer.restore(); globalThis.fetch = originalFetch; setPublicDemoForTest(false); }
}

const ok = (id: string) => new Response(JSON.stringify({ building_id: id }), { status: 200 });

await test('failed building GET retries and clears the error after recovery', () => withFixture(async (timer) => {
  let requests = 0;
  globalThis.fetch = async () => ++requests === 1 ? new Response('unavailable', { status: 503, statusText: 'Service Unavailable' }) : ok('recovered');
  const stop = loadBuilding();
  try {
    await flush();
    assert.equal(requests, 1);
    assert.equal(timer.pending(), 1);
    assert.ok(useApp.getState().buildingError);
    timer.fire();
    await flush();
    assert.equal(requests, 2);
    assert.equal((useApp.getState().building as { building_id: string }).building_id, 'recovered');
    assert.equal(useApp.getState().buildingError, null);
    assert.equal(timer.pending(), 0);
  } finally { stop(); }
}));

await test('repeated failures keep one timer, including a duplicate start', () => withFixture(async (timer) => {
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('offline'); };
  const stopFirst = loadBuilding();
  let stopSecond = () => {};
  try {
    await flush();
    assert.equal(timer.pending(), 1);
    timer.fire();
    await flush();
    assert.equal(timer.pending(), 1);
    stopSecond = loadBuilding();
    await flush();
    assert.equal(requests, 3);
    assert.equal(timer.pending(), 1);
    stopFirst(); // stale cleanup must not stop the new session
    assert.equal(timer.pending(), 1);
  } finally { stopSecond(); stopFirst(); }
  assert.equal(timer.pending(), 0);
}));

await test('leaving the screen aborts an in-flight request without another retry', () => withFixture(async (timer) => {
  let signal: AbortSignal | undefined;
  globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
    signal = init?.signal ?? undefined;
    signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
  const stop = loadBuilding();
  assert.ok(signal);
  stop();
  await flush();
  assert.equal(signal.aborted, true);
  assert.equal(timer.pending(), 0);
  assert.equal(useApp.getState().buildingError, null);
}));

await test('re-entering after a failed screen load starts one fresh GET', () => withFixture(async (timer) => {
  let requests = 0;
  globalThis.fetch = async () => ++requests === 1 ? new Response('unavailable', { status: 503 }) : ok('new-screen');
  const stopFirst = loadBuilding();
  await flush();
  assert.equal(timer.pending(), 1);
  stopFirst();
  assert.equal(timer.pending(), 0);
  const stopSecond = loadBuilding();
  try {
    await flush();
    assert.equal(requests, 2);
    assert.equal((useApp.getState().building as { building_id: string }).building_id, 'new-screen');
    assert.equal(timer.pending(), 0);
  } finally { stopSecond(); }
}));

await test('a late LIVE response cannot overwrite a new session after REPLAY', () => withFixture(async (timer) => {
  let resolveOld: (value: Response) => void = () => {};
  let requests = 0;
  globalThis.fetch = async () => ++requests === 1
    ? new Promise<Response>((resolve) => { resolveOld = resolve; }) // transport ignores abort: stale-result guard still applies
    : ok('fresh-live');
  const stopLive = loadBuilding();
  stopLive(); // route changed to REPLAY / CINEMATIC
  const stopFresh = loadBuilding(); // route returned to LIVE
  try {
    await flush();
    resolveOld(ok('stale-live'));
    await flush();
    assert.equal(requests, 2);
    assert.equal((useApp.getState().building as { building_id: string }).building_id, 'fresh-live');
    assert.equal(timer.pending(), 0);
  } finally { stopFresh(); }
}));

await test('public read-only mode uses GET and stops retries on route exit', () => withFixture(async (timer) => {
  setPublicDemoForTest(true);
  const methods: string[] = [];
  globalThis.fetch = async (_input, init) => {
    methods.push(init?.method ?? 'GET');
    throw new Error('offline');
  };
  const stop = loadBuilding();
  await flush();
  assert.deepEqual(methods, ['GET']);
  assert.equal(timer.pending(), 1);
  stop();
  assert.equal(timer.pending(), 0);
}));
