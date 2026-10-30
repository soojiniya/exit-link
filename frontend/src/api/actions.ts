import type { GuidanceSend, HazardUpdate, WsExperimentView, WsNetworkView, WsScenarioSnapshot } from '@contracts';
import { ApiRequestError, call, httpStatusOf } from './client';
import { useApp } from '@/store/store';
import type { Delivery, LabRecord } from '@/store/types';
import { explainError } from '@/domain/errors';

/**
 * 모든 제어 요청의 단일 진입점(관제 제어 패널·Simulation Lab 공용).
 * - 응답은 즉시 상태에 반영하고, 같은 변경은 WebSocket으로도 도착합니다(revision/sequence로 중복 처리).
 * - 409는 최신 시나리오를 다시 조회한 뒤 오류를 그대로 알립니다.
 * - 요청과 결과는 labLog(실험 단계 기록)에 남깁니다. 결과 요약은 응답 필드만 사용합니다.
 */
export type ActionResult<T> = { ok: true; data: T } | { ok: false; code: string; message: string; status: number };

type Meta = Pick<LabRecord, 'kind' | 'label' | 'target' | 'scenarioId'>;

const S = () => useApp.getState();
let seq = 0;

async function run<T>(meta: Meta, fn: () => Promise<T>, summarize?: (d: T) => Partial<LabRecord>, onConflict?: () => Promise<void>): Promise<ActionResult<T>> {
  const at = new Date().toISOString();
  const id = `lab-${Date.now()}-${++seq}`;
  try {
    const data = await fn();
    S().pushLab({ id, at, ok: true, status: httpStatusOf(data) ?? 0, ...meta, ...(summarize?.(data) ?? {}) });
    return { ok: true, data };
  } catch (e) {
    const err = e instanceof ApiRequestError ? e : new ApiRequestError(0, 'unknown', (e as Error).message);
    if (err.status === 409 && onConflict) await onConflict().catch(() => undefined);
    const message = explainError(err.code, err.message);
    S().pushLab({ id, at, ok: false, status: err.status, code: err.code, message, ...meta });
    return { ok: false, code: err.code, message, status: err.status };
  }
}

async function refreshScenario(id: string) {
  const origin = { streamId: S().streamId };
  const sc = await call('GET /api/v1/scenarios/{scenario_id}', { path: { scenario_id: id } });
  S().upsertScenario(sc as WsScenarioSnapshot, origin);
}

const planSummary = (sc: WsScenarioSnapshot) =>
  sc.plans.map((p) => (p.status === 'route_found' ? `${p.start_location}→${p.exit_id} ${p.distance_m}m` : `${p.start_location} 경로 없음`)).join(' · ');

const hazardText = (h?: HazardUpdate) =>
  [
    h?.fire_locations?.length ? `화재 ${h.fire_locations.join(',')}` : '',
    h?.dangerous_nodes?.length ? `위험 ${h.dangerous_nodes.join(',')}` : '',
    h?.blocked_nodes?.length ? `차단 ${h.blocked_nodes.join(',')}` : '',
    h?.blocked_passages?.length ? `통로 차단 ${h.blocked_passages.map((p) => `${p.source}–${p.target}`).join(',')}` : '',
  ]
    .filter(Boolean)
    .join(' · ') || '위험 없음';

export const actions = {
  createScenario: (starts: string[], hazards?: HazardUpdate, label = '시나리오 생성') =>
    run(
      { kind: 'scenario', label, target: `${starts.join(', ')} · ${hazardText(hazards)}` },
      async () => {
        const origin = { streamId: S().streamId };
        const sc = (await call('POST /api/v1/scenarios', { body: { starts, hazards } })) as WsScenarioSnapshot;
        S().upsertScenario(sc, origin);
        if (S().scenarios[sc.state.scenario_id]) S().setActiveScenario(sc.state.scenario_id);
        return sc;
      },
      (sc) => ({ scenarioId: sc.state.scenario_id, summary: `rev ${sc.state.revision} · ${planSummary(sc)}` }),
    ),

  replaceHazards: (scenarioId: string, expectedRevision: number, hazards: HazardUpdate) =>
    run(
      { kind: 'hazard', label: '위험 구역 교체', target: hazardText(hazards), scenarioId },
      async () => {
        const origin = { streamId: S().streamId };
        const sc = (await call('PUT /api/v1/scenarios/{scenario_id}/hazards', {
          path: { scenario_id: scenarioId },
          body: { expected_revision: expectedRevision, hazards },
        })) as WsScenarioSnapshot;
        S().upsertScenario(sc, origin);
        return sc;
      },
      (sc) => ({
        observed: sc.plans.some((p) => p.status === 'no_route') ? 'bad' : 'good',
        summary:
          sc.state.revision === expectedRevision
            ? `변경 없음(rev ${sc.state.revision} 유지) · ${planSummary(sc)}`
            : `rev ${expectedRevision}→${sc.state.revision} · 재계산: ${planSummary(sc)}`,
      }),
      () => refreshScenario(scenarioId),
    ),

  addPlan: (scenarioId: string, start: string) =>
    run(
      { kind: 'plan', label: '출발지 경로 계산', target: start, scenarioId },
      async () => {
        const p = await call('POST /api/v1/scenarios/{scenario_id}/plans', { path: { scenario_id: scenarioId }, body: { start_location: start } });
        await refreshScenario(scenarioId);
        return p;
      },
      (p) => ({ observed: p.status === 'route_found' ? 'good' : 'bad', summary: p.status === 'route_found' ? `${p.exit_id} · ${p.distance_m}m · ${(p.path ?? []).join('→')}` : `경로 없음(${p.reason})` }),
    ),

  sendGuidance: (scenarioId: string, body: GuidanceSend) =>
    run(
      { kind: 'guidance', label: '대피 안내 전송', target: `${body.start_location} · ${body.source_node}→${body.destination_node}`, scenarioId },
      async () => {
        const d = (await call('POST /api/v1/scenarios/{scenario_id}/guidance', { path: { scenario_id: scenarioId }, body })) as Delivery;
        S().upsertDelivery(d);
        return d;
      },
      (d) => ({
        messageId: d.message_id,
        observed: d.ack_received && d.transport_result?.success ? 'good' : 'bad',
        summary: [
          d.ack_received ? 'ACK 수신' : 'ACK 없음',
          d.transport_result ? `전송 ${d.transport_result.success ? '성공' : '실패'} · 시도 ${d.transport_result.attempts.length} · ${d.transport_result.attempts.map((a) => a.route.join('→')).join(' / ')}` : d.transport_error ?? '',
          d.application_receipt ? `적용 ${d.application_receipt.disposition}` : d.receipt_query_error ? '적용 미확인' : '',
        ]
          .filter(Boolean)
          .join(' · '),
      }),
      () => refreshScenario(scenarioId),
    ),

  startExperiment: () =>
    run({ kind: 'experiment', label: '실험 시작' }, async () => {
      const e = (await call('POST /api/v1/experiment')) as WsExperimentView;
      S().setExperiment(e);
      return e;
    }, (e) => ({ summary: `${e.status} · 노드 ${e.nodes.filter((n) => n.running).length}/${e.nodes.length}` })),

  stopExperiment: () =>
    run({ kind: 'experiment', label: '실험 종료' }, async () => {
      const e = (await call('DELETE /api/v1/experiment')) as WsExperimentView;
      S().setExperiment(e);
      return e;
    }, (e) => ({ summary: e.status })),

  failNode: (id: string) =>
    run({ kind: 'node', label: '노드 장애 주입', target: id }, async () => {
      const e = (await call('POST /api/v1/experiment/nodes/{node_id}/fail', { path: { node_id: id } })) as WsExperimentView;
      S().setExperiment(e);
      return e;
    }, () => ({ summary: '프로세스 강제 종료 요청 완료 — 장애 확정은 Heartbeat 이벤트로 별도 관측' })),

  recoverNode: (id: string) =>
    run({ kind: 'node', label: '노드 복구', target: id }, async () => {
      S().markRecover(id);
      try {
        const e = (await call('POST /api/v1/experiment/nodes/{node_id}/recover', { path: { node_id: id } })) as WsExperimentView;
        S().setExperiment(e);
        return e;
      } catch (error) {
        S().clearRecover(id);
        throw error;
      }
    }, (e) => ({ summary: `재시작 PID ${e.nodes.find((n) => n.node_id === id)?.pid ?? '—'} — Heartbeat 재확인 대기` })),

  refreshNetwork: () =>
    run({ kind: 'network', label: 'TCP 재관측' }, async () => {
      const n = (await call('POST /api/v1/network/refresh')) as WsNetworkView;
      S().setNetwork(n);
      return n;
    }, (n) => ({ summary: `${n.observation_status} · 응답 ${n.nodes.filter((x) => x.reachable).length}/${n.nodes.length}` })),
};
