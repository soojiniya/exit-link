/**
 * Overview · 저장된 실험 사례 카드에 쓰는 사실값. 저장된 재생 기록(public/replay/*.json)에서만 계산합니다.
 * React·스토어·네트워크를 쓰지 않는 순수 함수이며 verify:replay 에서 그대로 검사합니다.
 */
import type { ManifestEntry, ReplayCase } from '../../domain/replayEngine';

export interface CaseFacts {
  id: string;
  title: string;
  description: string;
  method: 'Fixed' | 'EXIT-LINK';
  condition: string;
  /** 처음 선택된 경로(첫 메시지의 첫 route 기록) */
  firstRoute: string[] | null;
  /** route_changed 기록이 있으면: 바뀌기 전·후 경로와 제외 링크, 시각 */
  reroute: { from: string[] | null; to: string[]; excluded: string[][]; t: number } | null;
  /** fault_confirmed 기록(노드·시각) */
  faults: { node: string; t: number }[];
  acked: number;
  total: number;
  /** 결과 기록의 재전송 합계 */
  retries: number;
  /** ACK 받은 메시지의 측정 지연(client_elapsed_ms) */
  latencies: number[];
  /** ACK 미수신 메시지의 오류 코드 */
  errors: string[];
  /** 관측 구간 길이(ms) */
  windowMs: number | null;
}

export function caseFacts(entry: ManifestEntry, c: ReplayCase): CaseFacts {
  const rc = c.events.find((e) => e.event === 'route_changed');
  let from: string[] | null = null;
  if (rc) {
    const i = c.events.indexOf(rc);
    for (let j = i - 1; j >= 0; j--) {
      const x = c.events[j];
      if (x.message_id === rc.message_id && x.route && JSON.stringify(x.route) !== JSON.stringify(rc.route)) {
        from = x.route;
        break;
      }
    }
  }
  return {
    id: entry.id,
    title: entry.title,
    description: entry.description,
    method: c.cell.method === 'fixed' ? 'Fixed' : 'EXIT-LINK',
    condition: c.cell.condition + (c.cell.fault_timing && c.cell.fault_timing !== 'none' ? ` · ${c.cell.fault_timing}` : ''),
    firstRoute: c.events.find((e) => e.route)?.route ?? null,
    reroute: rc?.route ? { from, to: rc.route, excluded: rc.excluded_links ?? [], t: rc.offset_ms } : null,
    faults: c.events.filter((e) => e.event === 'fault_confirmed' && e.node).map((e) => ({ node: e.node!, t: e.offset_ms })),
    acked: c.messages.filter((m) => m.result?.ack === true).length,
    total: c.messages.length,
    retries: c.messages.reduce((s, m) => s + (m.result?.retries ?? 0), 0),
    latencies: c.messages.filter((m) => m.result?.ack && typeof m.result.client_elapsed_ms === 'number').map((m) => m.result!.client_elapsed_ms!),
    errors: c.messages.filter((m) => m.result?.ack === false).map((m) => m.result?.error ?? '기록 없음'),
    windowMs: c.clock.observation_end_offset_ms ?? null,
  };
}
