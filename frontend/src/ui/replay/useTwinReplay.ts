import { useEffect, useMemo, useRef, useState } from 'react';
import type { LinkState, NodeState } from '@/domain/network';
import {
  linkViewsAt, loadManifest, loadReplayCase, messageProgressAt, nodeViewsAt, replayDuration, timelineMarks,
  type Manifest, type MessageProgress, type ReplayCase, type TimelineMark,
} from '@/domain/replayEngine';
import type { TwinReplayOverlay } from '@/three/ReplayNetworkLayer';
import { useReplayPlayback } from './useReplayPlayback';
import { captionAt, directorShot, keyRouteShot, pulsesAt, routeSweepAt } from './cinematicDirector';

/**
 * Digital Twin REPLAY 상태. Network Monitor REPLAY 와 같은 공통 엔진(replayEngine)·재생 시계(useReplayPlayback)를 씁니다.
 * enabled=false(LIVE)이면 아무것도 불러오지 않고 재생 루프도 돌지 않습니다.
 * 저장된 정적 JSON(public/replay)만 읽고, LIVE 스토어·API·WebSocket 은 쓰지 않습니다.
 */
/** 시연 장(chapter): 기록에 실제로 있는 이벤트 시각에만 만들어집니다. 기록이 없으면 t=null(비활성). */
export interface TwinChapter { key: string; label: string; t: number | null; tone: 'info' | 'fail' | 'warn' | 'ok' }

export function chaptersOf(c: ReplayCase, marks: TimelineMark[]): TwinChapter[] {
  const first = (k: TimelineMark['kind']) => marks.find((m) => m.kind === k)?.t ?? null;
  const reroute = first('reroute');
  const acks = marks.filter((m) => m.kind === 'ack');
  const ackAfter = reroute === null ? acks[0]?.t ?? null : acks.find((m) => m.t >= reroute)?.t ?? null;
  const anyFailed = c.messages.some((m) => m.result?.ack === false);
  const errors = marks.filter((m) => m.kind === 'error');
  const sendT = first('send');
  const faultT = first('fault');
  // '정상 통신'은 첫 장애 기록 전에 ACK 수신이 실제로 기록된 경우에만 씁니다.
  // (t010: 전송 전에 장애 기록 · t000: ACK 기록 없음 → '전송 시작')
  const firstAck = acks[0]?.t ?? null;
  const sendLabel = firstAck !== null && (faultT === null || firstAck < faultT) ? '정상 통신' : '전송 시작';
  const out: TwinChapter[] = [
    { key: 'send', label: sendLabel, t: sendT, tone: 'info' },
    { key: 'fault', label: '장애 발생', t: first('fault'), tone: 'fail' },
    { key: 'reroute', label: '우회 전달', t: reroute, tone: 'warn' },
    { key: 'ack', label: 'ACK 수신', t: ackAfter, tone: 'ok' },
  ];
  if (anyFailed) out.push({ key: 'failed', label: 'ACK 미수신', t: errors[errors.length - 1]?.t ?? null, tone: 'fail' });
  // 기록 시각 순서로 정렬(기록 없는 장은 뒤로)
  return out.sort((x, y) => (x.t ?? Infinity) - (y.t ?? Infinity));
}

/**
 * @param followKeyMessage CINEMATIC 전용: 메시지를 고르지 않았을 때 '가장 최근에 시작한 메시지' 대신
 *   '재생 위치 이전 마지막 기록 이벤트의 메시지'를 따라갑니다(캡션·카메라와 같은 메시지를 보여 주기 위함).
 *   REPLAY 는 Network Monitor 와 같은 규칙을 그대로 씁니다.
 */
export function useTwinReplay(enabled: boolean, initial?: { caseId?: string | null; t?: number | null }, followKeyMessage = false) {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [caseId, setCaseId] = useState('');
  const [trial, setTrial] = useState<ReplayCase | null>(null);
  const [problem, setProblem] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [focusOnly, setFocusOnly] = useState(false);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || manifest) return;
    const ctl = new AbortController();
    loadManifest(ctl.signal)
      .then((m) => { setManifest(m); setCaseId((c) => c || (m.cases.find((x) => x.id === initial?.caseId)?.id ?? m.cases[0]?.id ?? '')); })
      .catch((e: unknown) => { if (!ctl.signal.aborted) setProblem(`저장된 재생 목록을 확인할 수 없습니다: ${String(e)}`); });
    return () => ctl.abort();
  }, [enabled, manifest]);

  useEffect(() => {
    if (!enabled) return;
    const entry = manifest?.cases.find((c) => c.id === caseId);
    setTrial(null);
    setPicked(null);
    if (!entry) return;
    setProblem('');
    const ctl = new AbortController();
    loadReplayCase(entry, ctl.signal)
      .then(setTrial)
      .catch((e: unknown) => { if (!ctl.signal.aborted) setProblem(`기록을 불러오지 못했습니다: ${String(e)}`); });
    return () => ctl.abort();
  }, [enabled, manifest, caseId]);

  const duration = useMemo(() => (trial ? replayDuration(trial) : 1000), [trial]);
  const pb = useReplayPlayback(duration, 0.5);
  const resetRef = useRef(pb.reset);
  resetRef.current = pb.reset;
  // 사례가 바뀌면 처음으로. URL 로 시작 시각(t)이 주어졌으면 첫 사례에서 한 번만 그 시각으로 이동합니다.
  const seekRef = useRef(pb.seek);
  seekRef.current = pb.seek;
  const initialT = useRef(initial?.t ?? null);
  useEffect(() => {
    resetRef.current();
    if (trial && initialT.current !== null && trial.cell.cell === initial?.caseId) {
      const x = initialT.current;
      initialT.current = null;
      window.setTimeout(() => seekRef.current(x), 0);
    }
  }, [trial]); // eslint-disable-line react-hooks/exhaustive-deps
  // LIVE 로 돌아가면 재생을 멈춥니다(재생 루프 정리).
  useEffect(() => { if (!enabled) pb.setPlaying(false); }, [enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  const t = pb.t;
  const active = enabled && trial ? trial : null;
  const progress: MessageProgress[] = useMemo(() => (active ? active.messages.map((m) => messageProgressAt(active, m, t)) : []), [active, t]);
  const marks = useMemo(() => (active ? timelineMarks(active) : []), [active]);
  const nodes: NodeState[] = useMemo(
    () => (active ? nodeViewsAt(active, t).map((n) => ({ id: n.id, locationId: n.locationId, status: n.status, reason: n.reason, reachable: null, observedAt: null })) : []),
    [active, t],
  );
  const links: LinkState[] = useMemo(() => (active ? linkViewsAt(active, t).map(({ a, b, status, detail }) => ({ a, b, status, detail })) : []), [active, t]);
  // 선택하지 않았으면 재생 위치에서 가장 최근에 시작한 메시지를 따라갑니다(Network Monitor 와 같은 규칙).
  const started = active ? active.messages.filter((m) => (m.started_offset_ms ?? 0) <= t) : [];
  const lastMsgEvent = followKeyMessage && active ? [...active.events].reverse().find((e) => e.message_id && e.offset_ms <= t) : undefined;
  const sel =
    progress.find((p) => p.messageId === picked) ??
    (lastMsgEvent ? progress.find((p) => p.messageId === lastMsgEvent.message_id) : undefined) ??
    progress.find((p) => p.position === started[started.length - 1]?.position) ??
    progress[0];
  const selMsg = active?.messages.find((m) => m.message_id === sel?.messageId);

  const overlay: TwinReplayOverlay | undefined = useMemo(() => {
    if (!active || !sel) return undefined;
    return {
      topology: {
        nodes: (active.topology?.nodes ?? []).map((n) => ({ id: n.id, location_id: n.location_id ?? '' })),
        edges: (active.topology?.edges ?? []).filter((e) => e.length === 2) as [string, string][],
      },
      nodes,
      links,
      route: sel.route,
      previousRoute: sel.previousRoute,
      excludedLinks: sel.excludedLinks,
      legs: sel.legs,
      markers: progress
        .filter((p) => p.marker && (!focusOnly || p.messageId === sel.messageId))
        .map((p) => ({ ...p.marker!, label: `M${p.position}`, selected: p.messageId === sel.messageId })),
      selectedNode,
      onSelectNode: (id: string) => setSelectedNode((x) => (x === id ? null : id)),
      pulses: pulsesAt(active, t),
      stage: sel.stage,
      playing: pb.playing,
      sweep: routeSweepAt(active, t, sel.messageId),
    };
  }, [active, sel, nodes, links, progress, focusOnly, selectedNode, t, pb.playing]);

  // CINEMATIC 연출(기록 기반·읽기 전용): 카메라 샷과 캡션. 재생 시각·메시지 상태는 바꾸지 않습니다.
  const shot = useMemo(() => (active ? directorShot(active, t, sel ? { route: sel.route, previousRoute: sel.previousRoute } : null) : null), [active, t, sel]);
  const caption = useMemo(() => (active ? captionAt(active, t) : null), [active, t]);
  const keyShot = useMemo(() => (active ? keyRouteShot(active) : null), [active]);

  const keyMark = useMemo(() => {
    const k = marks.filter((m) => m.kind !== 'send' && m.t <= t);
    return k[k.length - 1] ?? null;
  }, [marks, t]);
  const chapters = useMemo(() => (active ? chaptersOf(active, marks) : []), [active, marks]);

  return {
    keyMark, chapters, shot, caption, keyShot,
    manifest, caseId, setCaseId, trial: active, problem, duration, pb, t, progress, marks, nodes, links,
    sel, selMsg, following: picked === null, setPicked, focusOnly, setFocusOnly, overlay, selectedNode, setSelectedNode,
  };
}
export type TwinReplayState = ReturnType<typeof useTwinReplay>;
