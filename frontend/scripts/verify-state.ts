/** Unit fixtures only: these are never dashboard data or measured TCP results. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WsScenarioSnapshot } from '@contracts';
import { actions } from '../src/api/actions';
import { setControlToken } from '../src/api/client';
import { eventStream } from '../src/realtime/socket';
import { useApp } from '../src/store/store';
import type { Snapshot, StreamEvent } from '../src/store/types';
import { recoverySamples } from '../src/domain/analytics';
import type { WsFaultObserved } from '@contracts';

const timestamp = '2026-10-21T00:00:00Z';
const scenario: WsScenarioSnapshot = {
  schema_version: '1.0',
  state: { schema_version: '1.0', scenario_id: 'unit-scenario', building_id: 'unit-building', revision: 2,
    created_at: timestamp, updated_at: timestamp, hazards: { data_origin: 'simulation', fire_locations: [],
      dangerous_nodes: [], blocked_nodes: [], blocked_passages: [] }, data_origin: 'simulation', real_world_safety_verified: false },
  plans: [{ scenario_id: 'unit-scenario', building_id: 'unit-building', scenario_revision: 2, route_version: 2,
    start_location: 'F2_E', status: 'no_route', reason: 'no_available_exit', path: [], exit_id: null, distance_m: null,
    candidates: [], calculated_at: timestamp, algorithm: 'dijkstra', cost_unit: 'm_assumed', data_origin: 'simulation', real_world_safety_verified: false }],
  events: [],
};
const experiment = { enabled: true, experiment_id: 'unit-experiment', status: 'running',
  nodes: [{ node_id: 'N2', pid: 123, running: true }], last_error: null, observation_origin: 'real_process_control' };
const event = (type: string, payload: unknown, sequence = 1): StreamEvent => ({ type, payload, sequence,
  schema_version: '1.0', stream_id: 'unit-stream', event_id: `unit-${sequence}`, timestamp } as StreamEvent);
const originalFetch = globalThis.fetch;
function reset() {
  globalThis.fetch = originalFetch;
  useApp.setState(useApp.getInitialState(), true);
  useApp.setState({ streamId: 'unit-stream' });
  setControlToken('unit-test-token-' + 'x'.repeat(32));
}

await test('creation records actual HTTP 201 rather than a fabricated 200', async () => {
  reset();
  globalThis.fetch = async () => new Response(JSON.stringify(scenario), { status: 201 });
  assert.equal((await actions.createScenario(['F2_E'])).ok, true);
  assert.equal(useApp.getState().labLog.at(-1)?.status, 201);
});

await test('heartbeat arriving before recover HTTP response clears the pending marker', async () => {
  reset();
  globalThis.fetch = async () => {
    assert.ok(useApp.getState().recoverRequested.N2);
    useApp.getState().applyEvent(event('network.event', { timestamp, node_id: 'N1', event: 'neighbor_recovered',
      transport: 'tcp_loopback', observation_origin: 'real_process', details: { neighbor: 'N2' } }));
    return new Response(JSON.stringify(experiment), { status: 200 });
  };
  assert.equal((await actions.recoverNode('N2')).ok, true);
  assert.equal(useApp.getState().recoverRequested.N2, undefined);
});

await test('503 recovery remains a failure and does not leave a recovering marker', async () => {
  reset();
  globalThis.fetch = async () => new Response(JSON.stringify({ detail: { code: 'node_control_failed', message: 'unit bind conflict' } }), { status: 503 });
  const result = await actions.recoverNode('N2');
  assert.equal(result.ok, false);
  assert.equal(useApp.getState().recoverRequested.N2, undefined);
  assert.equal(useApp.getState().labLog.at(-1)?.status, 503);
});

await test('old scenario revision cannot overwrite a newer plan using a larger route version', () => {
  reset();
  useApp.getState().upsertScenario(scenario);
  useApp.getState().applyEvent(event('route.changed', { ...scenario.plans[0], scenario_revision: 1, route_version: 99 }));
  assert.equal(useApp.getState().scenarios['unit-scenario'].plans[0].route_version, 2);
});

await test('gap recovery across a server restart never applies an event from the old stream', async () => {
  reset();
  const snapshot = { stream_id: 'new-stream', sequence: 0, scenarios: [], deliveries: [], network: null,
    experiment: null } as unknown as Snapshot;
  globalThis.fetch = async (input) => new Response(JSON.stringify(String(input).includes('/events?')
    ? { reset_required: true, stream_id: 'new-stream', sequence: 0, events: [] } : snapshot), { status: 200 });
  // Exercise the stream handler without opening a real socket: TCP is tested separately.
  await (eventStream as unknown as { handle: (e: StreamEvent) => Promise<void> }).handle(event('scenario.changed', scenario, 5));
  assert.equal(useApp.getState().streamId, 'new-stream');
  assert.equal(useApp.getState().sequence, 0);
  assert.deepEqual(useApp.getState().scenarios, {});
});

await test('first startup after peer down is not fabricated as a restarted node', () => {
  const raw = (kind: string, node: string, at: number, neighbor?: string) => event('network.event', {
    event: kind, node_id: node, timestamp: `2026-10-21T00:00:0${at}Z`, details: { neighbor },
    transport: 'tcp_loopback', observation_origin: 'real_process',
  }, at) as WsFaultObserved;
  const initial = [raw('neighbor_down', 'N1', 1, 'N2'), raw('node_started', 'N2', 2), raw('neighbor_up', 'N1', 3, 'N2')];
  assert.equal(recoverySamples(initial).length, 0);
  const restarted = [...initial, raw('neighbor_down', 'N1', 4, 'N2'), raw('node_started', 'N2', 5), raw('neighbor_recovered', 'N1', 6, 'N2')];
  // Publication can be grouped by process instead of chronological event time.
  const samples = recoverySamples([restarted[5], restarted[4], restarted[3], ...initial]);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].restartToConfirmMs, 1000);
});

reset();
