import type { StreamEvent, TimelineItem } from './types';
import { dispositionLabel, ms, routeText } from '@/domain/format';

type D = Record<string, unknown>;
const s = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const arr = (v: unknown) => (Array.isArray(v) ? (v as unknown[]).map(String) : undefined);

/** 수신한 스트림 이벤트를 사람이 읽는 타임라인 항목으로 바꿉니다. network.changed(주기 관측)는 제외합니다. */
export function toTimeline(ev: StreamEvent): TimelineItem | null {
  const base = { id: ev.event_id, sequence: ev.sequence, kind: ev.type } as const;
  switch (ev.type) {
    case 'network.event': {
      const p = ev.payload;
      const d = (p.details ?? {}) as D;
      const n = p.node_id;
      const nb = s(d.neighbor);
      const route = arr(d.route);
      const common = { ...base, at: p.timestamp, origin: 'LIVE' as const };
      switch (p.event) {
        case 'neighbor_suspect':
          return { ...common, severity: 'warn', title: `${n} → ${nb} 장애 의심`, detail: `실패 ${s(d.failures)}회 · ${s(d.reason)}`, nodeIds: [nb, n] };
        case 'neighbor_down':
          return { ...common, severity: 'fail', title: `${n}가 ${nb} 장애 확정`, detail: `첫 실패 후 ${ms(d.detection_since_first_failure_ms)} · ${s(d.reason)}`, nodeIds: [nb, n] };
        case 'neighbor_up':
          return { ...common, severity: 'ok', title: `${n} → ${nb} 연결 확인`, detail: d.previous ? `이전 상태 ${s(d.previous)}` : undefined, nodeIds: [nb, n] };
        case 'neighbor_recovered':
          return { ...common, severity: 'ok', title: `${n}가 ${nb} 복구 확인`, detail: `이전 상태 ${s(d.previous)}`, nodeIds: [nb, n] };
        case 'node_started':
          return { ...common, severity: 'info', title: `${n} 프로세스 시작`, detail: `포트 ${s(d.port)} · PID ${s(d.pid)}`, nodeIds: [n] };
        case 'route_selected': {
          const ex = Array.isArray(d.excluded_links) ? (d.excluded_links as unknown[]).length : 0;
          return { ...common, severity: 'action', title: `통신 경로 선택 ${routeText(route)}`, detail: `시도 ${s(d.attempt)}회차 · 계산 ${ms(d.route_calculation_ms)}${ex ? ` · 제외 링크 ${ex}개` : ''}`, nodeIds: route, route };
        }
        case 'send_attempt':
        case 'sent':
          return { ...common, severity: 'info', title: `${n} 송신 → ${s(d.next_node)}`, detail: `TTL ${s(d.ttl)}`, nodeIds: [n, s(d.next_node)], route };
        case 'relayed':
          return { ...common, severity: 'info', title: `${n} 중계 → ${s(d.next_node)}`, detail: `TTL ${s(d.ttl)}`, nodeIds: [n, s(d.next_node)], route };
        case 'received':
          return { ...common, severity: 'ok', title: `${n} 메시지 수신`, detail: `${s(d.source)} 발신`, nodeIds: [n], route };
        case 'guidance_applied':
          return { ...common, severity: 'ok', title: `${n} 대피 안내 적용`, nodeIds: [n], route };
        case 'guidance_stale':
        case 'guidance_duplicate':
        case 'guidance_version_conflict':
        case 'guidance_publisher_conflict': {
          const disp = p.event.replace('guidance_', '') as 'stale' | 'duplicate' | 'version_conflict' | 'publisher_conflict';
          return { ...common, severity: 'warn', title: `${n} 안내 미적용 · ${dispositionLabel(disp)}`, nodeIds: [n], route };
        }
        case 'retry_scheduled':
          return { ...common, severity: 'warn', title: `${n} 재전송 예약`, detail: d.attempt ? `다음 시도 ${s(d.attempt)}` : undefined, nodeIds: [n], route };
        case 'delivery_failed':
          return { ...common, severity: 'fail', title: `${n} 전송 실패`, detail: s(d.code || d.reason || d.detail), nodeIds: [n], route };
        case 'duplicate':
        case 'duplicate_pending':
          return { ...common, severity: 'info', title: `${n} 중복 메시지 수신`, nodeIds: [n], route };
        case 'relay_wait':
          return { ...common, severity: 'info', title: `${n} 중계 대기`, detail: `${s(d.configured_delay_s)}s`, nodeIds: [n], route };
        case 'error':
          return { ...common, severity: 'fail', title: `${n} 오류 ${s(d.code)}`, detail: s(d.detail), nodeIds: [n] };
        case 'connection_closed':
          return { ...common, severity: 'info', title: `${n} 연결 종료`, detail: s(d.reason), nodeIds: [n] };
        case 'node_stopped':
        case 'shutdown_requested':
          return { ...common, severity: 'warn', title: `${n} 프로세스 종료`, nodeIds: [n] };
        case 'ack_sent':
          return { ...common, severity: 'info', title: `${n} ACK 송신`, detail: d.duplicate ? '중복 메시지' : undefined, nodeIds: [n] };
        case 'ack_received':
          return { ...common, severity: 'ok', title: `${n} ACK 수신`, detail: `${s(d.from_node)} 경유`, nodeIds: [n], route };
        case 'delivery_result':
          return {
            ...common,
            severity: d.success ? 'ok' : 'fail',
            title: d.success ? '전송 결과: 성공' : '전송 결과: 실패',
            detail: `재시도 ${s(d.retries)} · 소요 ${ms(d.elapsed_ms)}`,
            nodeIds: [n],
          };
        default:
          return { ...common, severity: 'info', title: `${n} ${p.event}` };
      }
    }
    case 'route.changed': {
      const p = ev.payload;
      const ok = p.status === 'route_found';
      return {
        ...base,
        at: ev.timestamp,
        origin: 'SIM',
        severity: ok ? 'ok' : 'fail',
        title: ok ? `대피 경로 갱신 ${p.start_location} → ${p.exit_id}` : `대피 경로 없음 · ${p.start_location}`,
        detail: ok ? `${p.distance_m}m(가정) · 경로 v${p.route_version}` : `사유 ${p.reason} · 경로 v${p.route_version}`,
        placeIds: p.path.length ? p.path : [p.start_location],
      };
    }
    case 'scenario.changed': {
      const h = ev.payload.state.hazards;
      const parts = [
        h.fire_locations.length ? `화재 ${h.fire_locations.join(', ')}` : '',
        h.dangerous_nodes.length ? `위험 ${h.dangerous_nodes.join(', ')}` : '',
        h.blocked_nodes.length ? `차단 ${h.blocked_nodes.join(', ')}` : '',
        h.blocked_passages.length ? `통로 차단 ${h.blocked_passages.length}` : '',
      ].filter(Boolean);
      return {
        ...base,
        at: ev.timestamp,
        origin: 'SIM',
        severity: h.fire_locations.length ? 'fail' : 'info',
        title: `시나리오 rev ${ev.payload.state.revision} 상태 변경`,
        detail: parts.join(' · ') || '위험 구역 없음',
        placeIds: [...h.fire_locations, ...h.dangerous_nodes, ...h.blocked_nodes],
      };
    }
    case 'guidance.result': {
      const p = ev.payload;
      const tr = p.transport_result;
      return {
        ...base,
        at: p.observed_at,
        origin: 'LIVE',
        severity: p.ack_received ? 'ok' : 'fail',
        title: `안내 전송 ${p.source_node} → ${p.destination_node}: ${p.ack_received ? 'ACK 수신' : 'ACK 없음'}`,
        detail: [
          p.application_receipt ? `적용 상태 ${dispositionLabel(p.application_receipt.disposition)}` : p.receipt_query_error ? '적용 상태 미확인' : null,
          tr ? `재시도 ${tr.retries} · ${ms(tr.elapsed_ms)}` : p.transport_error,
        ]
          .filter(Boolean)
          .join(' · '),
        nodeIds: [p.source_node, p.destination_node],
        route: tr?.ack?.route,
      };
    }
    case 'experiment.changed': {
      const p = ev.payload;
      return {
        ...base,
        at: ev.timestamp,
        origin: 'CTRL',
        severity: p.status === 'failed' ? 'fail' : 'info',
        title: `실험 상태: ${p.status}`,
        detail: p.last_error ?? (p.nodes.length ? `소유 노드 ${p.nodes.filter((x) => x.running).length}/${p.nodes.length} 실행 중` : undefined),
      };
    }
    default:
      return null;
  }
}
