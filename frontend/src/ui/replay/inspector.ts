import type { ReplayCase, ReplayEvent } from '@/domain/replayEngine';

/**
 * REPLAY Playback Inspector 표시 도우미(순수 함수).
 * 기록된 이벤트 타입을 한글 제목·분류·색으로 옮길 뿐, 시간·경로·상태 판단은 하지 않습니다(그것은 domain/replayEngine).
 * 기록에 없는 필드·이벤트는 만들지 않습니다.
 */
export type EventCategory = 'fault' | 'route' | 'message' | 'ack' | 'error' | 'other';
export type EventFilter = 'all' | Exclude<EventCategory, 'other'>;

export const FILTERS: { id: EventFilter; label: string }[] = [
  { id: 'all', label: '전체' },
  { id: 'fault', label: '장애' },
  { id: 'route', label: '경로' },
  { id: 'message', label: '메시지' },
  { id: 'ack', label: 'ACK' },
  { id: 'error', label: '오류' },
];

const CAT: Record<string, EventCategory> = {
  fault_confirmed: 'fault',
  route_selected: 'route',
  route_changed: 'route',
  send_attempt: 'message',
  sent: 'message',
  relay_wait: 'message',
  relayed: 'message',
  received: 'message',
  delivery_result: 'message',
  ack_sent: 'ack',
  ack_received: 'ack',
  error: 'error',
  retry_scheduled: 'error',
};
export const categoryOf = (e: ReplayEvent): EventCategory => CAT[e.event] ?? (e.event.startsWith('neighbor_') ? 'fault' : 'other');

const TITLE: Record<string, string> = {
  fault_confirmed: '장애 확인',
  route_selected: '경로 선택',
  route_changed: '경로 변경 · 우회',
  send_attempt: '연결·송신 시도',
  sent: '송신',
  relay_wait: '중계 노드 수신',
  relayed: '중계 송신',
  received: '목적지 수신',
  delivery_result: '전송 결과 기록',
  ack_sent: 'ACK 송신',
  ack_received: 'ACK 수신',
  error: '오류',
  retry_scheduled: '재전송 예약',
  neighbor_suspect: '이웃 의심(suspect) 판정',
  neighbor_down: '이웃 down 판정',
  neighbor_up: '이웃 up 판정',
};
export const titleOf = (e: ReplayEvent) => TITLE[e.event] ?? e.event;

/** 색: cyan/blue = 메시지·경로 · green = ACK · amber = 연결 시도·의심·재전송 · red = 확인된 장애·실패 */
export function colorOf(e: ReplayEvent): string {
  switch (e.event) {
    case 'fault_confirmed':
    case 'neighbor_down':
    case 'error':
      return '#EF5A5F';
    case 'neighbor_suspect':
    case 'retry_scheduled':
    case 'route_changed':
    case 'send_attempt':
      return '#E9954A';
    case 'ack_sent':
    case 'ack_received':
      return '#3FC28A';
    case 'neighbor_up':
      return '#3FC28A';
    default:
      return categoryOf(e) === 'other' ? '#8D98AB' : '#7CC8FF';
  }
}

/** 메시지 ID → M{position} (기록된 messages 의 position) */
export const messageTag = (c: ReplayCase, id?: string) => {
  if (!id) return null;
  const p = c.messages.find((m) => m.message_id === id)?.position;
  return p === undefined ? null : `M${p}`;
};

/** 같은 메시지의 직전 route_selected/route_changed 에 기록된 경로(경로 변경 전 경로 표시용) */
export function previousRecordedRoute(c: ReplayCase, e: ReplayEvent): string[] | null {
  if (!e.message_id) return null;
  const before = c.events.filter((x) => x.message_id === e.message_id && x.seq < e.seq && (x.event === 'route_selected' || x.event === 'route_changed') && x.route?.length);
  return before.length ? before[before.length - 1].route! : null;
}

/** 장애 점검(Failure Inspection) 항목: 장애·이웃 판정·오류·재전송·경로 변경 이벤트만 시간순으로 */
export const failureEvents = (c: ReplayCase) =>
  c.events.filter((e) => e.event === 'fault_confirmed' || e.event.startsWith('neighbor_') || e.event === 'error' || e.event === 'retry_scheduled' || e.event === 'route_changed');

export const fmtT = (ms: number) => `+${(ms / 1000).toFixed(3)}s`;
