import type { WsFaultObserved } from '@contracts';

/** 한 메시지(message_id)의 실제 관측 이벤트를 시퀀스 다이어그램 행으로 변환합니다. */
export type TraceKind = 'route' | 'send' | 'relay' | 'deliver' | 'apply' | 'ack_send' | 'ack_recv' | 'result' | 'retry' | 'fail' | 'other';
export interface TraceRow {
  id: string;
  at: string;
  node: string;
  to?: string;
  kind: TraceKind;
  label: string;
  ok?: boolean;
}

type D = Record<string, unknown>;

export function messageTrace(events: WsFaultObserved[], messageId: string): { rows: TraceRow[]; lanes: string[] } {
  const evs = events.filter((e) => (e.payload.details as D)?.message_id === messageId);
  // 서로 다른 프로세스의 로그 시각은 수 ms 이내에서 앞뒤가 바뀔 수 있어, 15ms 이내 이벤트는 프로토콜 순서로 정렬합니다.
  // 표시하는 +ms 값은 각 이벤트의 실제 로그 시각 그대로입니다.
  const RANK: Record<string, number> = { route_selected: 0, send_attempt: 1, sent: 2, relayed: 3, received: 4, ack_sent: 6, ack_received: 7, delivery_result: 8 };
  const rank = (ev: string) => RANK[ev] ?? (ev.startsWith('guidance_') ? 5 : 9);
  const routeOf = evs.map((e) => (e.payload.details as D)?.route).find(Array.isArray) as string[] | undefined;
  const pos = (n: string) => routeOf?.indexOf(n) ?? 0;
  evs.sort((a, b) => {
    const t = Date.parse(a.payload.timestamp) - Date.parse(b.payload.timestamp);
    if (Math.abs(t) > 15) return t;
    const r = rank(a.payload.event) - rank(b.payload.event);
    if (r) return r;
    // 같은 종류면 송신·중계는 경로 앞쪽부터, ACK는 목적지 쪽부터
    const d = pos(a.payload.node_id) - pos(b.payload.node_id);
    return (a.payload.event.startsWith('ack') ? -d : d) || t;
  });
  let route: string[] = [];
  const rows: TraceRow[] = [];
  for (const e of evs) {
    const d = (e.payload.details ?? {}) as D;
    const n = e.payload.node_id;
    const base = { id: e.event_id, at: e.payload.timestamp, node: n };
    if (Array.isArray(d.route)) route = d.route as string[];
    const ev = e.payload.event;
    switch (ev) {
      case 'route_selected':
        rows.push({ ...base, kind: 'route', label: `경로 선택 ${(d.route as string[]).join('→')} · 시도 ${String(d.attempt)}` });
        break;
      case 'send_attempt':
        break; // sent와 같은 홉이라 다이어그램에서는 sent만 화살표로 그립니다.
      case 'sent':
        rows.push({ ...base, kind: 'send', to: String(d.next_node), label: `송신 TTL ${String(d.ttl)}` });
        break;
      case 'relayed':
        rows.push({ ...base, kind: 'relay', to: String(d.next_node), label: `중계 TTL ${String(d.ttl)}` });
        break;
      case 'received':
        rows.push({ ...base, kind: 'deliver', label: '수신' });
        break;
      case 'ack_sent': {
        const i = route.indexOf(n);
        rows.push({ ...base, kind: 'ack_send', to: i > 0 ? route[i - 1] : undefined, label: d.duplicate ? 'ACK 송신(중복)' : 'ACK 송신' });
        break;
      }
      case 'ack_received':
        rows.push({ ...base, kind: 'ack_recv', label: `ACK 수신 (${String(d.from_node)} 경유)`, ok: true });
        break;
      case 'delivery_result':
        rows.push({ ...base, kind: 'result', label: `전송 결과 ${d.success ? '성공' : '실패'} · 재시도 ${String(d.retries)}`, ok: !!d.success });
        break;
      case 'retry_scheduled':
        rows.push({ ...base, kind: 'retry', label: '재전송 예약' });
        break;
      case 'delivery_failed':
        rows.push({ ...base, kind: 'fail', label: '전송 실패', ok: false });
        break;
      default:
        if (ev.startsWith('guidance_')) rows.push({ ...base, kind: 'apply', label: `안내 ${ev.replace('guidance_', '')}`, ok: ev === 'guidance_applied' });
        else rows.push({ ...base, kind: 'other', label: ev });
    }
  }
  const lanes = [...route];
  for (const r of rows) {
    if (!lanes.includes(r.node)) lanes.push(r.node);
    if (r.to && !lanes.includes(r.to)) lanes.push(r.to);
  }
  return { rows, lanes };
}
