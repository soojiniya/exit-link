/**
 * CINEMATIC 연출 규칙(순수 함수). 모든 결과는 저장된 기록(ReplayCase)과 재생 위치 t(기록 시간 ms)로만 계산합니다.
 * - 카메라 샷: 어떤 노드를 한 화면에 담을지. 재생 시각·메시지 상태·로그 시각은 바꾸지 않습니다(읽기만 함).
 * - 캡션: 재생 위치 이전에 실제로 기록된 이벤트만 문구로 만듭니다. 기록이 없으면 null.
 * - 짧은 강조(펄스·경로 전환 빛): 기록된 이벤트 시각부터 정해진 기록 시간 동안만 진행률(0~1)을 냅니다.
 * React·스토어·네트워크를 쓰지 않으므로 verify:replay 에서 그대로 검사합니다.
 */
import { nodeViewsAt, type ReplayCase, type ReplayEvent } from '../../domain/replayEngine';

// ── 카메라 샷 ───────────────────────────────────────────────
export type ShotStyle = 'overview' | 'focus' | 'fault' | 'reroute' | 'failed';
export interface DirectorShot { key: string; style: ShotStyle; nodes: string[]; reason: string }

/** 장애 확인 직후 장애 노드를 보여 주는 기록 시간(ms) */
export const FAULT_SHOT_MS = 700;
/** 경로 변경 뒤, 우회 후 첫 ACK 가 없을 때 우회 구도를 유지하는 기록 시간(ms) */
export const REROUTE_SHOT_MS = 1500;
/** 우회 후 ACK 기록 뒤에도 잠시 우회 구도를 유지(ms) */
export const REROUTE_TAIL_MS = 900;

const uniq = (xs: (string | undefined | null)[]) => [...new Set(xs.filter((x): x is string => !!x))].sort();
const shot = (style: ShotStyle, nodes: string[], reason: string): DirectorShot => ({ key: `${style}:${nodes.join(',')}`, style, nodes, reason });

const isSourceAck = (c: ReplayCase, e: ReplayEvent) =>
  e.event === 'ack_received' && !!e.message_id && c.events.find((x) => x.message_id === e.message_id)?.node === e.node;

/** 메시지별로 route_changed 직전에 쓰던 경로(같은 메시지의 이전 이벤트 route) */
function routeBefore(c: ReplayCase, e: ReplayEvent): string[] | undefined {
  const i = c.events.indexOf(e);
  for (let j = i - 1; j >= 0; j--) {
    const x = c.events[j];
    if (x.message_id === e.message_id && x.route && JSON.stringify(x.route) !== JSON.stringify(e.route)) return x.route;
  }
  return undefined;
}

/** 현재 선택 메시지 경로(엔진 해석값) */
export interface ShotInput { route: string[] | null; previousRoute: string[] | null }

export function directorShot(c: ReplayCase, t: number, sel: ShotInput | null): DirectorShot {
  const past = c.events.filter((e) => e.offset_ms <= t);
  if (!past.length) return shot('overview', [], '첫 기록 이전: 건물 전체');
  const faults = nodeViewsAt(c, t).filter((n) => n.status === 'fail').map((n) => n.id);
  const edges = c.topology?.edges ?? [];
  const neighbors = (id: string) => edges.filter((e) => e.includes(id)).flat().filter((x) => x !== id);

  // 1) 경로 변경: 이전 경로와 새 경로, 장애 노드를 한 프레임에
  const rc = [...past].reverse().find((e) => e.event === 'route_changed');
  if (rc) {
    const ackAfter = c.events.find((e) => e.offset_ms >= rc.offset_ms && isSourceAck(c, e) && e.message_id === rc.message_id);
    const until = ackAfter ? ackAfter.offset_ms + REROUTE_TAIL_MS : rc.offset_ms + REROUTE_SHOT_MS;
    if (t <= until) return shot('reroute', uniq([...(routeBefore(c, rc) ?? []), ...(rc.route ?? []), ...faults]), `${rc.node} route_changed @${rc.offset_ms}`);
  }
  // 2) 장애 확인 직후: 장애 노드와 그 이웃(토폴로지 기록)
  const fc = [...past].reverse().find((e) => e.event === 'fault_confirmed');
  if (fc?.node && t - fc.offset_ms <= FAULT_SHOT_MS) return shot('fault', uniq([fc.node, ...neighbors(fc.node)]), `${fc.node} fault_confirmed @${fc.offset_ms}`);
  // 3) 모든 메시지가 끝났고 ACK 미수신 기록이 있으면: 시도한 경로 + 장애 노드
  const ended = c.messages.every((m) => {
    const last = c.events.filter((e) => e.message_id === m.message_id).at(-1);
    return last ? last.offset_ms <= t : false;
  });
  if (ended && c.messages.some((m) => m.result?.ack === false)) {
    const tried = c.events.filter((e) => e.route && e.offset_ms <= t).flatMap((e) => e.route ?? []);
    return shot('failed', uniq([...tried, ...faults]), '전송 종료 · ACK 미수신 기록');
  }
  // 4) 평상시: 선택 메시지의 현재(·직전) 경로 + 확인된 장애 노드
  if (sel?.route) return shot('focus', uniq([...sel.route, ...(sel.previousRoute ?? []), ...faults]), '선택 메시지 경로');
  return shot('overview', [], '경로 기록 없음: 건물 전체');
}

/** 발표자 '장애·우회 집중' 버튼: 사례 전체 기록에서 시도된 경로와 확인된 장애 노드 */
export function keyRouteShot(c: ReplayCase): DirectorShot {
  const tried = c.events.flatMap((e) => e.route ?? []);
  const faults = c.events.filter((e) => e.event === 'fault_confirmed').map((e) => e.node);
  const changed = c.events.some((e) => e.event === 'route_changed');
  return shot(changed || faults.length ? 'reroute' : 'focus', uniq([...tried, ...faults]), '사례 전체 기록의 경로·장애');
}

// ── 캡션 ───────────────────────────────────────────────────
export type CaptionTone = 'fail' | 'warn' | 'ok' | 'info';
export interface Caption {
  key: string;
  t: number;
  /** 영문 보조 라벨 */
  en: string;
  /** 한글 제목 */
  ko: string;
  /** 경로 등 보조 줄(기록 값) */
  route?: string[];
  oldRoute?: string[];
  detail: string;
  tone: CaptionTone;
  /** 중요도(글자 크기): 3 가장 큼 */
  weight: 1 | 2 | 3;
}

const pos = (c: ReplayCase, id?: string) => c.messages.find((m) => m.message_id === id)?.position;

/** 이벤트 하나 → 캡션(캡션 대상이 아니면 null). 문구는 이벤트 필드만 사용합니다. */
export function captionFor(c: ReplayCase, e: ReplayEvent): Caption | null {
  const p = pos(c, e.message_id);
  const tag = p === undefined ? '' : `M${p}`;
  const base = { key: `${e.seq}`, t: e.offset_ms };
  switch (e.event) {
    case 'fault_confirmed':
      return { ...base, en: `NODE ${e.node} — FAULT CONFIRMED`, ko: `${e.node} 장애 확인`, detail: 'fault_confirmed · trial 기록', tone: 'fail', weight: 3 };
    case 'neighbor_down':
      return { ...base, en: `NODE ${e.neighbor} — CONNECTION FAILURE`, ko: `${e.node} → ${e.neighbor} 연결 끊김 판정`, detail: `neighbor_down${e.reason ? ` · ${e.reason}` : ''}`, tone: 'fail', weight: 2 };
    case 'route_changed':
      return {
        ...base,
        en: 'ALTERNATIVE ROUTE SELECTED',
        ko: `${tag} 경로 변경 · 우회 경로 선택`,
        route: e.route,
        oldRoute: routeBefore(c, e),
        detail: `route_changed · 시도 ${e.attempt ?? '—'}${e.excluded_links?.length ? ` · 제외 ${e.excluded_links.map((l) => l.join('-')).join(', ')}` : ''}`,
        tone: 'warn',
        weight: 3,
      };
    case 'error': {
      const m = c.messages.find((x) => x.message_id === e.message_id);
      const lastErr = c.events.filter((x) => x.message_id === e.message_id && x.event === 'error').at(-1) === e;
      const retry = c.events.some((x) => x.message_id === e.message_id && x.event === 'retry_scheduled' && x.offset_ms >= e.offset_ms);
      if (m?.result?.ack === false && lastErr && !retry)
        return { ...base, en: 'TRANSMISSION FAILED', ko: `${tag} 전송 실패 · ACK 미수신`, route: e.route, detail: `error ${e.code ?? ''}${e.reason ? ` · ${e.reason}` : ''} · 결과 ack=false`, tone: 'fail', weight: 3 };
      return { ...base, en: retry ? 'CONNECTION FAILED — RETRY SCHEDULED' : 'CONNECTION FAILED', ko: `${tag} 연결 실패`, route: e.route, detail: `error ${e.code ?? ''}${e.reason ? ` · ${e.reason}` : ''}`, tone: 'fail', weight: 2 };
    }
    case 'ack_received': {
      if (!isSourceAck(c, e)) return null;
      const rerouted = c.events.some((x) => x.message_id === e.message_id && x.event === 'route_changed' && x.offset_ms <= e.offset_ms);
      return { ...base, en: 'ACK RECEIVED', ko: rerouted ? `${tag} ACK 수신 · 우회 전달 성공` : `${tag} ACK 수신`, route: e.route, detail: `ack_received · ${e.node} ← ${e.from_node ?? '—'}`, tone: 'ok', weight: rerouted ? 3 : 2 };
    }
    default:
      return null;
  }
}

/** 재생 위치 t 이전의 가장 최근 캡션 대상 이벤트 */
export function captionAt(c: ReplayCase, t: number): Caption | null {
  for (let i = c.events.length - 1; i >= 0; i--) {
    const e = c.events[i];
    if (e.offset_ms > t) continue;
    const cap = captionFor(c, e);
    if (cap) return cap;
  }
  return null;
}

// ── 짧은 강조 ───────────────────────────────────────────────
export type PulseKind = 'ack' | 'fault' | 'arrive';
/** 기록 시간 기준 지속(ms): 재생 속도·탐색과 항상 일치합니다. */
export const PULSE_MS: Record<PulseKind, number> = { ack: 520, fault: 1200, arrive: 380 };
export interface Pulse { node: string; kind: PulseKind; progress: number }

export function pulsesAt(c: ReplayCase, t: number): Pulse[] {
  const out: Pulse[] = [];
  for (const e of c.events) {
    if (e.offset_ms > t) break;
    if (!e.node) continue;
    const kind: PulseKind | null =
      e.event === 'fault_confirmed' ? 'fault' : isSourceAck(c, e) ? 'ack' : e.event === 'received' ? 'arrive' : null;
    if (!kind) continue;
    const age = t - e.offset_ms;
    if (age <= PULSE_MS[kind]) out.push({ node: e.node, kind, progress: age / PULSE_MS[kind] });
  }
  return out;
}

/** 경로 변경 순간 새 경로를 따라 흐르는 빛(경로 강조, 메시지 이동 아님). route_changed 기록 시각부터 SWEEP_MS 동안. */
export const SWEEP_MS = 650;
export function routeSweepAt(c: ReplayCase, t: number, messageId?: string): { route: string[]; progress: number } | null {
  for (let i = c.events.length - 1; i >= 0; i--) {
    const e = c.events[i];
    if (e.offset_ms > t) continue;
    if (t - e.offset_ms > SWEEP_MS) return null;
    if (e.event === 'route_changed' && e.route && (!messageId || e.message_id === messageId)) return { route: e.route, progress: (t - e.offset_ms) / SWEEP_MS };
  }
  return null;
}
