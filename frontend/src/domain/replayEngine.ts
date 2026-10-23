/**
 * REPLAY 공통 엔진: 저장된 실험 기록(public/replay/*.json)을 읽고, 재생 시각 t(ms)의 상태를 계산합니다.
 * /replay 화면과 Network Monitor의 REPLAY 모드가 같은 함수를 써서 같은 기록을 같은 방식으로 해석합니다.
 *
 * 원칙
 *  - 입력은 정적 JSON뿐입니다. 백엔드 API·WebSocket·전역 LIVE 스토어를 읽거나 바꾸지 않습니다.
 *  - 시간 축 t는 JSON의 offset_ms(benchmark_perf_ns 기준, 관측 구간 시작 = 0)입니다.
 *  - 상태는 기록된 이벤트로만 정합니다. 기록이 없으면 '기록 없음/미관측'입니다. 이벤트·경로·노드 상태를 새로 만들지 않습니다.
 *  - 메시지 마커의 링크 위 위치만 시각적 보간입니다(기록된 송신 이벤트와 다음 노드의 수신 이벤트 사이). 실제 위치 측정값이 아닙니다.
 */

export type ReplayEvent = {
  seq: number;
  offset_ms: number;
  node?: string;
  event: string;
  message_id?: string;
  route?: string[];
  next_node?: string;
  from_node?: string;
  attempt?: number;
  excluded_links?: string[][];
  neighbor?: string;
  status?: string;
  previous?: string;
  reason?: string;
  code?: string;
  detail?: string;
};
export type ReplayAttempt = { number: number; route: string[]; duration_ms: number; outcome: string };
export type ReplayMessage = {
  position: number;
  message_id?: string;
  started_offset_ms?: number;
  result?: {
    ack?: boolean;
    error?: string | null;
    route?: string[] | null;
    retries?: number;
    client_elapsed_ms?: number;
    delivered_observed?: boolean;
    destination_received_count?: number;
  };
  attempts?: ReplayAttempt[];
};
export type ReplayCase = {
  schema: 'exit-link-replay-v1';
  live: false;
  cell: { cell: string; method: string; condition: string; fault_timing?: string; valid: true; experiment_id?: string };
  clock: { basis: 'benchmark_perf_ns'; observation_end_offset_ms?: number };
  events: ReplayEvent[];
  messages: ReplayMessage[];
  provenance: { source_path?: string; source_cell?: string; trial_sha256: string; journal_sha256?: string; node_log_sha256?: Record<string, string> };
  topology?: { nodes: { id: string; location_id?: string }[]; edges: string[][] };
  not_recorded?: { scope: string; text: string }[];
};
export type ManifestEntry = { id: string; title: string; description: string; file: string };
export type Manifest = { schema: 'exit-link-replay-manifest-v1'; cases: ManifestEntry[] };

// ── 불러오기·검증 ─────────────────────────────────────────────────
export const isReplayCase = (data: unknown): data is ReplayCase => {
  if (!data || typeof data !== 'object') return false;
  const d = data as Partial<ReplayCase>;
  return d.schema === 'exit-link-replay-v1' && d.live === false && d.cell?.valid === true && d.clock?.basis === 'benchmark_perf_ns' && Array.isArray(d.events) && Array.isArray(d.messages) && !!d.provenance?.trial_sha256;
};
export const isManifest = (d: unknown): d is Manifest =>
  !!d && typeof d === 'object' && (d as Manifest).schema === 'exit-link-replay-manifest-v1' && Array.isArray((d as Manifest).cases);
/** public/replay 안의 허용된 파일명만 엽니다(원격 URL·경로 이동 차단). */
export const isSafeReplayFile = (file: string) => /^[a-zA-Z0-9_-]+\.json$/.test(file);
/** 이벤트가 시간순인지(같은 시각 허용) */
export const eventsSorted = (events: ReplayEvent[]) => events.every((e, i) => Number.isFinite(e.offset_ms) && (i === 0 || e.offset_ms >= events[i - 1].offset_ms));

export async function loadManifest(signal?: AbortSignal): Promise<Manifest> {
  const response = await fetch('/replay/manifest.json', { signal });
  if (!response.ok) throw new Error(`목록 요청 실패 (${response.status})`);
  const d: unknown = await response.json();
  if (!isManifest(d)) throw new Error('재생 목록 형식 오류');
  return d;
}

export async function loadReplayCase(entry: ManifestEntry, signal?: AbortSignal): Promise<ReplayCase> {
  if (!isSafeReplayFile(entry.file)) throw new Error('허용되지 않는 재생 파일명');
  const response = await fetch(`/replay/${entry.file}`, { signal });
  if (!response.ok) throw new Error(`기록 요청 실패 (${response.status})`);
  const d: unknown = await response.json();
  if (!isReplayCase(d)) throw new Error('원본 기반 재생 JSON 형식 오류');
  if (d.cell.cell !== entry.id) throw new Error('사례 ID 불일치');
  if (!eventsSorted(d.events)) throw new Error('이벤트 시간 정렬 오류');
  return d;
}

// ── 시간 범위 ─────────────────────────────────────────────────────
/** 재생 길이: 관측 구간 끝과 마지막 이벤트 중 큰 값(최소 1초) */
export const replayDuration = (c: ReplayCase) => Math.max(1000, c.clock.observation_end_offset_ms ?? 0, ...c.events.map((e) => e.offset_ms));
export const eventsUntil = (c: ReplayCase, t: number) => c.events.filter((e) => e.offset_ms <= t);

/** 가장 최근에 기록된 경로(이벤트의 route 필드). /replay 화면의 '선택된 경로'와 같은 규칙입니다. */
export function lastRecordedRoute(c: ReplayCase, t: number): string[] | undefined {
  const v = eventsUntil(c, t);
  for (let i = v.length - 1; i >= 0; i--) if (v[i].route?.length) return v[i].route;
  return undefined;
}

/** t까지 장애가 확인된 노드(trial.json의 fault_confirmed 기록) */
export const confirmedFaults = (c: ReplayCase, t: number) =>
  new Set(eventsUntil(c, t).filter((e) => e.event === 'fault_confirmed' && e.node).map((e) => e.node as string));

/** t까지 기록된 이웃 판정: `${관측 노드}>${이웃}` → up | suspect | down */
export function neighborViews(c: ReplayCase, t: number) {
  const m = new Map<string, string>();
  for (const e of c.events) {
    if (e.offset_ms > t) break;
    if (e.event.startsWith('neighbor_') && e.node && e.neighbor && e.status) m.set(`${e.node}>${e.neighbor}`, e.status);
  }
  return m;
}

// ── 노드·링크 상태 ─────────────────────────────────────────────────
export type ReplayNodeStatus = 'fail' | 'warn' | 'unknown';
export interface ReplayNodeView { id: string; locationId: string; status: ReplayNodeStatus; reason: string }

/**
 * 노드 상태: 장애 확인 기록 → fail(빨강), 다른 노드가 suspect/down으로 판정한 기록 → warn(주황),
 * 그 밖에는 기록된 노드 상태가 없으므로 unknown(미관측).
 */
export function nodeViewsAt(c: ReplayCase, t: number): ReplayNodeView[] {
  const faults = confirmedFaults(c, t);
  const views = neighborViews(c, t);
  return (c.topology?.nodes ?? []).map((n) => {
    if (faults.has(n.id)) return { id: n.id, locationId: n.location_id ?? '', status: 'fail', reason: '장애 주입 확인 기록(fault_confirmed)' };
    const judged = [...views.entries()].filter(([k, s]) => k.endsWith(`>${n.id}`) && (s === 'down' || s === 'suspect'));
    if (judged.length) return { id: n.id, locationId: n.location_id ?? '', status: 'warn', reason: `이웃 판정: ${judged.map(([k, s]) => `${k.split('>')[0]}→${s}`).join(', ')}` };
    return { id: n.id, locationId: n.location_id ?? '', status: 'unknown', reason: '기록된 노드 상태 없음' };
  });
}

export type ReplayLinkStatus = 'ok' | 'warn' | 'fail' | 'unknown';
export interface ReplayLinkView { a: string; b: string; status: ReplayLinkStatus; detail: string; ab?: string; ba?: string }

/** 링크 상태: 기록된 양방향 이웃 판정만 사용(Network Monitor LIVE 의 linkStates 와 같은 규칙) */
export function linkViewsAt(c: ReplayCase, t: number): ReplayLinkView[] {
  const views = neighborViews(c, t);
  return (c.topology?.edges ?? []).map(([a, b]) => {
    const ab = views.get(`${a}>${b}`);
    const ba = views.get(`${b}>${a}`);
    let status: ReplayLinkStatus = 'unknown';
    if (ab === 'down' || ba === 'down') status = 'fail';
    else if (ab === 'suspect' || ba === 'suspect') status = 'warn';
    else if (ab === 'up' && ba === 'up') status = 'ok';
    return { a, b, ab, ba, status, detail: `${a}→${b}: ${ab ?? '기록 없음'} · ${b}→${a}: ${ba ?? '기록 없음'}` };
  });
}

// ── 메시지 진행 ────────────────────────────────────────────────────
export type LegState = 'connecting' | 'inflight' | 'done' | 'failed';
export interface ReplayLeg { from: string; to: string; kind: 'data' | 'ack'; state: LegState }
export type MarkerKind = 'transit' | 'ack' | 'waiting' | 'connecting';
/** 메시지 마커. frac 은 from→to 링크 위 위치(0~1). transit/ack 의 frac 만 시각적 보간입니다. */
export interface ReplayMarker { messageId: string; position: number; from: string; to: string; frac: number; kind: MarkerKind; interpolated: boolean }
export type MessageStage = 'pending' | 'routing' | 'connecting' | 'sending' | 'waiting' | 'delivered' | 'retrying' | 'acked' | 'failed';
export const STAGE_LABEL: Record<MessageStage, string> = {
  pending: '전송 전', routing: '경로 선택', connecting: '연결 시도 중', sending: '전송 중', waiting: '중계 대기',
  delivered: '목적지 수신 · ACK 대기', retrying: '재전송 준비', acked: 'ACK 수신', failed: 'ACK 미수신 · 실패',
};
export const STAGE_COLOR: Record<MessageStage, string> = {
  pending: '#6B727C', routing: '#A3A9B1', connecting: '#E08A3C', sending: '#7CC8FF', waiting: '#7CC8FF',
  delivered: '#7CC8FF', retrying: '#E08A3C', acked: '#3FB27F', failed: '#E5484D',
};
export interface MessageProgress {
  messageId: string;
  position: number;
  stage: MessageStage;
  /** 현재 시도의 기록된 경로 */
  route: string[] | null;
  attempt: number;
  /** 경로 변경이 기록된 경우 직전 시도의 경로 */
  previousRoute: string[] | null;
  /** route_changed 에 기록된 제외 링크 */
  excludedLinks: [string, string][];
  legs: ReplayLeg[];
  marker: ReplayMarker | null;
  retryRecorded: boolean;
  ackRecorded: boolean;
  lastError: { code?: string; reason?: string; detail?: string } | null;
}

const ARRIVE = new Set(['relay_wait', 'received']);
const SEND = new Set(['sent', 'relayed']);

export const messageEvents = (c: ReplayCase, id: string) => c.events.filter((e) => e.message_id === id);

export function messageProgressAt(c: ReplayCase, m: ReplayMessage, t: number): MessageProgress {
  const id = m.message_id ?? '';
  const all = messageEvents(c, id);
  const past = all.filter((e) => e.offset_ms <= t);
  const src = all[0]?.node ?? m.attempts?.[0]?.route[0] ?? null;
  const base: MessageProgress = {
    messageId: id, position: m.position, stage: t < (m.started_offset_ms ?? 0) ? 'pending' : 'routing', route: null, attempt: 0,
    previousRoute: null, excludedLinks: [], legs: [], marker: null,
    retryRecorded: past.some((e) => e.event === 'retry_scheduled'), ackRecorded: false, lastError: null,
  };
  if (!past.length) return base;

  // 시도 경계: 발신 노드의 route_selected/route_changed. 없으면(Fixed) 첫 이벤트부터 한 시도.
  const starts = past.filter((e) => e.node === src && (e.event === 'route_selected' || e.event === 'route_changed'));
  const startEv = starts.length ? starts[starts.length - 1] : past[0];
  const attempt = starts.length ? Number(startEv.attempt ?? starts.length) : 1;
  const cur = past.filter((e) => e.seq >= startEv.seq);
  const route = startEv.route ?? cur.find((e) => e.route?.length)?.route ?? null;
  const prevStart = starts.length > 1 ? starts[starts.length - 2] : null;
  const changed = [...past].reverse().find((e) => e.event === 'route_changed');
  const excludedLinks = (changed?.excluded_links ?? []).filter((l) => l.length === 2) as [string, string][];

  // 데이터 구간: send_attempt → sent/relayed → 다음 노드 relay_wait/received
  const legs: ReplayLeg[] = [];
  for (const e of cur) {
    if (e.event !== 'send_attempt' || !e.node || !e.next_node) continue;
    const after = cur.filter((x) => x.seq > e.seq);
    const sent = after.find((x) => x.node === e.node && SEND.has(x.event));
    const arrived = after.find((x) => x.node === e.next_node && ARRIVE.has(x.event));
    const err = after.find((x) => x.node === e.node && x.event === 'error');
    let state: LegState = arrived ? 'done' : sent ? 'inflight' : 'connecting';
    if (!sent && err) state = 'failed';
    legs.push({ from: e.node, to: e.next_node, kind: 'data', state });
  }
  // ACK 구간: ack_sent(X) → 경로상 이전 노드의 ack_received(from_node = X)
  for (const e of cur) {
    if (e.event !== 'ack_sent' || !e.node || !route) continue;
    const i = route.indexOf(e.node);
    if (i <= 0) continue;
    const to = route[i - 1];
    const got = cur.find((x) => x.seq > e.seq && x.node === to && x.event === 'ack_received' && x.from_node === e.node);
    legs.push({ from: e.node, to, kind: 'ack', state: got ? 'done' : 'inflight' });
  }

  const ackAtSource = past.find((e) => e.node === src && e.event === 'ack_received');
  const errors = past.filter((e) => e.node === src && e.event === 'error');
  const lastErr = errors[errors.length - 1];
  const lastError = lastErr ? { code: lastErr.code, reason: lastErr.reason, detail: lastErr.detail } : null;
  // 기록 전체에서 이 오류 뒤에 재시도가 없으면 최종 오류입니다(기록된 결과와 일치하는지 함께 확인).
  const finalError = !!lastErr && !all.some((e) => e.seq > lastErr.seq && (e.event === 'retry_scheduled' || e.event === 'route_changed' || e.event === 'send_attempt')) && m.result?.ack === false;
  const last = past[past.length - 1];

  let stage: MessageStage = 'routing';
  if (ackAtSource) stage = 'acked';
  else if (finalError) stage = 'failed';
  else if (last.event === 'error' || last.event === 'retry_scheduled') stage = 'retrying';
  else if (cur.some((e) => e.event === 'received')) stage = 'delivered';
  else if (last.event === 'relay_wait') stage = 'waiting';
  else if (legs.some((l) => l.state === 'inflight')) stage = 'sending';
  else if (legs.some((l) => l.state === 'connecting')) stage = 'connecting';
  else if (legs.some((l) => l.state === 'done')) stage = 'sending';

  return {
    ...base,
    stage,
    route,
    attempt,
    previousRoute: prevStart?.route ?? null,
    excludedLinks,
    legs,
    marker: stage === 'acked' || stage === 'failed' ? null : markerAt(cur, all, t, m.position, id, route),
    ackRecorded: !!ackAtSource,
    lastError,
  };
}

/**
 * 메시지 마커 위치. 기록된 마지막 이벤트로 어느 링크/노드에 있는지 정하고,
 * 송신 이벤트와 다음 노드의 수신 이벤트 사이에서만 시각적으로 보간합니다.
 */
function markerAt(cur: ReplayEvent[], all: ReplayEvent[], t: number, position: number, id: string, route: string[] | null): ReplayMarker | null {
  const last = cur[cur.length - 1];
  if (!last || !last.node) return null;
  const mk = (from: string, to: string, frac: number, kind: MarkerKind, interpolated: boolean): ReplayMarker => ({ messageId: id, position, from, to, frac, kind, interpolated });
  const lerp = (t0: number, t1: number) => (t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 1);
  switch (last.event) {
    case 'send_attempt':
      return last.next_node ? mk(last.node, last.next_node, 0, 'connecting', false) : null;
    case 'sent':
    case 'relayed': {
      if (!last.next_node) return null;
      const arrive = all.find((x) => x.seq > last.seq && x.node === last.next_node && ARRIVE.has(x.event));
      return arrive ? mk(last.node, last.next_node, lerp(last.offset_ms, arrive.offset_ms), 'transit', true) : mk(last.node, last.next_node, 0, 'transit', false);
    }
    case 'relay_wait': {
      const i = route?.indexOf(last.node) ?? -1;
      const next = i >= 0 ? route![i + 1] : undefined;
      return next ? mk(last.node, next, 0, 'waiting', false) : null;
    }
    case 'ack_sent': {
      const i = route?.indexOf(last.node) ?? -1;
      if (i <= 0) return null;
      const to = route![i - 1];
      const got = all.find((x) => x.seq > last.seq && x.node === to && x.event === 'ack_received' && x.from_node === last.node);
      return got ? mk(last.node, to, lerp(last.offset_ms, got.offset_ms), 'ack', true) : mk(last.node, to, 0, 'ack', false);
    }
    default:
      return null;
  }
}

// ── 타임라인 마커 ──────────────────────────────────────────────────
export type TimelineKind = 'fault' | 'send' | 'ack' | 'error' | 'reroute' | 'retry';
export interface TimelineMark { t: number; kind: TimelineKind; label: string }
export function timelineMarks(c: ReplayCase): TimelineMark[] {
  const pos = new Map(c.messages.map((m) => [m.message_id, m.position]));
  const out: TimelineMark[] = [];
  for (const m of c.messages) if (m.started_offset_ms !== undefined) out.push({ t: m.started_offset_ms, kind: 'send', label: `메시지 ${m.position} 전송 시작` });
  for (const e of c.events) {
    const p = e.message_id ? pos.get(e.message_id) : undefined;
    if (e.event === 'fault_confirmed') out.push({ t: e.offset_ms, kind: 'fault', label: `${e.node} 장애 확인` });
    else if (p === undefined) continue;
    else if (e.event === 'ack_received' && e.node === messageSource(c, e.message_id!)) out.push({ t: e.offset_ms, kind: 'ack', label: `메시지 ${p} ACK 수신` });
    else if (e.event === 'error') out.push({ t: e.offset_ms, kind: 'error', label: `메시지 ${p} 오류 ${e.code ?? ''}` });
    else if (e.event === 'retry_scheduled') out.push({ t: e.offset_ms, kind: 'retry', label: `메시지 ${p} 재전송 예약` });
    else if (e.event === 'route_changed') out.push({ t: e.offset_ms, kind: 'reroute', label: `메시지 ${p} 경로 변경 → ${e.route?.join('→')}` });
  }
  return out.sort((a, b) => a.t - b.t);
}
export const messageSource = (c: ReplayCase, id: string) => c.events.find((e) => e.message_id === id)?.node;

/** 이벤트 한 줄 설명(기록 필드만 사용) */
export function describeEvent(c: ReplayCase, e: ReplayEvent): string {
  const p = c.messages.find((m) => m.message_id === e.message_id)?.position;
  const tag = p === undefined ? '' : `M${p} `;
  switch (e.event) {
    case 'fault_confirmed': return `${e.node} 장애 확인 (trial 기록)`;
    case 'route_selected': return `${tag}경로 선택 ${e.route?.join('→')} · 시도 ${e.attempt ?? '—'}`;
    case 'route_changed': return `${tag}경로 변경 ${e.route?.join('→')} · 시도 ${e.attempt ?? '—'} · 제외 ${(e.excluded_links ?? []).map((l) => l.join('-')).join(', ') || '—'}`;
    case 'send_attempt': return `${tag}${e.node} 송신 시도 → ${e.next_node}`;
    case 'sent': return `${tag}${e.node} 송신 → ${e.next_node}`;
    case 'relay_wait': return `${tag}${e.node} 수신 · 중계 대기`;
    case 'relayed': return `${tag}${e.node} 중계 → ${e.next_node}`;
    case 'received': return `${tag}${e.node} 목적지 수신`;
    case 'ack_sent': return `${tag}${e.node} ACK 송신`;
    case 'ack_received': return `${tag}${e.node} ACK 수신 (${e.from_node}에서)`;
    case 'delivery_result': return `${tag}${e.node} 전송 결과 기록`;
    case 'error': return `${tag}${e.node} 오류 ${e.code ?? ''}${e.reason ? ` (${e.reason})` : ''}${e.detail ? ` · ${e.detail}` : ''}`;
    case 'retry_scheduled': return `${tag}${e.node} 재전송 예약 · 시도 ${e.attempt ?? '—'}`;
    default:
      if (e.event.startsWith('neighbor_')) return `${e.node}가 본 ${e.neighbor}: ${e.previous ?? '—'} → ${e.status ?? '—'}${e.reason ? ` (${e.reason})` : ''}`;
      return `${e.node ?? ''} ${e.event}`;
  }
}
