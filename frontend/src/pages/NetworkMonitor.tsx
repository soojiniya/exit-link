import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronDown, ChevronUp, Lock, PanelBottomClose, PanelBottomOpen, PanelRightClose, PanelRightOpen, RefreshCw } from 'lucide-react';
import type { Place } from '@contracts';
import { useApp } from '@/store/store';
import { useNetworkDerived } from '@/store/selectors';
import { actions } from '@/api/actions';
import { NODE_STATUS_LABEL, STATUS_COLOR, type NodeStatus } from '@/domain/network';
import { ago, timeOf } from '@/domain/format';
import { TopologyFlow } from '@/ui/network/TopologyFlow';
import { NodeDetail } from '@/ui/network/NodeDetail';
import { FlowList, MessageHeader, RouteCompare, SequenceDiagram, StageTag } from '@/ui/network/MessagePanel';
import { Dot, Empty, SourceBadge, cx } from '@/ui/primitives';
import { FeedbackLine, needToken, useAction } from '@/ui/lab/useAction';
import { useNow } from '@/ui/TopBar';
import { ReplayMonitor } from '@/ui/network/ReplayMonitor';
import { FocusToggle, LegendCard, useBarBottom, useEscapeToExit } from '@/ui/network/NetworkHud';
import { HudTile } from '@/ui/twin/HudTile';
import { WIDE_QUERY, asideInnerClass, asideShellClass, matches, useMediaQuery } from '@/ui/useMediaQuery';
import { PUBLIC_READONLY_HINT, isPublicDemo } from '@/domain/mode';

const LEGEND: [string, string][] = [
  ['정상(up)', '#3FB27F'],
  ['장애 의심(suspect)', '#E08A3C'],
  ['장애(down)', '#E5484D'],
  ['미관측', '#6B727C'],
  ['현재 메시지 경로', '#7CC8FF'],
];

/** LIVE / REPLAY 전환. 기본은 LIVE 이며, REPLAY 는 저장된 실험 기록만 재생합니다(?mode=replay). */
function ModeSwitch({ mode, onChange }: { mode: 'live' | 'replay'; onChange: (m: 'live' | 'replay') => void }) {
  return (
    <div className="seg" role="tablist" aria-label="Network Monitor 모드">
      <button role="tab" aria-selected={mode === 'live'} onClick={() => onChange('live')} title="실제 TCP 노드 실시간 관측">LIVE</button>
      <button role="tab" aria-selected={mode === 'replay'} onClick={() => onChange('replay')} title="저장된 실험 기록 재생(실시간 아님)">REPLAY</button>
    </div>
  );
}

/**
 * Network Monitor — 2D 네트워크 관제 화면.
 * - 모드: LIVE(실제 TCP 관측) · REPLAY(저장된 기록 재생, ?mode=replay[&case=t010])
 * - 화면 표시 옵션: FOCUS(?view=focus) — 보조 패널을 접고 토폴로지·현재 이벤트만 크게. 모드·데이터와 무관하며 Esc 로 해제.
 */
export default function NetworkMonitor() {
  const [params, setParams] = useSearchParams();
  const mode: 'live' | 'replay' = params.get('mode') === 'replay' ? 'replay' : 'live';
  const focus = params.get('view') === 'focus';
  const building = useApp((s) => s.building);
  const places = useMemo(() => new Map<string, Place>((building?.building.nodes ?? []).map((n) => [n.id, n])), [building]);
  const go = useCallback(
    (m: 'live' | 'replay', f: boolean) => {
      const next: Record<string, string> = {};
      if (m === 'replay') next.mode = 'replay';
      if (f) next.view = 'focus';
      setParams(next, { replace: true });
    },
    [setParams],
  );
  const setFocus = useCallback((f: boolean) => go(mode, f), [go, mode]);
  const modeSwitch = <ModeSwitch mode={mode} onChange={(m) => go(m, focus)} />;
  // REPLAY 컴포넌트는 LIVE 화면과 따로 마운트되고, 모드 전환·화면 이동 시 언마운트되어 재생 루프가 정리됩니다.
  return (
    <div key={mode} className="page-enter h-full">
      {mode === 'replay' ? (
        <ReplayMonitor modeSwitch={modeSwitch} places={places} focus={focus} setFocus={setFocus} initialCase={params.get('case')} />
      ) : (
        <LiveNetworkMonitor modeSwitch={modeSwitch} focus={focus} setFocus={setFocus} />
      )}
    </div>
  );
}

function LiveNetworkMonitor({ modeSwitch, focus, setFocus }: { modeSwitch: ReactNode; focus: boolean; setFocus: (v: boolean) => void }) {
  const now = useNow();
  const building = useApp((s) => s.building);
  const hasToken = useApp((s) => s.hasToken);
  const selection = useApp((s) => s.selection);
  const select = useApp((s) => s.select);
  const { network, experiment, nodes, links, flows } = useNetworkDerived();
  const [pickedFlow, setPickedFlow] = useState<string | null>(null);
  // 넓은 화면은 기존처럼 펼친 채, 좁은 화면은 토폴로지를 먼저 보이도록 접은 채 시작합니다.
  const [panelOpen, setPanelOpen] = useState(() => matches(WIDE_QUERY));
  const wide = useMediaQuery(WIDE_QUERY);
  const [deckOpen, setDeckOpen] = useState<boolean | null>(null);
  const refresh = useAction();
  useEscapeToExit(focus, () => setFocus(false));
  const [barRef, barBottom] = useBarBottom();

  const places = useMemo(() => new Map<string, Place>((building?.building.nodes ?? []).map((n) => [n.id, n])), [building]);
  const pids = useMemo(() => new Map((experiment?.nodes ?? []).map((n) => [n.node_id, n.pid])), [experiment]);
  const flow = (pickedFlow && flows.find((f) => f.messageId === pickedFlow)) || flows.at(-1) || null;
  const selectedId = selection?.kind === 'node' ? selection.id : null;
  const focusNode = nodes.find((n) => n.id === selectedId) ?? nodes.find((n) => n.status === 'fail' || n.status === 'warn' || n.status === 'recovering') ?? nodes[0] ?? null;
  const counts = nodes.reduce<Record<NodeStatus, number>>((a, n) => ((a[n.status] += 1), a), { ok: 0, warn: 0, fail: 0, recovering: 0, unknown: 0, offline: 0 });
  const downLinks = links.filter((l) => l.status === 'fail').length;
  const suspectLinks = links.filter((l) => l.status === 'warn').length;
  const showAside = !focus && panelOpen;
  const deck = deckOpen ?? flows.length > 0;

  const controlBar = (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-50 flex justify-center px-4 pt-4">
      <div ref={barRef} className="control-bar glass-float pointer-events-auto flex max-w-full flex-wrap items-center gap-2.5 rounded-[22px] px-2.5 py-2">
        {modeSwitch}
        {network && (
          <>
            <span className="flex items-center gap-2 px-1 text-[12.5px] text-ink-2" title={network.monitor_error ?? undefined}>
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: network.observation_status === 'observed' ? '#3FC28A' : network.observation_status === 'error' ? '#EF5A5F' : '#7C8799', boxShadow: network.observation_status === 'observed' ? '0 0 8px rgba(63,194,138,0.9)' : undefined }} />
              {network.topology.topology_id} · 관측 {network.observation_status === 'observed' ? `${timeOf(network.observed_at)} (${ago(network.observed_at, now)})` : network.observation_status}
            </span>
            {isPublicDemo() ? (
              // 공개 데모: 재관측(POST)은 쓰기 요청이므로 버튼 대신 읽기 전용 표시만 둡니다.
              <span className="inline-flex h-8 items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 text-[12.5px] text-ink-3" title={PUBLIC_READONLY_HINT} data-testid="nm-readonly">
                <Lock size={12} /> 읽기 전용
              </span>
            ) : (
              <button
                type="button"
                disabled={!hasToken || !!refresh.busy}
                title={needToken(hasToken) ?? '실제 TCP 상태 즉시 재관측'}
                onClick={() => refresh.exec('r', actions.refreshNetwork, (n) => `재관측 완료 · 응답 ${n.nodes.filter((x) => x.reachable).length}/${n.nodes.length}`)}
                className="lift inline-flex h-8 items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3 text-[12.5px] text-ink-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
              >
                <RefreshCw size={13} className={refresh.busy ? 'animate-spin' : ''} /> 재관측
              </button>
            )}
          </>
        )}
        <FocusToggle on={focus} onChange={setFocus} />
      </div>
    </div>
  );

  if (!network) {
    return (
      <div className="nm-stage relative h-full">
        {controlBar}
        <div className="px-10 pt-28"><Empty title="네트워크 관측 데이터를 기다리는 중입니다" hint="WebSocket snapshot 또는 GET /api/v1/network" /></div>
      </div>
    );
  }

  const reachable = nodes.filter((n) => n.reachable === true).length;
  const allOffline = nodes.length > 0 && nodes.every((n) => n.status === 'offline');

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* ── 무대: 토폴로지 ── */}
        <div className="nm-stage relative min-h-0 flex-1 overflow-hidden" data-focus={focus || undefined}>
          <div style={{ top: barBottom }} className={cx('absolute transition-[left,bottom] duration-500', focus ? `inset-x-0 ${flow ? 'bottom-[130px]' : 'bottom-0'}` : 'bottom-0 left-0 right-0 xl:left-[290px]')} data-testid="nm-topology">
            <TopologyFlow topology={network.topology} network={network} nodes={nodes} links={links} places={places} pids={pids} flow={flow} selected={focusNode?.id ?? null} onSelect={(id) => { select(id ? { kind: 'node', id } : null); if (id) setPanelOpen(true); }} />
          </div>
          <div aria-hidden className="stage-vignette pointer-events-none absolute inset-0" />
          {controlBar}
          {refresh.msg && <div className="absolute left-1/2 top-[76px] z-50 w-[min(520px,80%)] -translate-x-1/2"><FeedbackLine msg={refresh.msg} /></div>}

          {/* 왼쪽: LIVE 상태 */}
          <div className="pointer-events-none absolute left-6 z-40 flex flex-col gap-2.5" style={{ top: barBottom + 10 }}>
            <span className="pointer-events-auto w-fit"><SourceBadge origin="LIVE" /></span>
            <div className={cx('nm-hud pointer-events-auto hidden w-[250px] gap-1.5 xl:grid', focus && '!hidden')}>
              <HudTile
                label="TCP 노드"
                value={allOffline ? '미실행' : network.observation_status !== 'observed' ? '미관측' : `${reachable} / ${nodes.length} 응답`}
                sub={allOffline ? '노드 프로세스 미실행 · 정상으로 단정하지 않음' : (['ok', 'warn', 'recovering', 'fail', 'unknown'] as NodeStatus[]).filter((k) => counts[k]).map((k) => `${NODE_STATUS_LABEL[k]} ${counts[k]}`).join(' · ') || '관측 대기'}
                tone={allOffline || network.observation_status !== 'observed' ? 'idle' : counts.fail ? 'fail' : counts.warn + counts.recovering ? 'warn' : 'ok'}
                testId="nm-live-nodes"
              />
              <HudTile
                label="장애 · 의심"
                value={allOffline ? '판정 불가' : counts.fail || counts.warn + counts.recovering ? `${nodes.filter((n) => n.status === 'fail').map((n) => n.id).join(' · ') || '장애 없음'}${counts.warn + counts.recovering ? ` · 의심 ${nodes.filter((n) => n.status === 'warn' || n.status === 'recovering').map((n) => n.id).join(' · ')}` : ''}` : '없음'}
                sub={`링크 ${links.length} · 장애 ${downLinks} · 의심 ${suspectLinks}`}
                tone={allOffline ? 'idle' : counts.fail ? 'fail' : counts.warn + counts.recovering ? 'warn' : 'info'}
              />
              <HudTile
                label="현재 메시지 경로"
                value={flow ? flow.route.join(' → ') : '관측된 메시지 없음'}
                sub={flow?.previousRoute ? <span>전환 전 <s className="text-[#FFA9AC]">{flow.previousRoute.join('→')}</s></span> : flow ? `시도 ${flow.attempt} · ${flow.messageId.slice(0, 8)}` : 'route_selected 이벤트 대기'}
                tone={!flow ? 'idle' : flow.stage === 'failed' ? 'fail' : flow.stage === 'acked' ? 'ok' : flow.previousRoute ? 'warn' : 'info'}
              />
            </div>
          </div>
          {/* FOCUS: 현재 이벤트를 크게 */}
          {focus && flow && (
            <div className="cine-caption pointer-events-none absolute bottom-5 left-8 z-40 w-[min(720px,70vw)]" data-testid="nm-live-headline">
              <div className="flex items-center gap-2.5 font-mono text-[11px] uppercase tracking-[0.2em] text-[#8FD3FF]"><span className="h-px w-7 bg-[#8FD3FF]" />LIVE · 최근 메시지</div>
              <div className="mt-1.5 font-mono text-[clamp(22px,2.1vw,34px)] font-semibold text-ink [text-shadow:0_2px_20px_rgba(0,0,0,0.95)]">{flow.route.join(' → ')}</div>
              <div className="mt-1 text-[13px] text-ink-2"><StageTag stage={flow.stage} /> {flow.previousRoute && <span className="ml-1 font-mono text-[#FFA9AC] line-through">{flow.previousRoute.join('→')}</span>}</div>
            </div>
          )}

          {/* 범례(접힘) */}
          <div className={cx('absolute bottom-4 left-6 z-40', focus && 'hidden')}>
            <LegendCard title="범례">
              {LEGEND.map(([l, c]) => (
                <div key={l} className="flex items-center gap-2"><span className="h-[3px] w-6 rounded" style={{ background: c }} /> {l}</div>
              ))}
              <div className="flex items-center gap-2"><span className="h-0 w-6 border-t-2 border-dashed border-fail" /> 전환 전 경로</div>
              <div className="flex items-center gap-2"><Dot color={STATUS_COLOR.offline} /> 미실행 · <Dot color={STATUS_COLOR.unknown} /> 미관측</div>
              <div className="pt-1 text-ink-3">링크 양끝 글자 = 각 노드가 본 이웃 상태</div>
            </LegendCard>
          </div>

          {!focus && (
            <button
              type="button"
              onClick={() => setPanelOpen((o) => !o)}
              aria-expanded={panelOpen}
              aria-label={panelOpen ? '상세 패널 접기' : '상세 패널 펼치기'}
              title={panelOpen ? '상세 패널 접기' : '상세 패널 펼치기'}
              className="glass-float lift absolute right-4 top-1/2 z-40 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full text-ink-2 hover:text-ink"
            >
              {wide ? (panelOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />) : panelOpen ? <PanelBottomClose size={16} /> : <PanelBottomOpen size={16} />}
            </button>
          )}
        </div>

        {/* 경로 비교 */}
        {flow && (
          <div className="glass-chrome relative z-10 flex items-center gap-4 border-t px-5 py-2.5">
            <div className="w-[96px] shrink-0">
              <div className="font-mono text-[10.5px] font-medium uppercase tracking-[0.14em] text-ink-3">경로 비교</div>
              <StageTag stage={flow.stage} />
            </div>
            <div className="min-w-0 flex-1"><RouteCompare flow={flow} /></div>
          </div>
        )}

        {/* 메시지 · 시퀀스(접힘 가능, FOCUS 에서는 숨김) */}
        {!focus && (
          <div className="glass-chrome relative z-10 shrink-0 border-t">
            <button type="button" onClick={() => setDeckOpen(!deck)} aria-expanded={deck} className="flex w-full items-center gap-3 px-5 py-2.5 text-left transition hover:bg-white/[0.03]">
              <span className="shrink-0 whitespace-nowrap text-[12px] font-medium uppercase tracking-[0.14em] text-ink-3"><span className="sm:hidden">메시지</span><span className="hidden sm:inline">메시지 · 시퀀스</span></span>
              <span className="truncate text-[13px] text-ink-2">{flow ? `최근 ${flow.route.join(' → ')}` : '관측된 메시지가 없습니다'}</span>
              <span className="ml-auto flex shrink-0 items-center gap-1 whitespace-nowrap text-[12px] text-ink-3">{flows.length}건 {deck ? <ChevronDown size={14} /> : <ChevronUp size={14} />}</span>
            </button>
            {deck && (
              <div className="grid h-[210px] grid-cols-1 grid-rows-2 divide-y divide-white/[0.07] border-t border-white/[0.06] sm:grid-cols-[280px_1fr] sm:grid-rows-1 sm:divide-x sm:divide-y-0 xl:grid-cols-[360px_1fr] [@media(min-height:900px)]:h-[250px]">
                <div className="panel-scroll px-4 py-3">
                  <MessageHeader flow={null} />
                  <FlowList flows={flows} selected={flow?.messageId ?? null} onSelect={setPickedFlow} />
                </div>
                <div className="panel-scroll px-4 py-3">
                  <MessageHeader flow={flow} />
                  <SequenceDiagram messageId={flow?.messageId ?? null} />
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      <div className={asideShellClass(showAside)} aria-hidden={!showAside} data-testid="nm-aside">
        {showAside && (
          <aside className={cx('glass-chrome panel-scroll', asideInnerClass())} aria-label="노드 상세">
            <NodeDetail node={focusNode} network={network} places={places} />
          </aside>
        )}
      </div>
    </div>
  );
}
