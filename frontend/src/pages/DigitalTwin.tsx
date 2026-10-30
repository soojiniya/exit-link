import { Suspense, lazy, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Building2, ChevronDown, ChevronUp, Crosshair, Flame, Footprints, Layers3, Minus, PanelBottomClose, PanelBottomOpen, PanelRightClose, PanelRightOpen, Plus, RotateCcw, Sofa, Video, Waypoints } from 'lucide-react';
import { useApp } from '@/store/store';
import { useActiveScenario, useNetworkDerived } from '@/store/selectors';
import { checkLayout, layout } from '@/domain/layout';
import { IncidentPanel } from '@/ui/IncidentPanel';
import { EventTimeline } from '@/ui/EventTimeline';
import { cx } from '@/ui/primitives';
import type { Layers } from '@/three/TwinCanvas';
import { viewApi } from '@/three/sceneContext';
import type { FloorSel } from '@/store/types';
import { useTwinReplay } from '@/ui/replay/useTwinReplay';
import { CinematicCaption, TwinReplayAside, TwinReplayDeck, TwinReplayHud, TwinReplayTransport } from '@/ui/replay/TwinReplayPanels';
import { HudTile } from '@/ui/twin/HudTile';
import type { DirectorShot } from '@/ui/replay/cinematicDirector';
import { NARROW_QUERY, WIDE_QUERY, asideInnerClass, asideShellClass, matches, useMediaQuery } from '@/ui/useMediaQuery';
import { isPublicDemo } from '@/domain/mode';

const TwinCanvas = lazy(() => import('@/three/TwinCanvas').then((m) => ({ default: m.TwinCanvas })));

/**
 * Digital Twin — 3D 건물이 주인공인 관제 화면.
 * 레이아웃: [무대(3D 전체 + 떠 있는 control bar · HUD · 층/시점 조작)] + [하단 이벤트 덱] + [접히는 오른쪽 패널]
 * 모드: LIVE(실시간 관측) · REPLAY(저장된 기록 재생) · CINEMATIC(시연: 보조 패널을 접고 장 단위로 재생)
 * REPLAY·CINEMATIC 는 공통 재생 엔진만 쓰며 LIVE 상태를 바꾸지 않습니다.
 */
type Mode = 'live' | 'replay' | 'cinematic';
const MODES: { key: Mode; label: string; title: string }[] = [
  { key: 'live', label: 'LIVE', title: '실제 TCP 노드 실시간 관측' },
  { key: 'replay', label: 'REPLAY', title: '저장된 TCP 실험 기록 재생(실시간 아님)' },
  { key: 'cinematic', label: 'CINEMATIC', title: '시연 모드: 보조 패널을 접고 핵심 장면만 크게 재생' },
];

/** 자동 연출 샷 최소 유지 시간(화면 시간). 재생 중 장면이 너무 자주 바뀌어 카메라가 흔들리지 않게 합니다. */
const SHOT_HOLD_MS = 1600;
/** CINEMATIC 화면에서 3D 위를 덮는 UI 영역(px): 왼쪽 HUD·위 control bar·오른쪽 층 버튼 */
const CINE_INSETS = { left: 370, top: 92, right: 96, bottom: 36 };
/** 휴대폰 폭(sm 미만)에서는 왼쪽 HUD 를 숨기므로 3D 프레이밍 여백도 줄입니다(PC 값은 그대로). */
const CINE_INSETS_NARROW = { left: 12, top: 120, right: 64, bottom: 150 };

/**
 * 자동 연출 샷을 받아, 재생 중에는 최소 SHOT_HOLD_MS 동안 유지한 뒤 다음 샷으로 넘깁니다.
 * 일시정지·탐색 중에는 바로 적용합니다. 카메라만 바뀌고 재생 시각은 건드리지 않습니다.
 */
function useHeldShot(shot: DirectorShot | null, playing: boolean) {
  const [held, setHeld] = useState<DirectorShot | null>(shot);
  const since = useRef(0);
  const latest = useRef(shot);
  latest.current = shot;
  const key = shot?.key ?? null;
  useEffect(() => {
    if (!key) {
      setHeld(null);
      return;
    }
    if (held?.key === key) return;
    const wait = playing && held ? Math.max(0, SHOT_HOLD_MS - (performance.now() - since.current)) : 0;
    const id = window.setTimeout(() => {
      setHeld(latest.current);
      since.current = performance.now();
    }, wait);
    return () => window.clearTimeout(id);
  }, [key, playing]); // eslint-disable-line react-hooks/exhaustive-deps
  return held;
}

function TwinModeSwitch({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  return (
    <div className="seg" role="tablist" aria-label="Digital Twin 모드">
      {MODES.map((m) => (
        <button key={m.key} role="tab" aria-selected={mode === m.key} onClick={() => onChange(m.key)} title={m.title}>{m.label}</button>
      ))}
    </div>
  );
}

export default function DigitalTwin() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('mode');
  const mode: Mode = raw === 'replay' || raw === 'cinematic' ? raw : 'live';
  const isReplay = mode !== 'live';
  const cinematic = mode === 'cinematic';
  const initialT = Number(params.get('t'));
  // REPLAY 상태는 공통 재생 엔진에서만 계산합니다. LIVE 에서는 아무것도 불러오지 않고 재생 루프도 돌지 않습니다.
  const replay = useTwinReplay(isReplay, { caseId: params.get('case'), t: Number.isFinite(initialT) && params.has('t') ? initialT : null }, cinematic);
  const setMode = (m: Mode) => setParams(m === 'live' ? {} : { mode: m }, { replace: true });

  // ── CINEMATIC 카메라 연출 ──
  // 자동 연출: 기록 기반 샷(useTwinReplay.shot)을 따라감. 사용자가 직접 조작하거나 발표자 버튼을 누르면 꺼지고 우선권이 사용자에게 갑니다.
  const [autoCam, setAutoCam] = useState(true);
  const [manualShot, setManualShot] = useState<DirectorShot | null>(null);
  const nonce = useRef(0);
  useEffect(() => {
    setAutoCam(true);
    setManualShot(null);
  }, [cinematic, replay.caseId]);
  const heldShot = useHeldShot(cinematic && autoCam ? replay.shot : null, replay.pb.playing);
  const cameraShot = cinematic ? (autoCam ? heldShot : manualShot) : null;
  const takeShot = (s: DirectorShot | null) => {
    if (!s) return;
    nonce.current += 1;
    setAutoCam(false);
    setManualShot({ ...s, key: `manual-${nonce.current}-${s.key}` });
  };
  const overviewShot: DirectorShot = { key: 'overview', style: 'overview', nodes: [], reason: '건물 전체' };
  const userTookCamera = () => {
    if (!cinematic) return;
    setAutoCam(false);
    setManualShot(null);
  };

  // 발표자 단축키(CINEMATIC 전용): Space 재생/일시정지 · ←/→ 이전/다음 장 · 1–3 사례 · A 자동 연출 · F 전체 보기
  const rRef = useRef(replay);
  rRef.current = replay;
  useEffect(() => {
    if (!cinematic) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest('input, textarea, select, [contenteditable="true"]')) return;
      const onButton = !!el?.closest('button');
      const r = rRef.current;
      const marks = r.chapters.filter((c) => c.t !== null).map((c) => c.t as number).sort((a, b) => a - b);
      const go = (x: number) => { r.pb.setPlaying(false); r.pb.seek(x); };
      if (e.key === ' ' && !onButton) { e.preventDefault(); r.pb.toggle(); }
      else if (e.key === 'ArrowRight') { const n = marks.find((x) => x > r.t + 0.5); if (n !== undefined) { e.preventDefault(); go(n); } }
      else if (e.key === 'ArrowLeft') { const p = [...marks].reverse().find((x) => x < r.t - 0.5); e.preventDefault(); go(p ?? 0); }
      else if (/^[1-9]$/.test(e.key)) { const c = r.manifest?.cases[Number(e.key) - 1]; if (c) r.setCaseId(c.id); }
      else if (e.key === 'a' || e.key === 'A') { setManualShot(null); setAutoCam((x) => !x); }
      else if (e.key === 'f' || e.key === 'F') takeShot(overviewShot);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cinematic]); // eslint-disable-line react-hooks/exhaustive-deps

  const building = useApp((s) => s.building);
  const buildingError = useApp((s) => s.buildingError);
  const floor = useApp((s) => s.floor);
  const setFloor = useApp((s) => s.setFloor);
  const selection = useApp((s) => s.selection);
  const select = useApp((s) => s.select);
  const timeline = useApp((s) => s.timeline);
  const scenario = useActiveScenario();
  const { network, nodes, links, latestFlow } = useNetworkDerived();
  const [layers, setLayers] = useState<Layers>({ hazards: true, evac: true, network: true, decor: true });
  const [highlightStart, setHighlightStart] = useState<string | null>(null);
  // 넓은 화면은 기존처럼 패널을 펼친 채 시작하고, 좁은 화면은 3D 를 먼저 보이도록 접은 채 시작합니다.
  const [panelOpen, setPanelOpen] = useState(() => matches(WIDE_QUERY));
  const wide = useMediaQuery(WIDE_QUERY);
  const narrow = useMediaQuery(NARROW_QUERY);
  const [logOpen, setLogOpen] = useState(false);
  // 시나리오가 바뀌면 화재가 있는 층으로 한 번 초점을 옮깁니다.
  const firstFire = scenario?.state.hazards.fire_locations[0];
  useEffect(() => {
    if (isReplay) return; // REPLAY 중에는 LIVE 시나리오가 층을 바꾸지 않음
    const f = firstFire && building?.building.nodes.find((n) => n.id === firstFire)?.floor;
    if (f) setFloor(f);
  }, [scenario?.state.scenario_id, firstFire, building]); // eslint-disable-line react-hooks/exhaustive-deps
  const check = useMemo(() => (building ? checkLayout(building) : null), [building]);

  const floorLabel = floor === 'ALL' ? 'ALL' : `${floor}F`;
  const floors = building?.building.floors ?? [1, 2, 3];
  const showAside = !cinematic && panelOpen;
  const selectedNode = isReplay ? replay.selectedNode : selection?.kind === 'node' ? selection.id : null;

  // LIVE 핵심 상태(기존 스토어 값만 사용)
  const placeLabel = (id: string) => building?.building.nodes.find((n) => n.id === id)?.label ?? id;
  const hz = scenario?.state.hazards;
  const liveFail = nodes.filter((n) => n.status === 'fail').map((n) => n.id);
  const liveWarn = nodes.filter((n) => n.status === 'warn' || n.status === 'recovering').map((n) => n.id);
  const liveOk = nodes.filter((n) => n.status === 'ok').length;
  const liveOffline = nodes.filter((n) => n.status === 'offline' || n.status === 'unknown').length;
  const lastEvent = timeline[timeline.length - 1];

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* ── 무대: 3D 히어로 ── */}
        <div className="twin-stage relative min-h-0 flex-1 overflow-hidden" data-twin-shot={cameraShot?.key ?? ''} data-twin-autocam={cinematic ? String(autoCam) : undefined}>
          {!building ? (
            <CenterNote title={buildingError ? '건물 데이터를 불러오지 못했습니다' : '건물 데이터를 불러오는 중…'} body={buildingError ?? 'GET /api/v1/building'} />
          ) : check && !check.ok ? (
            <CenterNote title="배치 파일과 API 건물 데이터가 일치하지 않아 3D를 표시하지 않습니다" body={check.items.filter((i) => !i.ok).map((i) => `${i.name}: ${i.detail}`).join('\n')} />
          ) : (
            <Suspense fallback={<CenterNote title="3D 엔진 로딩 중…" />}>
              <TwinCanvas
                building={building}
                floor={floor}
                layers={layers}
                hazards={isReplay ? null : scenario?.state.hazards ?? null}
                plans={isReplay ? [] : scenario?.plans ?? []}
                topology={isReplay ? null : network?.topology ?? null}
                nodes={isReplay ? [] : nodes}
                links={isReplay ? [] : links}
                flow={isReplay ? null : latestFlow}
                selectedNode={selectedNode}
                highlightStart={isReplay ? null : highlightStart}
                onSelectNode={(id) => (isReplay ? replay.setSelectedNode(id) : select(id ? { kind: 'node', id } : null))}
                replay={isReplay ? replay.overlay : undefined}
                cinematic={cinematic}
                wheelZoom={!cinematic}
                shot={cameraShot}
                insets={narrow ? CINE_INSETS_NARROW : CINE_INSETS}
                onUserCamera={userTookCamera}
              />
            </Suspense>
          )}
          {/* 가장자리 비네팅: 3D 를 주인공으로, UI 는 가장자리로 */}
          <div aria-hidden className="stage-vignette pointer-events-none absolute inset-0" />

          {/* 상단 control bar */}
          <div className="pointer-events-none absolute inset-x-0 top-0 z-50 flex justify-center px-4 pt-4">
            <div className="control-bar glass-float pointer-events-auto flex max-w-full flex-wrap items-center gap-3 rounded-[22px] px-2.5 py-2">
              <TwinModeSwitch mode={mode} onChange={setMode} />
              {isReplay ? (
                <TwinReplayTransport r={replay} />
              ) : (
                <span className="flex items-center gap-2 pr-2 text-[12.5px] text-ink-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-ok shadow-[0_0_8px_rgba(63,194,138,0.9)]" />
                  실시간 관측 · {building?.building.building_id ?? '건물 정보 대기'}
                </span>
              )}
            </div>
          </div>

          {/* 좌상단: 층 타이포 + 핵심 상태 — 휴대폰 폭(sm 미만)에서는 control bar 가 여러 줄로 감겨 3D 를 가리므로 숨깁니다(층은 오른쪽 아래 버튼, 이벤트는 하단 덱에서 확인) */}
          <div className="absolute left-6 top-[84px] z-40 hidden flex-col gap-3 sm:flex" data-testid="twin-left-hud">
            <div className={cx('pointer-events-none', cinematic && 'cine-hide-short')}>
              <div className="eyebrow">Digital Twin · <span className="text-ink-2">{building?.building.building_id ?? '—'}</span></div>
              <div className="mt-2 flex items-end gap-3">
                <span className={cx('text-sheen font-extralight leading-none tracking-[-0.045em]', cinematic ? 'text-[60px]' : 'text-[52px]')}>{floorLabel}</span>
                <span className="mb-1.5 text-[13px] text-ink-3">{floor === 'ALL' ? '전체 층 분해 보기' : '단면 보기 · 아래층 반투명'}</span>
              </div>
              {!cinematic && (
                <div className="glass-float mt-3 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11.5px] text-ink-3" title={layout.description}>
                  <span className="h-1.5 w-1.5 rounded-full bg-ink-3" /> 가상 건물 · 시각화용 배치(실측 아님){layout.status === 'draft_for_review' ? ' · 검토용 초안' : ''}
                  {check?.ok && <span className="text-ok"> · 이동 그래프 대조 {check.passed}/{check.passed} 통과</span>}
                </div>
              )}
            </div>
            {isReplay ? (
              <TwinReplayHud r={replay} cinematic={cinematic} />
            ) : (
              <div className="grid w-[250px] gap-1.5" data-testid="twin-hud-live">
                <HudTile
                  label="시나리오"
                  value={!scenario ? '활성 시나리오 없음' : hz?.fire_locations.length ? `화재 · ${placeLabel(hz.fire_locations[0])}` : hz && (hz.blocked_nodes.length || hz.dangerous_nodes.length) ? '위험 구역 지정' : '위험 없음'}
                  sub={scenario ? `rev ${scenario.state.revision} · SIM` : isPublicDemo() ? '읽기 전용 · 로컬 실험 환경에서 생성' : '제어 패널에서 생성'}
                  tone={!scenario ? 'idle' : hz?.fire_locations.length ? 'fail' : hz && (hz.blocked_nodes.length || hz.dangerous_nodes.length) ? 'warn' : 'neutral'}
                  testId="twin-hud-scenario"
                />
                <HudTile
                  label="메시지 경로"
                  value={latestFlow ? latestFlow.route.join(' → ') : '관측된 메시지 없음'}
                  sub={latestFlow?.previousRoute ? <span>전환 전 <s className="text-[#FFA9AC]">{latestFlow.previousRoute.join('→')}</s></span> : latestFlow ? `시도 ${latestFlow.attempt} · LIVE` : 'LIVE TCP'}
                  tone={latestFlow?.previousRoute ? 'warn' : latestFlow ? 'info' : 'idle'}
                />
                <HudTile
                  label="ACK"
                  value={!latestFlow ? '—' : latestFlow.stage === 'acked' ? '수신' : latestFlow.stage === 'failed' ? '실패' : '대기'}
                  sub={latestFlow ? `최근 메시지 ${latestFlow.messageId.slice(0, 8)}` : '관측 대기'}
                  tone={!latestFlow ? 'idle' : latestFlow.stage === 'acked' ? 'ok' : latestFlow.stage === 'failed' ? 'fail' : 'info'}
                />
                <HudTile
                  label="장애"
                  value={liveFail.length ? liveFail.join(' · ') : liveWarn.length ? `의심 ${liveWarn.join(' · ')}` : liveOk ? '없음' : liveOffline === nodes.length && nodes.length ? '노드 미실행' : '미관측'}
                  sub={liveOk ? `정상 응답 ${liveOk}/${nodes.length}` : liveOffline ? `미실행 ${liveOffline}/${nodes.length} · 정상으로 단정하지 않음` : 'TCP 노드 미관측'}
                  tone={liveFail.length ? 'fail' : liveWarn.length ? 'warn' : liveOk ? 'info' : 'idle'}
                />
              </div>
            )}
          </div>

          {/* 우상단: LIVE 경로 전환 배너 */}
          {!isReplay && latestFlow?.previousRoute && (
            <div className="glass-float headline-enter absolute right-5 top-[84px] z-40 max-w-[360px] rounded-2xl border-action/40 px-4 py-3 shadow-glow-action">
              <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-action">통신 경로 전환</div>
              <div className="mt-1 font-mono text-[13px] text-[#F2878A] line-through">{latestFlow.previousRoute.join(' → ')}</div>
              <div className="font-mono text-[15px] text-action">{latestFlow.route.join(' → ')}</div>
              <div className="mt-1 text-[11.5px] text-ink-3">관측된 route_selected 이벤트 기준 · {latestFlow.previousReason === 'retry' ? '같은 메시지 재시도' : '직전 메시지와 다른 경로'}</div>
            </div>
          )}

          {/* 오른쪽 패널 손잡이 */}
          {!cinematic && (
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

          {/* 우하단: 층 선택 · 시점 */}
          <div className="absolute bottom-4 right-5 z-40 flex items-end gap-2">
            {/* 레이어(아이콘만, 이름은 툴팁·스크린리더) */}
            {!cinematic && (
              <div className="glass-float flex flex-col overflow-hidden rounded-2xl p-1" role="group" aria-label="표시 레이어">
                {!isReplay && <LayerToggle on={layers.hazards} onClick={() => setLayers((l) => ({ ...l, hazards: !l.hazards }))} icon={<Flame size={15} />} label="화재·위험 구역" tag="SIM" />}
                {!isReplay && <LayerToggle on={layers.evac} onClick={() => setLayers((l) => ({ ...l, evac: !l.evac }))} icon={<Footprints size={15} />} label="대피 경로" tag="SIM" />}
                <LayerToggle on={layers.network} onClick={() => setLayers((l) => ({ ...l, network: !l.network }))} icon={<Waypoints size={15} />} label="통신 노드·링크" tag={isReplay ? 'REPLAY' : 'LIVE'} />
                <LayerToggle on={layers.decor} onClick={() => setLayers((l) => ({ ...l, decor: !l.decor }))} icon={<Sofa size={15} />} label="사무 공간·가구" tag="장식" />
              </div>
            )}
            <div className="glass-float flex flex-col overflow-hidden rounded-2xl p-1" role="group" aria-label="층 선택">
              {(['ALL', ...[...floors].reverse()] as FloorSel[]).map((f) => (
                <button
                  key={String(f)}
                  title={f === 'ALL' ? '전체 층' : `${f}층`}
                  onClick={() => setFloor(f)}
                  aria-pressed={floor === f}
                  className={cx('h-9 w-12 rounded-xl font-mono text-[13px] transition', floor === f ? 'bg-gradient-to-b from-[#F4F8FF] to-[#C6D6EC] font-semibold text-[#0A1220] shadow-glow-action' : 'text-ink-2 hover:bg-white/[0.07] hover:text-ink')}
                >
                  {f === 'ALL' ? <Layers3 size={15} className="mx-auto" /> : `${f}F`}
                </button>
              ))}
            </div>
            <div className="glass-float flex flex-col overflow-hidden rounded-2xl p-1">
              <IconBtn title="아이소 시점 복귀" onClick={() => { userTookCamera(); viewApi.reset(); }}><RotateCcw size={15} /></IconBtn>
              <IconBtn title="확대" onClick={() => { userTookCamera(); viewApi.zoomBy(1.25); }}><Plus size={15} /></IconBtn>
              <IconBtn title="축소" onClick={() => { userTookCamera(); viewApi.zoomBy(0.8); }}><Minus size={15} /></IconBtn>
            </div>
          </div>
          {!cinematic && (
            <div className="glass-float pointer-events-none absolute bottom-4 left-1/2 z-30 hidden -translate-x-1/2 rounded-full px-3 py-1 text-[11.5px] text-ink-3 xl:block">
              드래그 회전 · 우클릭 드래그 이동 · 휠 확대 · 노드 클릭 시 카메라 이동
            </div>
          )}
          {/* CINEMATIC 이벤트 타이포: 왼쪽 아래(발표 버튼 위) 고정 영역 — 3D 중앙을 가리지 않음 */}
          {cinematic && (
            <div className="pointer-events-none absolute bottom-[66px] left-6 z-40">
              <CinematicCaption r={replay} />
            </div>
          )}
          {cinematic && (
            <div className="absolute bottom-4 left-5 z-40 flex max-w-[calc(100%-220px)] flex-wrap items-center gap-2">
              <div className="glass-float flex items-center gap-1 rounded-full p-1" role="group" aria-label="발표 카메라">
                <button
                  type="button"
                  role="switch"
                  aria-checked={autoCam}
                  aria-label="자동 카메라 연출"
                  data-testid="twin-autocam"
                  onClick={() => { setManualShot(null); setAutoCam((x) => !x); }}
                  title="기록된 이벤트에 맞춰 카메라를 자동으로 옮깁니다(A). 직접 드래그하면 꺼집니다."
                  className={cx('flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium transition', autoCam ? 'bg-[#7CC8FF]/[0.16] text-[#CFEAFF]' : 'text-ink-3 hover:text-ink')}
                >
                  <Video size={14} /> 자동 연출 <span className={cx('rounded-full px-1.5 font-mono text-[10.5px]', autoCam ? 'bg-[#7CC8FF]/25 text-[#E4F4FF]' : 'bg-white/[0.06]')}>{autoCam ? 'ON' : 'OFF'}</span>
                </button>
                <button type="button" data-testid="twin-shot-overview" onClick={() => takeShot(overviewShot)} title="건물 전체 보기(F)" className="lift flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] text-ink-2 hover:text-ink">
                  <Building2 size={14} /> 전체 보기
                </button>
                <button type="button" data-testid="twin-shot-focus" disabled={!replay.keyShot?.nodes.length} onClick={() => takeShot(replay.keyShot)} title="이 사례에서 시도된 경로와 장애 노드를 한 화면에" className="lift flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] text-ink-2 hover:text-ink disabled:opacity-40">
                  <Crosshair size={14} /> {replay.keyShot?.style === 'reroute' ? '장애·우회 집중' : '경로 집중'}
                </button>
              </div>
              <span className="glass-float pointer-events-none hidden rounded-full px-3 py-1 font-mono text-[11px] text-ink-3 2xl:inline">
                Space 재생 · ←→ 장 이동 · 1–3 사례 · A 자동 · F 전체 · 휠 확대 꺼짐
              </span>
            </div>
          )}
        </div>

        {/* ── 하단: 이벤트 덱(REPLAY) / 이벤트 기록(LIVE) ── */}
        {isReplay ? (
          <div className="deck glass-chrome relative z-10 max-h-[34vh] shrink-0 overflow-y-auto border-t sm:max-h-none sm:overflow-visible" data-testid="twin-replay-deck">
            <TwinReplayDeck r={replay} cinematic={cinematic} />
          </div>
        ) : (
          <div className="glass-chrome relative z-10 shrink-0 border-t">
            <button
              type="button"
              onClick={() => setLogOpen((o) => !o)}
              aria-expanded={logOpen}
              className="flex w-full items-center gap-3 px-5 py-2.5 text-left transition hover:bg-white/[0.03]"
            >
              <span className="shrink-0 whitespace-nowrap text-[12px] font-medium uppercase tracking-[0.14em] text-ink-3"><span className="sm:hidden">이벤트</span><span className="hidden sm:inline">이벤트 · 경로 전환 기록</span></span>
              <span className="truncate text-[13px] text-ink-2">{lastEvent ? `최근: ${lastEvent.title}` : '아직 수신한 이벤트가 없습니다'}</span>
              <span className="ml-auto flex shrink-0 items-center gap-1 whitespace-nowrap text-[12px] text-ink-3">{timeline.length}건 {logOpen ? <ChevronDown size={14} /> : <ChevronUp size={14} />}</span>
            </button>
            {logOpen && (
              <div className="h-[170px] border-t border-white/[0.06] [@media(min-height:900px)]:h-[210px]">
                <EventTimeline
                  onPick={(t) => {
                    const n = t.nodeIds?.find((x) => /^N\d+$/.test(x));
                    if (n) select({ kind: 'node', id: n });
                  }}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── 오른쪽 상세 패널(접힘) ── */}
      <div className={asideShellClass(showAside)} aria-hidden={!showAside} data-testid="twin-aside">
        {showAside &&
          (isReplay ? (
            <aside className={cx('glass-chrome panel-scroll', asideInnerClass())} aria-label="재생 상세">
              <TwinReplayAside r={replay} />
            </aside>
          ) : (
            <IncidentPanel highlightStart={highlightStart} onHighlightStart={setHighlightStart} />
          ))}
      </div>
    </div>
  );
}

function CenterNote({ title, body }: { title: string; body?: string }) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-md text-center">
        <div className="text-[15px] text-ink">{title}</div>
        {body && <pre className="mt-2 whitespace-pre-wrap font-mono text-[12px] text-ink-3">{body}</pre>}
      </div>
    </div>
  );
}

function LayerToggle({ on, onClick, icon, label, tag }: { on: boolean; onClick: () => void; icon: ReactNode; label: string; tag: string }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      aria-label={`${label} 레이어 (${tag})`}
      title={`${label} · ${tag} · ${on ? '표시 중' : '숨김'}`}
      className={cx('relative flex h-9 w-10 items-center justify-center rounded-xl transition hover:bg-white/[0.07]', on ? 'text-ink' : 'text-ink-3 opacity-50')}
    >
      {icon}
      {!on && <span aria-hidden className="absolute h-px w-5 rotate-45 bg-ink-3" />}
    </button>
  );
}

function IconBtn({ children, title, onClick }: { children: ReactNode; title: string; onClick: () => void }) {
  return (
    <button title={title} aria-label={title} onClick={onClick} className="flex h-9 w-10 items-center justify-center rounded-xl text-ink-2 transition hover:bg-white/[0.07] hover:text-ink">
      {children}
    </button>
  );
}
