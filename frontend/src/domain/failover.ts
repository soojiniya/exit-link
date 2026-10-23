import type { WsFaultObserved } from '@contracts';
import type { LabRecord } from '@/store/types';

/**
 * 가장 최근 장애 에피소드(노드 X)의 관측 단계.
 * 모든 단계는 실제 수신한 network.event(프로세스 로그 시각)와 이 탭의 제어 요청 기록에서만 만듭니다.
 */
export interface FailoverStep {
  key: 'inject' | 'suspect' | 'down' | 'reroute' | 'delivered' | 'restart' | 'recovered';
  title: string;
  at: string | null;
  by?: string;
  detail?: string;
  /** 같은 노드 프로세스 로그 시각 사이의 차이(ms). 서로 다른 시계(브라우저↔노드)는 비교하지 않습니다. */
  deltaMs?: number | null;
}

export interface FailoverEpisode {
  node: string;
  steps: FailoverStep[];
  previousRoute: string[] | null;
  newRoute: string[] | null;
}

type D = Record<string, unknown>;
const det = (e: WsFaultObserved) => (e.payload.details ?? {}) as D;
const ts = (e?: WsFaultObserved) => (e ? e.payload.timestamp : null);
const diff = (a: string | null, b: string | null) => (a && b ? Date.parse(b) - Date.parse(a) : null);

export function latestFailover(events: WsFaultObserved[], log: LabRecord[]): FailoverEpisode | null {
  // 마지막으로 suspect/down 판정을 받은 노드
  let node: string | null = null;
  let firstIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i].payload.event;
    if (ev === 'neighbor_suspect' || ev === 'neighbor_down') {
      node = String(det(events[i]).neighbor);
      break;
    }
  }
  const inject = [...log].reverse().find((r) => r.kind === 'node' && r.label === '노드 장애 주입' && r.ok);
  if (!node && inject?.target) node = inject.target;
  if (!node) return null;

  // 이 노드에 대한 마지막 장애 에피소드의 시작(직전 정상 이후 첫 suspect)
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const d = det(e);
    if (d.neighbor !== node) continue;
    if (e.payload.event === 'neighbor_suspect' || e.payload.event === 'neighbor_down') firstIdx = i;
    else if (firstIdx !== -1 && (e.payload.event === 'neighbor_up' || e.payload.event === 'neighbor_recovered')) break;
  }
  const after = firstIdx === -1 ? [] : events.slice(firstIdx);
  const suspect = after.find((e) => e.payload.event === 'neighbor_suspect' && det(e).neighbor === node);
  const down = after.find((e) => e.payload.event === 'neighbor_down' && det(e).neighbor === node);
  const reroute = down ? after.slice(after.indexOf(down)).find((e) => e.payload.event === 'route_selected' && Array.isArray(det(e).route) && !(det(e).route as string[]).includes(node!)) : undefined;
  const prevRouteEv = firstIdx === -1 ? undefined : [...events.slice(0, firstIdx)].reverse().find((e) => e.payload.event === 'route_selected' && Array.isArray(det(e).route) && (det(e).route as string[]).includes(node!));
  const msgId = reroute ? det(reroute).message_id : undefined;
  const result = msgId ? after.find((e) => e.payload.event === 'delivery_result' && det(e).message_id === msgId) : undefined;
  const restart = down ? after.slice(after.indexOf(down)).find((e) => e.payload.event === 'node_started' && e.payload.node_id === node) : undefined;
  const recovered = down ? after.slice(after.indexOf(down)).find((e) => e.payload.event === 'neighbor_recovered' && det(e).neighbor === node) : undefined;

  const steps: FailoverStep[] = [
    { key: 'inject', title: `${node} 장애 주입 요청`, at: inject && inject.target === node ? inject.at : null, by: '이 탭(브라우저 시각)', detail: inject && inject.target === node ? '프로세스 강제 종료' : '이 탭에서 요청한 기록 없음(외부 원인 또는 다른 탭)' },
    { key: 'suspect', title: 'Heartbeat 장애 의심', at: ts(suspect), by: suspect?.payload.node_id, detail: suspect ? `실패 ${String(det(suspect).failures)}회 · ${String(det(suspect).reason)}` : undefined },
    {
      key: 'down',
      title: '장애 확정',
      at: ts(down),
      by: down?.payload.node_id,
      detail: down ? `노드 보고 감지 시간 ${typeof det(down).detection_since_first_failure_ms === 'number' ? `${Math.round(det(down).detection_since_first_failure_ms as number)}ms` : '—'}` : undefined,
      deltaMs: diff(ts(suspect), ts(down)),
    },
    {
      key: 'reroute',
      title: '대체 경로 선택',
      at: ts(reroute),
      by: reroute?.payload.node_id,
      detail: reroute ? `${(det(reroute).route as string[]).join(' → ')} · 시도 ${String(det(reroute).attempt)}` : '장애 노드를 뺀 경로로 보낸 메시지 없음 — 안내를 전송하면 관측됩니다',
      deltaMs: diff(ts(down), ts(reroute)),
    },
    {
      key: 'delivered',
      title: '전달 결과',
      at: ts(result),
      by: result?.payload.node_id,
      detail: result ? `${det(result).success ? '성공' : '실패'} · 재시도 ${String(det(result).retries)} · ${typeof det(result).elapsed_ms === 'number' ? Math.round(det(result).elapsed_ms as number) : '—'}ms` : undefined,
    },
    { key: 'restart', title: `${node} 프로세스 재시작`, at: ts(restart), detail: restart ? `포트 ${String(det(restart).port)}` : undefined },
    { key: 'recovered', title: 'Heartbeat 복구 확인', at: ts(recovered), by: recovered?.payload.node_id, deltaMs: diff(ts(restart), ts(recovered)) },
  ];
  return {
    node,
    steps,
    previousRoute: prevRouteEv ? (det(prevRouteEv).route as string[]) : null,
    newRoute: reroute ? (det(reroute).route as string[]) : null,
  };
}
