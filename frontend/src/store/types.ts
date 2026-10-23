import type {
  WsBackendSnapshot,
  WsDeliveryObserved,
  WsExperimentChanged,
  WsFaultObserved,
  WsGuidanceDelivery,
  WsNetworkChanged,
  WsRouteChanged,
  WsScenarioChanged,
} from '@contracts';

export type StreamEvent =
  | WsScenarioChanged
  | WsRouteChanged
  | WsNetworkChanged
  | WsFaultObserved
  | WsDeliveryObserved
  | WsExperimentChanged;

export type Snapshot = WsBackendSnapshot;
export type Delivery = WsGuidanceDelivery;

export type Origin = 'SIM' | 'LIVE' | 'CTRL';
export type Severity = 'info' | 'ok' | 'warn' | 'fail' | 'action';

/** 하단 타임라인 항목. 모든 항목은 실제 수신한 프레임에서 파생됩니다. */
export interface TimelineItem {
  id: string;
  sequence: number;
  /** 원본 시각: network.event는 프로세스 로그 시각, 나머지는 서버 발행 시각 */
  at: string;
  origin: Origin;
  severity: Severity;
  title: string;
  detail?: string;
  nodeIds?: string[];
  placeIds?: string[];
  route?: string[];
  kind: StreamEvent['type'];
}

export type FloorSel = 'ALL' | number;
export type Selection = { kind: 'node'; id: string } | { kind: 'place'; id: string } | null;

export type ConnStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'resyncing';

/** 프론트에서 실행한 제어 요청 기록(실험 단계 기록). 결과는 HTTP 응답 그대로입니다. */
export interface LabRecord {
  id: string;
  at: string; // 브라우저 요청 시각(ISO)
  kind: 'scenario' | 'hazard' | 'plan' | 'guidance' | 'experiment' | 'node' | 'network';
  label: string;
  target?: string;
  ok: boolean;
  status: number;
  code?: string;
  message?: string;
  summary?: string;
  /** HTTP 성공과 별개인 관측 결과(예: ACK·전송 성공 여부, 경로 없음) */
  observed?: 'good' | 'bad' | 'unknown';
  scenarioId?: string;
  messageId?: string;
}

/** experiment.changed 관측 기록(실험별 구간 계산용). at = 서버 발행 시각 */
export interface ExperimentMark { experimentId: string | null; status: string; at: string; sequence: number }
