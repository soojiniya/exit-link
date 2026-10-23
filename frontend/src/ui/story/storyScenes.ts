import { describeEvent, messageSource, type ReplayCase, type ReplayEvent } from '@/domain/replayEngine';
import { captionFor, type CaptionTone } from '@/ui/replay/cinematicDirector';

/**
 * STORY 장면 정의(순수 함수). 장면마다 '한 사례'의 기록 구간 [t0, t1] 을 이벤트에서 계산합니다.
 * - 숫자를 코드에 적지 않습니다. 기록에 해당 이벤트가 없으면 장면은 null(화면에 '기록 없음').
 * - 서로 다른 사례의 이벤트를 한 구간에 섞지 않습니다(장면 = 사례 1개).
 * - 스크롤 진행도 p → 기록 시각 t 는 sceneTime() 하나로만 변환합니다(선형, 앞뒤 짧은 정지 구간).
 */
export type SceneKey = 'normal' | 'fault' | 'reroute' | 'ack';
export interface SceneWindow {
  key: SceneKey;
  caseId: string;
  t0: number;
  t1: number;
  /** 움직임 줄이기·모바일에서 보여 줄 정적 시점(구간 끝) */
  keyT: number;
  /** 토폴로지에 그릴 메시지: 고정(message_id) 또는 null = 재생 위치 이전 마지막 기록 이벤트의 메시지 */
  focus: string | null;
}

export const isSourceAck = (c: ReplayCase, e: ReplayEvent) => e.event === 'ack_received' && !!e.message_id && e.node === messageSource(c, e.message_id);
const lastSourceAck = (c: ReplayCase) => [...c.events].reverse().find((e) => isSourceAck(c, e)) ?? null;
/** 경로 변경이 기록된 메시지(우회 사례의 핵심 메시지) */
export const reroutedMessage = (c: ReplayCase) => c.events.find((e) => e.event === 'route_changed')?.message_id ?? null;

export function sceneWindows(cases: Record<string, ReplayCase>): Partial<Record<SceneKey, SceneWindow>> {
  const out: Partial<Record<SceneKey, SceneWindow>> = {};
  const a = cases.t012;
  const aEnd = a ? lastSourceAck(a) : null;
  if (a && aEnd) out.normal = { key: 'normal', caseId: 't012', t0: 0, t1: aEnd.offset_ms, keyT: aEnd.offset_ms, focus: null };

  const b = cases.t010;
  const m0 = b ? reroutedMessage(b) : null;
  if (b && m0) {
    const rc = b.events.find((e) => e.event === 'route_changed' && e.message_id === m0)!;
    const err = [...b.events].reverse().find((e) => e.event === 'error' && e.message_id === m0 && e.offset_ms <= rc.offset_ms) ?? null;
    const recv = b.events.find((e) => e.event === 'received' && e.message_id === m0 && e.offset_ms >= rc.offset_ms) ?? null;
    const end = lastSourceAck(b);
    if (err) out.fault = { key: 'fault', caseId: 't010', t0: 0, t1: err.offset_ms, keyT: err.offset_ms, focus: m0 };
    if (err && recv) out.reroute = { key: 'reroute', caseId: 't010', t0: err.offset_ms, t1: recv.offset_ms, keyT: recv.offset_ms, focus: m0 };
    if (recv && end && end.offset_ms > recv.offset_ms) out.ack = { key: 'ack', caseId: 't010', t0: recv.offset_ms, t1: end.offset_ms, keyT: end.offset_ms, focus: null };
  }
  return out;
}

/** 스크롤 진행도(0~1) → 기록 시각. 앞뒤 HOLD 구간에서는 시작·끝 상태에 머뭅니다. */
export const SCROLL_HOLD = 0.08;
export function sceneTime(w: SceneWindow, p: number) {
  const u = Math.min(1, Math.max(0, (p - SCROLL_HOLD) / (1 - 2 * SCROLL_HOLD)));
  return w.t0 + u * (w.t1 - w.t0);
}

/** 토폴로지에 그릴 메시지 id(포커스 고정 또는 재생 위치 이전 마지막 기록 이벤트의 메시지) */
export function focusMessage(c: ReplayCase, w: Pick<SceneWindow, 'focus'>, t: number) {
  if (w.focus) return w.focus;
  for (let i = c.events.length - 1; i >= 0; i--) {
    const e = c.events[i];
    if (e.offset_ms <= t && e.message_id) return e.message_id;
  }
  return c.messages[0]?.message_id ?? null;
}

export interface Beat { seq: number; t: number; ko: string; detail: string; tone: CaptionTone; route?: string[]; oldRoute?: string[] }
const tagOf = (c: ReplayCase, id?: string) => {
  const p = c.messages.find((m) => m.message_id === id)?.position;
  return p === undefined ? '' : `M${p} `;
};

/**
 * 장면의 '이야기 줄'(왼쪽 글): 구간 안의 기록 이벤트 중 캡션 대상(cinematicDirector.captionFor)과
 * 장면에 필요한 몇 가지(경로 선택·목적지 수신)만. 문구는 이벤트 필드로만 만듭니다.
 */
export function sceneBeats(c: ReplayCase, w: SceneWindow): Beat[] {
  const inWin = c.events.filter((e) => e.offset_ms >= w.t0 && e.offset_ms <= w.t1);
  const firstSelect = inWin.find((e) => e.event === 'route_selected' && (!w.focus || e.message_id === w.focus));
  const out: Beat[] = [];
  for (const e of inWin) {
    if (w.focus && e.message_id && e.message_id !== w.focus) continue;
    const cap = captionFor(c, e);
    if (cap) { out.push({ seq: e.seq, t: e.offset_ms, ko: cap.ko, detail: cap.detail, tone: cap.tone, route: cap.route, oldRoute: cap.oldRoute }); continue; }
    if (e === firstSelect) out.push({ seq: e.seq, t: e.offset_ms, ko: `${tagOf(c, e.message_id)}경로 선택 ${e.route?.join(' → ') ?? ''}`.trim(), detail: describeEvent(c, e), tone: 'info', route: e.route });
    else if (e.event === 'received' && w.key === 'reroute') out.push({ seq: e.seq, t: e.offset_ms, ko: `${tagOf(c, e.message_id)}목적지 ${e.node} 수신`, detail: describeEvent(c, e), tone: 'info', route: e.route });
  }
  return out;
}

/** ACK 도착 순서(출발 노드가 받은 ack_received 기록 시각 순) */
export function ackOrder(c: ReplayCase) {
  return c.messages
    .map((m) => ({ m, e: c.events.find((e) => isSourceAck(c, e) && e.message_id === m.message_id) ?? null }))
    .filter((x): x is { m: ReplayCase['messages'][number]; e: ReplayEvent } => x.e !== null)
    .sort((x, y) => x.e.offset_ms - y.e.offset_ms);
}

/** 경로 변경 직전 같은 메시지에 기록된 경로 */
export function routeBeforeChange(c: ReplayCase, messageId: string) {
  const rc = c.events.find((e) => e.event === 'route_changed' && e.message_id === messageId);
  if (!rc) return null;
  const before = c.events.filter((e) => e.message_id === messageId && e.seq < rc.seq && (e.event === 'route_selected' || e.event === 'route_changed') && e.route?.length);
  return before.length ? before[before.length - 1].route! : null;
}
