import type { WsExperimentView, WsFaultObserved, WsNetworkView } from '@contracts';

/**
 * 노드·링크 상태 판정. 실제 관측 필드(reachable, 이웃이 보고한 status, 실험 running)만 사용합니다.
 * 판정 규칙은 설계 보고서 4절과 같습니다.
 */
export type NodeStatus = 'ok' | 'warn' | 'fail' | 'recovering' | 'unknown' | 'offline';

export interface NodeState {
  id: string;
  locationId: string;
  status: NodeStatus;
  reason: string;
  reachable: boolean | null;
  observedAt: string | null;
}

export const NODE_STATUS_LABEL: Record<NodeStatus, string> = {
  ok: '정상',
  warn: '장애 의심',
  fail: '장애',
  recovering: '복구 중',
  unknown: '미관측',
  offline: '미실행',
};

export const STATUS_COLOR: Record<NodeStatus, string> = {
  ok: '#3FB27F',
  warn: '#E08A3C',
  fail: '#E5484D',
  recovering: '#E08A3C',
  unknown: '#6B727C',
  offline: '#565C64',
};

export function nodeStates(
  net: WsNetworkView | null,
  exp: WsExperimentView | null,
  recoverRequested: Record<string, number>,
): NodeState[] {
  if (!net) return [];
  const views = new Map(net.nodes.map((n) => [n.node_id, n]));
  const anyReachable = net.nodes.some((n) => n.reachable);
  const expRunning = exp?.status === 'running';
  const owned = new Map((exp?.nodes ?? []).map((n) => [n.node_id, n]));

  return net.topology.nodes.map((t) => {
    const v = views.get(t.id);
    const base = { id: t.id, locationId: t.location_id, reachable: v ? v.reachable : null, observedAt: v?.observed_at ?? null };
    if (net.observation_status === 'not_observed' || !v) return { ...base, status: 'unknown' as const, reason: '아직 관측되지 않음' };

    const reports = net.nodes
      .filter((o) => o.node_id !== t.id && o.reachable)
      .flatMap((o) => o.neighbors.filter((nb) => nb.node_id === t.id).map((nb) => ({ by: o.node_id, s: nb.status })));
    const down = reports.filter((r) => r.s === 'down').map((r) => r.by);
    const suspect = reports.filter((r) => r.s === 'suspect').map((r) => r.by);
    const o = owned.get(t.id);

    if (expRunning && o && !o.running) return { ...base, status: 'fail' as const, reason: '실험 프로세스 종료됨' };
    if (recoverRequested[t.id] && !(v.reachable && reports.length > 0 && reports.every((r) => r.s === 'up')))
      return { ...base, status: 'recovering' as const, reason: '재시작 요청 후 Heartbeat 재확인 대기' };
    if (!v.reachable) {
      if (!anyReachable && !expRunning) return { ...base, status: 'offline' as const, reason: v.error ?? '노드 프로세스 미실행' };
      return { ...base, status: 'fail' as const, reason: v.error ?? 'TCP 연결 불가' };
    }
    if (down.length) return { ...base, status: 'fail' as const, reason: `${down.join(', ')}가 장애로 판정` };
    if (suspect.length) return { ...base, status: 'warn' as const, reason: `${suspect.join(', ')}가 장애 의심` };
    if (v.error) return { ...base, status: 'warn' as const, reason: v.error };
    return { ...base, status: 'ok' as const, reason: reports.length ? `이웃 ${reports.length}곳에서 up 보고` : 'TCP 응답 정상' };
  });
}

export type LinkStatus = 'ok' | 'warn' | 'fail' | 'unknown';
export interface LinkState { a: string; b: string; status: LinkStatus; detail: string }

export function linkStates(net: WsNetworkView | null, nodes: NodeState[]): LinkState[] {
  if (!net) return [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const view = (from: string, to: string) =>
    net.nodes.find((n) => n.node_id === from && n.reachable)?.neighbors.find((x) => x.node_id === to)?.status;
  return net.topology.edges.map(({ source: a, target: b }) => {
    const sa = view(a, b);
    const sb = view(b, a);
    const na = byId.get(a)?.status;
    const nb = byId.get(b)?.status;
    const detail = `${a}→${b}: ${sa ?? '—'} · ${b}→${a}: ${sb ?? '—'}`;
    if (na === 'fail' || nb === 'fail' || sa === 'down' || sb === 'down') return { a, b, status: 'fail', detail };
    if (sa === 'suspect' || sb === 'suspect' || na === 'recovering' || nb === 'recovering') return { a, b, status: 'warn', detail };
    if (sa === 'up' || sb === 'up') return { a, b, status: 'ok', detail };
    return { a, b, status: 'unknown', detail };
  });
}

// ── 메시지 흐름(경로 선택 → 송신 → 중계 → 수신 → ACK) ────────────────────
export type FlowStage = 'routing' | 'sending' | 'delivered' | 'acked' | 'failed';
export interface MessageFlow {
  messageId: string;
  source: string | null;
  destination: string | null;
  route: string[];
  attempt: number;
  /** 같은 메시지의 이전 시도 경로, 또는 같은 발신·수신 쌍의 직전 메시지 경로(서로 다를 때만) */
  previousRoute: string[] | null;
  previousReason: 'retry' | 'reroute' | null;
  stage: FlowStage;
  hops: string[]; // 실제로 sent/relayed/received가 관측된 노드
  startedAt: string;
  updatedAt: string;
}

type D = Record<string, unknown>;

export function messageFlows(events: WsFaultObserved[]): MessageFlow[] {
  const flows = new Map<string, MessageFlow & { routes: string[][] }>();
  for (const e of events) {
    const d = (e.payload.details ?? {}) as D;
    const id = typeof d.message_id === 'string' ? d.message_id : null;
    if (!id) continue;
    let f = flows.get(id);
    const ts = e.payload.timestamp;
    if (!f) {
      f = { messageId: id, source: null, destination: null, route: [], attempt: 0, previousRoute: null, previousReason: null, stage: 'routing', hops: [], startedAt: ts, updatedAt: ts, routes: [] };
      flows.set(id, f);
    }
    f.updatedAt = ts;
    if (typeof d.source === 'string') f.source = d.source;
    if (typeof d.destination === 'string') f.destination = d.destination;
    const route = Array.isArray(d.route) ? (d.route as string[]) : null;
    switch (e.payload.event) {
      case 'route_selected':
        if (route) {
          f.routes.push(route);
          f.route = route;
          f.attempt = Number(d.attempt) || f.routes.length;
          if (!f.source) f.source = route[0];
          if (!f.destination) f.destination = route.at(-1) ?? null;
        }
        if (f.stage !== 'acked') f.stage = 'sending';
        break;
      case 'send_attempt':
      case 'sent':
      case 'relayed':
        if (!f.hops.includes(e.payload.node_id)) f.hops.push(e.payload.node_id);
        if (f.stage === 'routing') f.stage = 'sending';
        break;
      case 'received':
      case 'guidance_applied':
      case 'guidance_stale':
      case 'guidance_duplicate':
      case 'guidance_version_conflict':
      case 'guidance_publisher_conflict':
        if (!f.hops.includes(e.payload.node_id)) f.hops.push(e.payload.node_id);
        if (f.stage !== 'acked' && f.stage !== 'failed') f.stage = 'delivered';
        break;
      case 'ack_received':
        if (e.payload.node_id === f.source || f.source === null) f.stage = 'acked';
        break;
      case 'delivery_result':
        f.stage = d.success ? 'acked' : 'failed';
        break;
      case 'delivery_failed':
        f.stage = 'failed';
        break;
    }
  }
  const list = [...flows.values()].filter((f) => f.route.length).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const lastByPair = new Map<string, string[]>();
  for (const f of list) {
    const key = `${f.source}>${f.destination}`;
    if (f.routes.length > 1) {
      const prev = f.routes.at(-2)!;
      if (prev.join() !== f.route.join()) {
        f.previousRoute = prev;
        f.previousReason = 'retry';
      }
    } else {
      const prev = lastByPair.get(key);
      if (prev && prev.join() !== f.route.join()) {
        f.previousRoute = prev;
        f.previousReason = 'reroute';
      }
    }
    lastByPair.set(key, f.route);
  }
  return list.map(({ routes: _r, ...f }) => f);
}
