import { create } from 'zustand';
import type { BuildingView, WsExperimentView, WsFaultObserved, WsNetworkView, WsScenarioSnapshot } from '@contracts';
import type { ConnStatus, Delivery, ExperimentMark, FloorSel, LabRecord, Selection, Snapshot, StreamEvent, TimelineItem } from './types';
import { toTimeline } from './timeline';

const MAX_NET_EVENTS = 800;
const MAX_TIMELINE = 400;

export interface AppState {
  // 연결
  conn: ConnStatus;
  connError: string | null;
  lastFrameAt: number | null;
  streamId: string | null;
  sequence: number;
  // 백엔드 상태(실제 API/WS 값만 보관)
  building: BuildingView | null;
  buildingError: string | null;
  scenarios: Record<string, WsScenarioSnapshot>;
  scenarioOrder: string[];
  network: WsNetworkView | null;
  experiment: WsExperimentView | null;
  deliveries: Record<string, Delivery>;
  deliveryOrder: string[];
  netEvents: WsFaultObserved[];
  timeline: TimelineItem[];
  /** 프론트가 보낸 recover 요청 시각. Heartbeat 재확인 전까지 '복구 중'으로 표시합니다. */
  recoverRequested: Record<string, number>;
  /** 제어 요청 기록(이 탭 메모리) */
  labLog: LabRecord[];
  /** 수신한 experiment.changed 기록(서버 보관 창 + 이 연결 이후) */
  expMarks: ExperimentMark[];
  // UI
  activeScenarioId: string | null;
  floor: FloorSel;
  selection: Selection;
  hasToken: boolean;
  controlOpen: boolean;

  replaceSnapshot: (s: Snapshot) => void;
  /** 스냅샷 이전의 최근 이벤트(최대 512개)를 기록용으로만 반영합니다. 상태는 바꾸지 않습니다. */
  ingestHistory: (events: StreamEvent[]) => void;
  applyEvent: (e: StreamEvent) => void;
  setConn: (c: ConnStatus, err?: string | null) => void;
  setBuilding: (b: BuildingView | null, err?: string | null) => void;
  upsertScenario: (s: WsScenarioSnapshot) => void;
  upsertDelivery: (d: Delivery) => void;
  setExperiment: (e: WsExperimentView) => void;
  setNetwork: (n: WsNetworkView) => void;
  markRecover: (nodeId: string) => void;
  clearRecover: (nodeId: string) => void;
  setActiveScenario: (id: string | null) => void;
  setFloor: (f: FloorSel) => void;
  select: (s: Selection) => void;
  setHasToken: (v: boolean) => void;
  setControlOpen: (v: boolean) => void;
  pushLab: (r: LabRecord) => void;
}

const markOf = (e: StreamEvent): ExperimentMark => {
  const p = e.payload as { experiment_id: string | null; status: string };
  return { experimentId: p.experiment_id, status: p.status, at: e.timestamp, sequence: e.sequence };
};

function scenarioNewer(prev: WsScenarioSnapshot | undefined, next: WsScenarioSnapshot) {
  return !prev || next.state.revision >= prev.state.revision;
}

export const useApp = create<AppState>((set) => ({
  conn: 'idle',
  connError: null,
  lastFrameAt: null,
  streamId: null,
  sequence: 0,
  building: null,
  buildingError: null,
  scenarios: {},
  scenarioOrder: [],
  network: null,
  experiment: null,
  deliveries: {},
  deliveryOrder: [],
  netEvents: [],
  timeline: [],
  recoverRequested: {},
  labLog: [],
  expMarks: [],
  activeScenarioId: null,
  floor: 2,
  selection: null,
  hasToken: false,
  controlOpen: false,

  replaceSnapshot: (s) =>
    set((st) => {
      const scenarios: Record<string, WsScenarioSnapshot> = {};
      for (const sc of s.scenarios) scenarios[sc.state.scenario_id] = sc;
      const scenarioOrder = s.scenarios
        .slice()
        .sort((a, b) => a.state.created_at.localeCompare(b.state.created_at))
        .map((x) => x.state.scenario_id);
      const deliveries: Record<string, Delivery> = {};
      for (const d of s.deliveries) deliveries[d.message_id] = d;
      const sameStream = st.streamId === s.stream_id;
      const active = st.activeScenarioId && scenarios[st.activeScenarioId] ? st.activeScenarioId : scenarioOrder.at(-1) ?? null;
      return {
        streamId: s.stream_id,
        sequence: s.sequence,
        scenarios,
        scenarioOrder,
        network: s.network,
        experiment: s.experiment,
        deliveries,
        deliveryOrder: s.deliveries.map((d) => d.message_id),
        // 같은 스트림 재동기화면 이벤트 기록을 유지하고, 백엔드가 재시작했으면 비웁니다.
        netEvents: sameStream ? st.netEvents : [],
        timeline: sameStream ? st.timeline : [],
        recoverRequested: sameStream ? st.recoverRequested : {},
        expMarks: sameStream ? st.expMarks : [],
        activeScenarioId: active,
        lastFrameAt: Date.now(),
      };
    }),

  ingestHistory: (events) =>
    set((st) => {
      const known = new Set(st.timeline.map((t) => t.id));
      const fresh = events.filter((e) => e.stream_id === st.streamId && e.sequence <= st.sequence && !known.has(e.event_id));
      if (!fresh.length) return {};
      const net = fresh.filter((e): e is WsFaultObserved => e.type === 'network.event');
      const items = fresh.map(toTimeline).filter((x): x is TimelineItem => !!x);
      const netEvents = [...net, ...st.netEvents].sort((a, b) => a.sequence - b.sequence).slice(-MAX_NET_EVENTS);
      const timeline = [...items, ...st.timeline].sort((a, b) => a.sequence - b.sequence).slice(-MAX_TIMELINE);
      const marks = fresh.filter((e) => e.type === 'experiment.changed').map(markOf);
      const expMarks = [...marks, ...st.expMarks].sort((a, b) => a.sequence - b.sequence);
      return { netEvents, timeline, expMarks };
    }),

  applyEvent: (e) =>
    set((st) => {
      const patch: Partial<AppState> = { sequence: e.sequence, lastFrameAt: Date.now() };
      switch (e.type) {
        case 'scenario.changed': {
          const id = e.payload.state.scenario_id;
          if (scenarioNewer(st.scenarios[id], e.payload)) {
            patch.scenarios = { ...st.scenarios, [id]: e.payload };
            if (!st.scenarioOrder.includes(id)) {
              patch.scenarioOrder = [...st.scenarioOrder, id];
              patch.activeScenarioId = id; // 새 시나리오가 생기면 그 시나리오를 보여줍니다.
            }
          }
          break;
        }
        case 'route.changed': {
          const p = e.payload;
          const sc = st.scenarios[p.scenario_id];
          if (sc && p.scenario_revision === sc.state.revision) {
            const idx = sc.plans.findIndex((x) => x.start_location === p.start_location);
            // 오래된 route_version으로 새 경로를 덮어쓰지 않습니다.
            if (idx === -1 || sc.plans[idx].route_version <= p.route_version) {
              const plans = idx === -1 ? [...sc.plans, p] : sc.plans.map((x, i) => (i === idx ? p : x));
              patch.scenarios = { ...st.scenarios, [p.scenario_id]: { ...sc, plans } };
            }
          }
          break;
        }
        case 'network.changed':
          patch.network = e.payload;
          break;
        case 'network.event': {
          const next = [...st.netEvents, e];
          patch.netEvents = next.length > MAX_NET_EVENTS ? next.slice(-MAX_NET_EVENTS) : next;
          const ev = e.payload.event;
          const nb = (e.payload.details as Record<string, unknown>)?.neighbor;
          if ((ev === 'neighbor_up' || ev === 'neighbor_recovered') && typeof nb === 'string' && st.recoverRequested[nb]) {
            const rr = { ...st.recoverRequested };
            delete rr[nb];
            patch.recoverRequested = rr;
          }
          break;
        }
        case 'guidance.result': {
          const d = e.payload;
          patch.deliveries = { ...st.deliveries, [d.message_id]: d };
          if (!st.deliveryOrder.includes(d.message_id)) patch.deliveryOrder = [...st.deliveryOrder, d.message_id];
          break;
        }
        case 'experiment.changed':
          patch.experiment = e.payload;
          patch.expMarks = [...st.expMarks, markOf(e)];
          break;
      }
      const item = toTimeline(e);
      if (item) {
        const t = [...st.timeline, item];
        patch.timeline = t.length > MAX_TIMELINE ? t.slice(-MAX_TIMELINE) : t;
      }
      return patch;
    }),

  setConn: (conn, err = null) => set({ conn, connError: err }),
  setBuilding: (building, err = null) => set({ building, buildingError: err }),
  upsertScenario: (s) =>
    set((st) => {
      const id = s.state.scenario_id;
      if (!scenarioNewer(st.scenarios[id], s)) return {};
      return {
        scenarios: { ...st.scenarios, [id]: s },
        scenarioOrder: st.scenarioOrder.includes(id) ? st.scenarioOrder : [...st.scenarioOrder, id],
      };
    }),
  upsertDelivery: (d) =>
    set((st) => ({
      deliveries: { ...st.deliveries, [d.message_id]: d },
      deliveryOrder: st.deliveryOrder.includes(d.message_id) ? st.deliveryOrder : [...st.deliveryOrder, d.message_id],
    })),
  setExperiment: (experiment) => set({ experiment }),
  setNetwork: (network) => set({ network }),
  markRecover: (id) => set((st) => ({ recoverRequested: { ...st.recoverRequested, [id]: Date.now() } })),
  clearRecover: (id) => set((st) => {
    const recoverRequested = { ...st.recoverRequested };
    delete recoverRequested[id];
    return { recoverRequested };
  }),
  setActiveScenario: (activeScenarioId) => set({ activeScenarioId }),
  setFloor: (floor) => set({ floor }),
  select: (selection) => set({ selection }),
  setHasToken: (hasToken) => set({ hasToken }),
  setControlOpen: (controlOpen) => set({ controlOpen }),
  pushLab: (r) => set((st) => ({ labLog: [...st.labLog, r].slice(-200) })),
}));
