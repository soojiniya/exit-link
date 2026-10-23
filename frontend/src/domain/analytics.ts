import type { WsExperimentView, WsFaultObserved } from '@contracts';
import type { Delivery, ExperimentMark } from '@/store/types';
import type { MessageFlow } from './network';

/**
 * Analytics/Overview용 파생 지표. 입력은 모두 실제 API·WebSocket 값이며,
 * 표본이 없으면 null을 돌려 화면에서 "데이터 없음"으로 표시합니다(0으로 채우지 않음).
 */
export interface Stats { n: number; min: number; median: number; max: number; mean: number }

export function stats(values: number[]): Stats | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return { n: v.length, min: v[0], max: v[v.length - 1], median: v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2, mean: v.reduce((a, b) => a + b, 0) / v.length };
}

type D = Record<string, unknown>;
const det = (e: WsFaultObserved) => (e.payload.details ?? {}) as D;
const t = (iso: string) => Date.parse(iso);

// ── 장애 감지 ───────────────────────────────────────────
export interface DetectionSample { id: string; at: string; observer: string; target: string; ms: number }
/** neighbor_down 로그의 detection_since_first_failure_ms(노드가 직접 잰 값) */
export function detectionSamples(events: WsFaultObserved[]): DetectionSample[] {
  return events
    .filter((e) => e.payload.event === 'neighbor_down' && typeof det(e).detection_since_first_failure_ms === 'number')
    .map((e) => ({ id: e.event_id, at: e.payload.timestamp, observer: e.payload.node_id, target: String(det(e).neighbor), ms: det(e).detection_since_first_failure_ms as number }));
}

// ── 복구 ────────────────────────────────────────────────
export interface RecoverySample { id: string; node: string; startedAt: string; restartToConfirmMs: number; outageMs: number | null; confirmedBy: string }
/**
 * 장애 확정(neighbor_down) 뒤 재시작(node_started)한 노드에 대해
 * - 재시작 → 첫 복구 확인(neighbor_recovered/neighbor_up) 시간
 * - 첫 장애 의심 → 복구 확인 시간(관측된 통신 단절 구간)
 * 모두 노드 프로세스 로그 시각끼리의 차이입니다.
 */
export function recoverySamples(events: WsFaultObserved[]): RecoverySample[] {
  const out: RecoverySample[] = [];
  // Logs are tailed per process; publication sequence is not process-event time.
  const ordered = [...events].sort((a, b) => t(a.payload.timestamp) - t(b.payload.timestamp) || a.sequence - b.sequence);
  ordered.forEach((e, i) => {
    if (e.payload.event !== 'node_started') return;
    const node = e.payload.node_id;
    const before = ordered.slice(0, i);
    // A peer can report down before this node's very first startup. That is
    // startup convergence, not evidence of a restart after a running instance.
    if (!before.some((x) => x.payload.event === 'node_started' && x.payload.node_id === node)) return;
    const lastDown = [...before].reverse().find((x) => x.payload.event === 'neighbor_down' && det(x).neighbor === node);
    if (!lastDown) return; // 실험 최초 시작 등 장애 이후가 아닌 시작은 제외
    const lastUpBeforeDown = [...before].reverse().find((x) => (x.payload.event === 'neighbor_recovered' || x.payload.event === 'neighbor_up') && det(x).neighbor === node && t(x.payload.timestamp) > t(lastDown.payload.timestamp));
    if (lastUpBeforeDown) return; // 이미 복구가 확인된 에피소드
    let firstSuspect: WsFaultObserved | undefined;
    for (let k = before.indexOf(lastDown); k >= 0; k--) {
      const x = before[k];
      if (det(x).neighbor !== node) continue;
      if (x.payload.event === 'neighbor_recovered' || x.payload.event === 'neighbor_up') break;
      if (x.payload.event === 'neighbor_suspect' || x.payload.event === 'neighbor_down') firstSuspect = x;
    }
    const confirm = ordered.slice(i + 1).find((x) => (x.payload.event === 'neighbor_recovered' || x.payload.event === 'neighbor_up') && det(x).neighbor === node);
    if (!confirm) return;
    if (ordered.slice(i + 1).some((x) => x.payload.event === 'node_started' && x.payload.node_id === node && t(x.payload.timestamp) <= t(confirm.payload.timestamp))) return;
    out.push({
      id: e.event_id,
      node,
      startedAt: e.payload.timestamp,
      restartToConfirmMs: t(confirm.payload.timestamp) - t(e.payload.timestamp),
      outageMs: firstSuspect ? t(confirm.payload.timestamp) - t(firstSuspect.payload.timestamp) : null,
      confirmedBy: confirm.payload.node_id,
    });
  });
  return out;
}

// ── 전송 결과 ───────────────────────────────────────────
export type Outcome = 'ack' | 'no_ack' | 'transport_error';
export interface DeliveryRow {
  messageId: string;
  at: string;
  scenarioId: string;
  pair: string;
  outcome: Outcome;
  elapsedMs: number | null;
  retries: number | null;
  attempts: number | null;
  route: string[] | null;
  disposition: string | null;
  recoveryAfterFailureMs: number | null;
}

export function deliveryRows(list: Delivery[]): DeliveryRow[] {
  return list
    .map((d) => {
      const tr = d.transport_result;
      return {
        messageId: d.message_id,
        at: d.observed_at,
        scenarioId: d.scenario_id,
        pair: `${d.source_node}→${d.destination_node}`,
        outcome: (!tr ? 'transport_error' : d.ack_received && tr.success ? 'ack' : 'no_ack') as Outcome,
        elapsedMs: tr ? tr.elapsed_ms : null,
        retries: tr ? tr.retries : null,
        attempts: tr ? tr.attempts.length : null,
        route: tr?.attempts.at(-1)?.route ?? tr?.ack?.route ?? null,
        disposition: d.application_receipt?.disposition ?? (d.receipt_query_error ? 'query_error' : null),
        recoveryAfterFailureMs: tr?.recovery_after_first_failure_ms ?? null,
      };
    })
    .sort((a, b) => a.at.localeCompare(b.at));
}

// ── 노드별 장애 이벤트 ──────────────────────────────────
export interface NodeFaultRow { node: string; suspect: number; down: number; recovered: number; restarts: number }
/** 이웃 노드들이 이 노드를 판정한 보고 수(관측 노드마다 1건) */
export function nodeFaultRows(events: WsFaultObserved[], nodeIds: string[]): NodeFaultRow[] {
  const rows = new Map(nodeIds.map((n) => [n, { node: n, suspect: 0, down: 0, recovered: 0, restarts: 0 }]));
  for (const e of events) {
    const nb = det(e).neighbor;
    const r = typeof nb === 'string' ? rows.get(nb) : undefined;
    if (e.payload.event === 'neighbor_suspect' && r) r.suspect++;
    else if (e.payload.event === 'neighbor_down' && r) r.down++;
    else if (e.payload.event === 'neighbor_recovered' && r) r.recovered++;
    else if (e.payload.event === 'node_started') {
      const s = rows.get(e.payload.node_id);
      if (s) s.restarts++;
    }
  }
  return [...rows.values()];
}

// ── 실험별 구간 ─────────────────────────────────────────
export interface ExperimentWindow { id: string; from: string | null; to: string | null; current: boolean }

/** experiment.changed 기록으로 실험 ID별 [시작, 종료] 구간을 만듭니다. 기록 범위 밖의 시작은 null(미상). */
export function experimentWindows(marks: ExperimentMark[], current: WsExperimentView | null): ExperimentWindow[] {
  const map = new Map<string, ExperimentWindow>();
  for (const m of marks) {
    if (!m.experimentId) continue;
    let w = map.get(m.experimentId);
    if (!w) map.set(m.experimentId, (w = { id: m.experimentId, from: m.status === 'starting' || m.status === 'running' ? m.at : null, to: null, current: false }));
    if ((m.status === 'stopped' || m.status === 'failed') && !w.to) w.to = m.at;
  }
  if (current?.experiment_id) {
    const w = map.get(current.experiment_id) ?? { id: current.experiment_id, from: null, to: null, current: true };
    w.current = current.status === 'running' || current.status === 'starting';
    if (w.current) w.to = null;
    map.set(current.experiment_id, w);
  }
  return [...map.values()].sort((a, b) => (a.from ?? '').localeCompare(b.from ?? ''));
}

export function windowOf(at: string, windows: ExperimentWindow[]): string | null {
  const x = t(at);
  for (const w of windows) {
    const from = w.from ? t(w.from) : null;
    const to = w.to ? t(w.to) : Infinity;
    if (from === null) continue;
    if (x >= from && x <= to) return w.id;
  }
  return null;
}

export interface ExperimentRow {
  id: string;
  label: string;
  from: string | null;
  to: string | null;
  current: boolean;
  deliveries: number;
  acked: number;
  elapsed: Stats | null;
  retries: number | null;
  detection: Stats | null;
}

export function experimentRows(windows: ExperimentWindow[], rows: DeliveryRow[], detections: DetectionSample[]): ExperimentRow[] {
  const out: ExperimentRow[] = windows.map((w, i) => {
    const ds = rows.filter((r) => windowOf(r.at, windows) === w.id);
    const det = detections.filter((d) => windowOf(d.at, windows) === w.id);
    return {
      id: w.id,
      label: `실험 ${i + 1} · ${w.id.slice(0, 8)}`,
      from: w.from,
      to: w.to,
      current: w.current,
      deliveries: ds.length,
      acked: ds.filter((d) => d.outcome === 'ack').length,
      elapsed: stats(ds.map((d) => d.elapsedMs).filter((x): x is number => x !== null)),
      retries: ds.some((d) => d.retries !== null) ? ds.reduce((a, d) => a + (d.retries ?? 0), 0) : null,
      detection: stats(det.map((d) => d.ms)),
    };
  });
  const unknown = rows.filter((r) => windowOf(r.at, windows) === null);
  if (unknown.length) {
    out.push({
      id: 'unknown',
      label: '구간 미상',
      from: null,
      to: null,
      current: false,
      deliveries: unknown.length,
      acked: unknown.filter((d) => d.outcome === 'ack').length,
      elapsed: stats(unknown.map((d) => d.elapsedMs).filter((x): x is number => x !== null)),
      retries: unknown.some((d) => d.retries !== null) ? unknown.reduce((a, d) => a + (d.retries ?? 0), 0) : null,
      detection: null,
    });
  }
  return out;
}

// ── 경로 전환 ───────────────────────────────────────────
export interface RerouteRow { messageId: string; at: string; before: string[]; after: string[]; reason: 'retry' | 'reroute'; excluded: string[]; elapsedMs: number | null; attempts: number | null; stage: MessageFlow['stage'] }
export function rerouteRows(flows: MessageFlow[], rows: DeliveryRow[]): RerouteRow[] {
  const byId = new Map(rows.map((r) => [r.messageId, r]));
  return flows
    .filter((f) => f.previousRoute)
    .map((f) => ({
      messageId: f.messageId,
      at: f.startedAt,
      before: f.previousRoute!,
      after: f.route,
      reason: f.previousReason!,
      excluded: f.previousRoute!.filter((n) => !f.route.includes(n)),
      elapsedMs: byId.get(f.messageId)?.elapsedMs ?? null,
      attempts: byId.get(f.messageId)?.attempts ?? null,
      stage: f.stage,
    }));
}
