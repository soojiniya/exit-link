import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowUpRight, BarChart3, ChevronLeft, ChevronRight, Clapperboard, ScanSearch } from 'lucide-react';
import { loadManifest, loadReplayCase, timelineMarks, type ReplayCase } from '@/domain/replayEngine';
import { chaptersOf } from '@/ui/replay/useTwinReplay';
import { TWIN_REPLAY_NOTICE } from '@/ui/replay/TwinReplayPanels';
import { pct, pctRange, pp, ppRange, rowOf, study, studyValid } from '@/domain/study';
import { caveatItems } from '@/ui/study/caveats';
import { StoryNetwork } from '@/ui/story/StoryNetwork';
import { ackOrder, reroutedMessage, routeBeforeChange, sceneBeats, sceneTime, sceneWindows, type SceneKey, type SceneWindow } from '@/ui/story/storyScenes';
import { useSceneProgress, useStoryMode } from '@/ui/story/useSceneProgress';

/**
 * STORY — 발표용 스크롤 스토리텔링.
 * 장면 01~04: 긴 섹션 안의 고정 화면에서, 스크롤 진행도를 그 장면 사례의 기록 구간 [t0, t1] 에 선형으로 대응시킵니다(storyScenes.sceneTime).
 *   네트워크 상태는 공통 REPLAY 엔진이 기록 시각 t 로 계산한 값이므로, 스크롤을 거꾸로 하거나 빠르게 해도 같은 t 면 같은 화면입니다.
 *   스크롤은 '기록 탐색' 수단일 뿐 기록 시각·측정값·이벤트 순서는 바꾸지 않습니다. 장면 = 사례 1개(사례를 섞지 않음).
 * 장면 05: 저장된 본 실험 결과(domain/study) + t000 사례(통계 표본 아님).
 * 움직임 줄이기 · 휴대폰 폭: 고정 화면 없이 장면마다 핵심 시점의 정적 상태와 전체 이야기 줄을 보여 줍니다.
 * 백엔드·WebSocket·스토어를 쓰지 않습니다. 문장에 측정값을 직접 쓰지 않고 기록에서 읽습니다.
 */
type Cases = Record<string, ReplayCase>;
type Tone = 'info' | 'fail' | 'warn' | 'ok';
const TONE: Record<Tone, string> = { info: '#7CC8FF', fail: '#EF5A5F', warn: '#E9954A', ok: '#3FC28A' };
const ms = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? '기록 없음' : `${v.toLocaleString('ko-KR', { maximumFractionDigits: d, minimumFractionDigits: d })} ms`);
const sec = (v: number) => `+${(v / 1000).toFixed(3)}s`;
const SCENE_SPAN = 2.6; // 장면 01~04 섹션 높이 = 화면 높이 × SCENE_SPAN (스크롤 거리)

const CH: { key: SceneKey | 'compare'; no: string; label: string; tone: Tone }[] = [
  { key: 'normal', no: '01', label: '정상 통신', tone: 'info' },
  { key: 'fault', no: '02', label: '장애 발생', tone: 'fail' },
  { key: 'reroute', no: '03', label: '우회 전달', tone: 'warn' },
  { key: 'ack', no: '04', label: 'ACK 수신', tone: 'ok' },
  { key: 'compare', no: '05', label: '연구 성과', tone: 'fail' },
];

function useReveal(root: RefObject<HTMLElement>, deps: unknown[]) {
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && e.target.classList.add('is-in')), { root: el, threshold: 0.12 });
    el.querySelectorAll('.reveal:not(.is-in)').forEach((n) => io.observe(n));
    return () => io.disconnect();
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
}

export default function Story() {
  const [cases, setCases] = useState<Cases>({});
  const [problem, setProblem] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const rail = useRef<(HTMLElement | null)[]>([]);
  const [active, setActive] = useState(-1);
  const { mode, reduced } = useStoryMode();
  const loaded = Object.keys(cases).length > 0;
  useReveal(box, [loaded, mode]);

  useEffect(() => {
    const ctl = new AbortController();
    loadManifest(ctl.signal)
      .then(async (m) => {
        const all = await Promise.all(m.cases.map((c) => loadReplayCase(c, ctl.signal)));
        setCases(Object.fromEntries(all.map((c) => [c.cell.cell, c])));
      })
      .catch((e: unknown) => { if (!ctl.signal.aborted) setProblem(String(e)); });
    return () => ctl.abort();
  }, []);

  // 고정 화면 높이 = 스크롤 영역 높이(상단바 제외)
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => el.style.setProperty('--story-h', `${el.clientHeight}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 현재 장: 화면 가운데 선을 지나는 장(긴 섹션에서도 안정적)
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (es) => es.forEach((e) => { if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.ch)); }),
      { root: el, rootMargin: '-50% 0px -50% 0px', threshold: 0 },
    );
    el.querySelectorAll('[data-ch]').forEach((n) => io.observe(n));
    return () => io.disconnect();
  }, [loaded, mode]);
  useEffect(() => {
    if (active < 0) {
      // 직접 진입(#ch-N) 처리 전에는 지우지 않음
      if (jumped.current && window.location.hash) window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
      return;
    }
    const h = `#ch-${active}`;
    if (window.location.hash !== h) window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${h}`);
  }, [active]);

  const go = useCallback((i: number) => {
    const el = box.current;
    const target = i < 0 ? el?.querySelector<HTMLElement>('#story-hero') : el?.querySelector<HTMLElement>(`#ch-${i}`);
    if (!el || !target) return;
    glideTo(el, target.offsetTop, reduced);
  }, [reduced]);

  // 주소의 #ch-N 으로 직접 들어오면 그 장으로(기록을 불러온 뒤 한 번)
  const jumped = useRef(false);
  useEffect(() => {
    if (!loaded || jumped.current) return;
    jumped.current = true;
    const m = /^#ch-(\d)$/.exec(window.location.hash);
    if (m) requestAnimationFrame(() => { const el = box.current?.querySelector<HTMLElement>(`#ch-${m[1]}`); if (el && box.current) box.current.scrollTop = el.offsetTop; });
  }, [loaded]);

  // ←/→ 로 장 이동(세로 방향키·Page 키는 브라우저 기본 스크롤 그대로)
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.altKey || e.ctrlKey || e.metaKey || (el && el.closest('input,select,textarea,[contenteditable=true]'))) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); go(Math.min(CH.length - 1, activeRef.current + 1)); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); go(Math.max(-1, activeRef.current - 1)); }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [go]);

  // 장면 진행도 → 진행 레일(리렌더 없이 CSS 변수만)
  const setRail = useCallback((i: number, p: number) => rail.current[i]?.style.setProperty('--p', String(p)), []);

  const wins = useMemo(() => sceneWindows(cases), [cases]);
  const t010Ch = useMemo(() => (cases.t010 ? chaptersOf(cases.t010, timelineMarks(cases.t010)) : []), [cases]);
  const chT = (k: string) => t010Ch.find((c) => c.key === k)?.t ?? null;

  return (
    <div ref={box} className="panel-scroll story-root relative h-full" data-story-mode={mode} data-testid="story-root">
      {/* 진행 레일(데스크톱) */}
      <nav className="pointer-events-none fixed right-7 top-1/2 z-30 hidden -translate-y-1/2 flex-col items-end gap-3.5 xl:flex" aria-label="스토리 진행">
        {CH.map((c, i) => (
          <a
            key={c.key}
            href={`#ch-${i}`}
            ref={(el) => { rail.current[i] = el; }}
            onClick={(e) => { e.preventDefault(); go(i); }}
            className="story-rail pointer-events-auto flex items-center gap-2.5 text-[12px]"
            aria-current={active === i ? 'step' : undefined}
            data-testid={`story-rail-${i}`}
            style={{ ['--c' as string]: TONE[c.tone] }}
          >
            <span className={active === i ? 'text-ink' : 'text-ink-3'}><span className="font-mono text-[10.5px] opacity-70">{c.no}</span> {c.label}</span>
            <span className="story-rail-bar relative h-px overflow-hidden" style={{ width: active === i ? 40 : 14 }}><span className="absolute inset-y-0 left-0" /></span>
          </a>
        ))}
      </nav>

      {/* 발표 컨트롤(모든 화면 크기) */}
      <div className="pointer-events-none fixed bottom-5 right-5 z-30 flex justify-end">
        <div className="glass-float pointer-events-auto flex items-center gap-1 rounded-full py-1 pl-1 pr-1" data-testid="story-pager">
          <button type="button" onClick={() => go(Math.max(-1, active - 1))} disabled={active < 0} aria-label="이전 장" className="story-btn inline-flex h-8 w-8 items-center justify-center rounded-full text-ink-2 hover:text-ink disabled:opacity-30"><ChevronLeft size={16} /></button>
          <span className="min-w-[118px] px-1 text-center text-[12px] text-ink-2" aria-live="polite" data-testid="story-current">
            {active < 0 ? 'STORY · 시작' : <><b className="font-mono font-semibold text-ink">{CH[active].no}</b> / 05 · {CH[active].label}</>}
          </span>
          <button type="button" onClick={() => go(Math.min(CH.length - 1, active + 1))} disabled={active >= CH.length - 1} aria-label="다음 장" className="story-btn inline-flex h-8 w-8 items-center justify-center rounded-full text-ink-2 hover:text-ink disabled:opacity-30"><ChevronRight size={16} /></button>
        </div>
      </div>

      {/* 히어로 */}
      <section id="story-hero" data-ch={-1} className="story-wide grid min-h-full items-center gap-10 px-[7vw] py-20 xl:pr-[200px] lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
        <div>
          <div className="eyebrow reveal">EXIT-LINK · 저장된 TCP 실험 기록</div>
          <h1 style={{ ['--i' as string]: 1 }} className="display-xl reveal mt-6 text-[clamp(40px,4.4vw,84px)] text-ink [word-break:keep-all]" data-testid="story-hero-title">경로가 끊겨도,<br /><span className="text-sheen font-light">전달은 계속된다.</span></h1>
          <p style={{ ['--i' as string]: 2 }} className="reveal mt-8 max-w-[52ch] text-[17px] leading-relaxed text-ink-2">
            건물 안 6개 통신 노드가 실제 TCP 로 주고받은 기록을 그대로 따라갑니다. 정상 전달, 노드 장애, 우회, 그리고 ACK 까지 — 모든 시각과 경로는 실험 로그에서 읽었습니다.
          </p>
          {problem && <p role="alert" className="mt-6 text-[14px] text-[#F6C79A]">기록을 불러오지 못했습니다: {problem}</p>}
          <button type="button" onClick={() => go(0)} style={{ ['--i' as string]: 3 }} className="reveal mt-12 inline-flex w-fit items-center gap-2 text-[13px] uppercase tracking-[0.2em] text-ink-3 hover:text-ink">
            <ArrowDown size={14} className="story-bob" /> 스크롤해서 보기 · ←/→ 장 이동
          </button>
        </div>
        {cases.t012 && (
          <figure className="reveal story-visual mx-auto w-full max-w-[560px]" style={{ ['--i' as string]: 2 }}>
            <StoryNetwork trial={cases.t012} t={0} focus={null} idle label="실험 토폴로지 N1~N6과 기록된 연결" className="w-full" />
            <figcaption className="mt-3 text-center text-[12px] text-ink-3">
              실험 토폴로지 · 노드 {cases.t012.topology?.nodes.length ?? 0}개 · 연결 {cases.t012.topology?.edges.length ?? 0}개(기록 그대로) · 위치는 개략 배치
            </figcaption>
          </figure>
        )}
      </section>

      {/* 장면 01~04 */}
      <Scene i={0} win={wins.normal} trial={cases.t012} mode={mode} still={reduced} root={box} onProgress={setRail} active={active === 0} loaded={loaded}
        title="평소에는 가장 짧은 길로."
        cine={{ to: '/twin?mode=cinematic&case=t012', label: 't012 를 CINEMATIC 으로' }}
        stats={() => normalStats(cases.t012)}
      />
      <Scene i={1} win={wins.fault} trial={cases.t010} mode={mode} still={reduced} root={box} onProgress={setRail} active={active === 1} loaded={loaded}
        title={`중계 노드 ${cases.t010?.events.find((e) => e.event === 'fault_confirmed')?.node ?? '—'}가 멈춘다.`}
        cine={chT('fault') !== null ? { to: `/twin?mode=cinematic&case=t010&t=${chT('fault')}`, label: '장애 시점부터 CINEMATIC' } : null}
        stats={() => faultStats(cases.t010)}
      />
      <Scene i={2} win={wins.reroute} trial={cases.t010} mode={mode} still={reduced} root={box} onProgress={setRail} active={active === 2} loaded={loaded}
        title={<><span className="whitespace-nowrap">막힌 링크를 빼고,</span><br /><span className="whitespace-nowrap">다시 계산한다.</span></>}
        cine={chT('reroute') !== null ? { to: `/twin?mode=cinematic&case=t010&t=${chT('reroute')}`, label: '우회 시점부터 CINEMATIC' } : null}
        stats={() => rerouteStats(cases.t010)}
        hero
      />
      <Scene i={3} win={wins.ack} trial={cases.t010} mode={mode} still={reduced} root={box} onProgress={setRail} active={active === 3} loaded={loaded}
        title={<>전달의 완성은,<br />ACK로 확인된다.</>}
        cine={chT('ack') !== null ? { to: `/twin?mode=cinematic&case=t010&t=${chT('ack')}`, label: 'ACK 시점부터 CINEMATIC' } : null}
        stats={() => null}
        extra={(t) => <AckOrder trial={cases.t010} t={t} />}
      />

      {/* 장면 05 */}
      <CompareScene t000={cases.t000} still={reduced} />

      <footer className="px-[7vw] pb-28 pt-6 xl:pr-[200px]">
        <div className="hairline mb-8" />
        <p className="max-w-[78ch] text-[13.5px] leading-relaxed text-ink-3">{TWIN_REPLAY_NOTICE} STORY 의 경로는 통신 메시지 전달 경로이며 사람의 대피 동선이 아닙니다.</p>
      </footer>
    </div>
  );
}

/**
 * 장 이동용 감속 스크롤(ease-in-out). 거리에 비례해 0.7~1.5초. 사용자가 휠·터치·포인터·키를 쓰면 즉시 멈추고 양보합니다.
 * 휠 스크롤 자체는 가로채지 않습니다(브라우저 기본 스크롤 그대로).
 */
let glide: { stop: () => void } | null = null;
function glideTo(el: HTMLElement, top: number, instant: boolean) {
  glide?.stop();
  const from = el.scrollTop;
  const dist = top - from;
  if (instant || Math.abs(dist) < 2) { el.scrollTop = top; return; }
  const dur = Math.min(1500, Math.max(700, Math.abs(dist) * 0.25));
  const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  let raf = 0;
  const t0 = performance.now();
  const stop = () => { cancelAnimationFrame(raf); ['wheel', 'touchstart', 'pointerdown', 'keydown'].forEach((k) => el.removeEventListener(k, stop)); if (glide?.stop === stop) glide = null; };
  ['wheel', 'touchstart', 'pointerdown'].forEach((k) => el.addEventListener(k, stop, { passive: true }));
  const frame = (now: number) => {
    const u = Math.min(1, (now - t0) / dur);
    el.scrollTop = from + dist * ease(u);
    if (u < 1 && !document.hidden) raf = requestAnimationFrame(frame);
    else { el.scrollTop = top; stop(); }
  };
  raf = requestAnimationFrame(frame);
  glide = { stop };
}

// ── 장면(01~04) ─────────────────────────────────────────────────
interface SceneProps {
  i: number;
  win?: SceneWindow;
  trial?: ReplayCase;
  mode: 'scroll' | 'static';
  still: boolean;
  root: RefObject<HTMLDivElement>;
  onProgress: (i: number, p: number) => void;
  active: boolean;
  loaded: boolean;
  title: ReactNode;
  cine: { to: string; label: string } | null;
  stats: () => ReactNode;
  extra?: (t: number) => ReactNode;
  hero?: boolean;
}

const Scene = memo(function Scene({ i, win, trial, mode, still, root, onProgress, active, loaded, title, cine, stats, extra, hero }: SceneProps) {
  const ch = CH[i];
  const color = TONE[ch.tone];
  const secRef = useRef<HTMLElement>(null);
  const scroll = mode === 'scroll' && !!win && !!trial;
  const stickyRef = useRef<HTMLDivElement>(null);
  // 장면 끝(진행도 0.96~1)에서 살짝 위로 물러나며 옅어짐 — React 리렌더 없이 CSS 변수만
  const p = useSceneProgress(secRef, root, scroll, (v) => { onProgress(i, v); stickyRef.current?.style.setProperty('--sx', String(Math.min(1, Math.max(0, (v - 0.96) / 0.04)))); }, !still);
  const t = win ? (scroll ? sceneTime(win, p) : win.keyT) : 0;
  const beats = useMemo(() => (trial && win ? sceneBeats(trial, win) : []), [trial, win]);
  const lastPast = [...beats].reverse().find((b) => b.t <= t);
  const cell = trial?.cell;

  return (
    <section
      ref={secRef}
      id={`ch-${i}`}
      data-ch={i}
      data-scene={ch.key}
      data-active={active || undefined}
      className={scroll ? 'story-scene relative' : 'story-scene relative px-[7vw] py-24 xl:pr-[200px]'}
      style={scroll ? { height: `calc(var(--story-h, 100vh) * ${SCENE_SPAN})` } : undefined}
      aria-labelledby={`ch-${i}-title`}
    >
      <div ref={stickyRef} className={scroll ? 'story-sticky sticky top-0 grid h-[var(--story-h,100vh)] grid-rows-[auto_minmax(0,1fr)] items-center gap-4 px-[6vw] py-8 xl:pr-[200px] lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)] lg:grid-rows-1 lg:gap-12 lg:py-10' : 'grid items-center gap-10 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]'}>
        {/* 글 */}
        <div className="min-w-0">
          <div className="reveal flex items-center gap-3 font-mono text-[12px] uppercase tracking-[0.22em]" style={{ color, ['--i' as string]: 0 }}>
            <span className="h-px w-10" style={{ background: color }} />
            {ch.no} · {ch.label}
          </div>
          <h2 id={`ch-${i}-title`} style={{ ['--i' as string]: 1 }} className={`reveal story-title mt-4 max-w-[16ch] font-extralight [word-break:keep-all] leading-[1.02] tracking-[-0.035em] text-ink ${hero ? 'text-[min(76px,max(4.6vw,34px),calc((86vw-60px)/8.8))]' : 'text-[clamp(32px,4.2vw,68px)]'}`}>{title}</h2>
          {!loaded ? (
            <p className="mt-8 text-[14px] text-ink-3">저장된 기록을 불러오는 중입니다…</p>
          ) : !win || !trial ? (
            <p className="mt-8 text-[14px] text-ink-3">이 장면에 필요한 기록이 없습니다(기록 없음).</p>
          ) : (
            <>
              <div className="reveal mt-6" style={{ ['--i' as string]: 2 }}>{stats()}</div>
              {/* 이야기 줄: 기록된 이벤트가 재생 위치에 도달하면 밝아집니다 */}
              <ol style={{ ['--i' as string]: 3 }} className={`reveal mt-5 space-y-1.5 ${scroll ? 'story-beats-scroll' : ''}`} aria-label="이 장면의 기록 이벤트" data-testid={`story-beats-${i}`}>
                {beats.map((b) => {
                  const past = b.t <= t;
                  const cur = lastPast?.seq === b.seq;
                  return (
                    <li key={b.seq} data-past={past || undefined} data-current={cur || undefined} data-t={b.t} className="story-beat grid grid-cols-[76px_minmax(0,1fr)] items-baseline gap-3">
                      <span className="font-mono text-[11.5px] tabular-nums" style={{ color: past ? TONE[b.tone] : undefined }}>{sec(b.t)}</span>
                      <span className={cur ? 'text-[16px] font-medium text-ink' : 'text-[14px] text-ink-2'}>
                        {b.ko}
                        {b.oldRoute && b.route && <span className="ml-2 font-mono text-[12px]"><s className="text-[#FF9EA1]/70">{b.oldRoute.join('→')}</s> → <span className="text-[#BFE4FF]">{b.route.join('→')}</span></span>}
                      </span>
                    </li>
                  );
                })}
              </ol>
              {extra?.(t)}
              <div className="reveal mt-6 flex flex-wrap gap-2" style={{ ['--i' as string]: 4 }}>
                {cine && <Link to={cine.to} className="story-btn lift inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/[0.03] px-3.5 py-1.5 text-[12.5px] text-ink-2 hover:border-white/30 hover:text-ink" data-testid={`story-cine-${i}`}><Clapperboard size={13} /> {cine.label} <ArrowUpRight size={13} /></Link>}
                <Link to={`/replay?case=${win.caseId}&t=${Number(t.toFixed(4))}`} className="story-btn lift inline-flex items-center gap-1.5 rounded-full border border-white/10 px-3.5 py-1.5 text-[12.5px] text-ink-3 hover:border-white/25 hover:text-ink" data-testid={`story-replay-${i}`}><ScanSearch size={13} /> 이 시각을 REPLAY 분석에서</Link>
              </div>
            </>
          )}
        </div>

        {/* 네트워크 */}
        {win && trial && cell && (
          <figure className="reveal story-visual min-h-0 min-w-0" style={{ ['--i' as string]: 2 }} data-testid={`story-visual-${i}`}>
            <div className="mb-2 flex flex-wrap items-center gap-2 text-[11.5px]" data-testid={`story-source-${i}`}>
              <span className="rounded-full border px-2.5 py-0.5 font-mono" style={{ borderColor: `${color}66`, color }}>{win.caseId}</span>
              <span className="text-ink-2">{cell.method === 'fixed' ? 'Fixed' : 'EXIT-LINK'} · {cell.condition}{cell.fault_timing && cell.fault_timing !== 'none' ? ` · ${cell.fault_timing}` : ''}</span>
              <span className="text-ink-3">저장된 기록 · 실시간 아님</span>
            </div>
            <StoryNetwork trial={trial} t={t} focus={win.focus} still={still} label={`${win.caseId} 기록 시각 ${sec(t)}의 네트워크 상태`} className={scroll ? 'story-net-scroll mx-auto w-full' : 'mx-auto w-full max-w-[640px]'} />
            <TimeStrip win={win} t={t} beats={beats.map((b) => b.t)} color={color} scroll={scroll} i={i} />
          </figure>
        )}
      </div>
    </section>
  );
});

function TimeStrip({ win, t, beats, color, scroll, i }: { win: SceneWindow; t: number; beats: number[]; color: string; scroll: boolean; i: number }) {
  const f = (x: number) => `${(((x - win.t0) / Math.max(1e-9, win.t1 - win.t0)) * 100).toFixed(3)}%`;
  return (
    <figcaption className="mt-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-[12px]">
        <span className="text-ink-2">기록 시각 <b className="font-mono font-semibold text-ink" data-testid={`story-t-${i}`} data-t={t}>{sec(t)}</b></span>
        <span className="font-mono text-[11px] text-ink-3">구간 {sec(win.t0)} → {sec(win.t1)}</span>
      </div>
      <div className="relative mt-1.5 h-[3px] rounded-full bg-white/10">
        <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: f(t), background: color }} />
        {beats.map((b) => <span key={b} className="absolute -top-[3px] h-[9px] w-px bg-white/45" style={{ left: f(b) }} />)}
      </div>
      <p className="mt-1.5 text-[11px] leading-snug text-ink-3">
        {scroll ? '스크롤 = 이 사례 기록을 시간순으로 탐색(기록 시각·측정값은 원본 그대로). ' : '이 장면의 마지막 기록 시점을 정적으로 표시합니다. '}
        점선 외곽 링 마커는 기록된 송신·수신 사이의 시각적 보간입니다. 통신 메시지 경로이며 대피 동선이 아닙니다.
      </p>
    </figcaption>
  );
}

function Stat({ k, v, sub }: { k: string; v: ReactNode; sub?: ReactNode }) {
  return (
    <div className="story-stat min-w-0 border-l border-white/10 pl-4">
      <dt className="text-[11px] uppercase tracking-[0.14em] text-ink-3">{k}</dt>
      <dd className="mt-1 text-[19px] font-light leading-snug tracking-[-0.01em] text-ink">{v}</dd>
      {sub && <dd className="mt-0.5 text-[11.5px] text-ink-3">{sub}</dd>}
    </div>
  );
}
const StatRow = ({ children }: { children: ReactNode }) => <dl className="grid max-w-[680px] grid-cols-1 gap-4 sm:grid-cols-3">{children}</dl>;

function normalStats(c?: ReplayCase) {
  if (!c) return null;
  const routes = [...new Set(c.messages.map((m) => (m.result?.route ?? []).join(' → ')))].filter(Boolean);
  return (
    <StatRow>
      <Stat k="전달 경로" v={<span className="font-mono text-[17px]">{routes.join(' / ') || '기록 없음'}</span>} sub="결과에 기록된 route" />
      <Stat k="ACK" v={`${c.messages.filter((m) => m.result?.ack).length} / ${c.messages.length}`} sub="메시지별 결과 ack" />
      <Stat k="측정 지연" v={<span className="font-mono text-[15px]">{c.messages.map((m) => ms(m.result?.client_elapsed_ms)).join(' · ')}</span>} sub="클라이언트 측정값(기록 시각과 다름)" />
    </StatRow>
  );
}
function faultStats(c?: ReplayCase) {
  if (!c) return null;
  const fault = c.events.find((e) => e.event === 'fault_confirmed');
  const down = c.events.filter((e) => e.event === 'neighbor_down');
  const m0 = c.messages.find((m) => m.message_id === reroutedMessage(c));
  const att = m0?.attempts?.[0];
  return (
    <StatRow>
      <Stat k="장애 확인" v={fault ? `${fault.node} · ${sec(fault.offset_ms)}` : '기록 없음'} sub="fault_confirmed · 기록 시각" />
      <Stat k="이웃 판정(down)" v={<span className="text-[15px]">{down.length ? down.map((e) => `${e.node}→${e.neighbor} ${sec(e.offset_ms)}`).join(' · ') : '기록 없음'}</span>} sub="neighbor_down" />
      <Stat k={`M${m0?.position ?? '—'} 첫 시도`} v={<span className="font-mono text-[15px]">{att ? `${att.route.join('→')}` : '기록 없음'}</span>} sub={att ? `${ms(att.duration_ms)} 측정 · ${att.outcome}` : undefined} />
    </StatRow>
  );
}
function rerouteStats(c?: ReplayCase) {
  if (!c) return null;
  const id = reroutedMessage(c);
  const rc = c.events.find((e) => e.event === 'route_changed' && e.message_id === id);
  const m = c.messages.find((x) => x.message_id === id);
  const before = id ? routeBeforeChange(c, id) : null;
  return (
    <StatRow>
      <Stat k="경로 변경" v={rc ? sec(rc.offset_ms) : '기록 없음'} sub={rc ? `route_changed · 시도 ${rc.attempt ?? '—'}` : undefined} />
      <Stat k="이전 → 새 경로" v={<span className="font-mono text-[15px]"><s className="text-[#FF9EA1]/75">{before?.join('→') ?? '—'}</s><br /><span className="text-[#BFE4FF]">{rc?.route?.join(' → ') ?? '기록 없음'}</span></span>} />
      <Stat k="제외 링크 · 재전송" v={<span className="font-mono text-[15px]">{(rc?.excluded_links ?? []).map((l) => l.join('–')).join(', ') || '기록 없음'}</span>} sub={`M${m?.position ?? '—'} 재전송 ${m?.result?.retries ?? '기록 없음'}회`} />
    </StatRow>
  );
}

/** ACK 도착 순서: 출발 노드의 ack_received 기록 시각 순. 재생 위치가 그 시각에 도달해야 초록으로 표시합니다. */
function AckOrder({ trial, t }: { trial?: ReplayCase; t: number }) {
  if (!trial) return null;
  const order = ackOrder(trial);
  return (
    <div className="mt-5 max-w-[680px]" data-testid="story-ack-order">
      <div className="mb-2 text-[11px] uppercase tracking-[0.14em] text-ink-3">ACK 도착 순서 · 기록 시각 / 측정 지연 / 재전송</div>
      <ol className="flex flex-wrap items-stretch gap-2">
        {order.map(({ m, e }, k) => {
          const done = e.offset_ms <= t;
          return (
            <li key={m.position} className="flex items-center gap-2">
              {k > 0 && <span className="text-ink-3">→</span>}
              <div className={`story-ack rounded-2xl border px-3 py-2 transition-colors ${done ? 'border-[#3FC28A]/55 bg-[#3FC28A]/[0.08]' : 'border-white/10 bg-white/[0.02]'}`} data-done={done || undefined} data-testid={`story-ack-M${m.position}`}>
                <div className="flex items-baseline gap-2">
                  <b className="font-mono text-[15px] text-ink">M{m.position}</b>
                  <span className={`text-[11.5px] ${done ? 'text-[#8FE6BE]' : 'text-ink-3'}`}>{done ? 'ACK 기록됨' : '아직 기록 전'}</span>
                </div>
                <div className="mt-0.5 font-mono text-[11px] text-ink-3">{sec(e.offset_ms)} · {ms(m.result?.client_elapsed_ms)} · 재전송 {m.result?.retries ?? '—'}</div>
              </div>
            </li>
          );
        })}
      </ol>
      <p className="mt-2 text-[11px] text-ink-3">기록 시각은 관측 구간 시작 기준(benchmark_perf_ns), 측정 지연은 클라이언트가 잰 전송~ACK 시간입니다. 두 값은 서로 다릅니다.</p>
    </div>
  );
}

// ── 장면 05: 연구 성과 ───────────────────────────────────────────
function CompareScene({ t000, still }: { t000?: ReplayCase; still: boolean }) {
  const d = rowOf(study.overall, 'overall', 'delivered');
  const caveats = useMemo(() => caveatItems(), []);
  const color = TONE.fail;
  return (
    <section id="ch-4" data-ch={4} data-scene="compare" className="story-scene px-[7vw] py-24 xl:pr-[200px]" aria-labelledby="ch-4-title">
      <div className="reveal flex items-center gap-3 font-mono text-[12px] uppercase tracking-[0.22em]" style={{ color }}>
        <span className="h-px w-10" style={{ background: color }} /> 05 · 연구 성과
      </div>
      <h2 id="ch-4-title" data-testid="story-compare-title" style={{ ['--i' as string]: 1 }} className="reveal mt-4 max-w-[16ch] text-[clamp(30px,3.6vw,64px)] font-extralight leading-[1.04] tracking-[-0.035em] text-ink [word-break:keep-all] lg:max-w-none lg:whitespace-nowrap">고정 경로는 장애 앞에서 멈춘다.</h2>
      {!d || !studyValid ? (
        <p className="mt-8 text-[14px] text-ink-3">검증된 연구 결과를 읽지 못했습니다.</p>
      ) : (
        <div className="mt-10 grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div>
            <div className="grid grid-cols-2 gap-6" data-testid="story-rates">
              <BigRate label="Fixed · 고정 경로" color="#C86A9A" value={pct(d.fixed_rate)} frac={`${d.fixed_success}/${d.fixed_n}`} ci={pctRange(d.fixed_ci_low, d.fixed_ci_high)} testId="story-rate-fixed" />
              <BigRate label="EXIT-LINK · 자동 재라우팅" color="#4A8FE0" value={pct(d.exit_link_rate)} frac={`${d.exit_link_success}/${d.exit_link_n}`} ci={pctRange(d.exit_link_ci_low, d.exit_link_ci_high)} testId="story-rate-exit" i={3} />
            </div>
            <div className="reveal mt-8 border-t border-white/10 pt-6" style={{ ['--i' as string]: 3 }}>
              <div className="text-[11px] uppercase tracking-[0.14em] text-ink-3">차이(EXIT-LINK − Fixed)</div>
              <div className="mt-1 text-[clamp(36px,4vw,60px)] font-extralight leading-none tracking-[-0.03em] text-[#BFE4FF]" data-testid="story-diff">{pp(d.diff_exit_minus_fixed)}</div>
              <div className="mt-2 text-[12.5px] text-ink-3">95% 구간 {ppRange(d.diff_ci_low, d.diff_ci_high)} · 대응 셀 bootstrap</div>
            </div>
            <p className="reveal mt-6 max-w-[60ch] text-[13px] leading-relaxed text-ink-3" style={{ ['--i' as string]: 4 }} data-testid="story-sample">
              유효 대응 쌍 <b className="font-medium text-ink-2">{d.pairs}</b>개 · 방식별 메시지 {d.messages_per_method}건 · 유효 셀 {study.sample.valid_cells}/{study.sample.planned_cells} · {study.label}.
              지표는 관측 구간 안 목적지 수신(delivered)입니다. 저장된 결과이며 실시간 값이 아닙니다.
            </p>
            <div className="reveal mt-6 flex flex-wrap gap-2" style={{ ['--i' as string]: 5 }}>
              <Link to="/analytics" className="story-btn lift inline-flex items-center gap-2 rounded-full border border-white/15 px-4 py-2 text-[13px] text-ink hover:border-white/30" data-testid="story-analytics"><BarChart3 size={14} /> 전체 연구 결과(Analytics) <ArrowUpRight size={14} /></Link>
              <Link to="/twin?mode=cinematic&case=t010" className="story-btn lift inline-flex items-center gap-2 rounded-full bg-gradient-to-b from-[#F4F8FF] to-[#C6D6EC] px-4 py-2 text-[13px] font-semibold text-[#0A1220]" data-testid="story-demo"><Clapperboard size={14} /> Digital Twin 데모 시작 <ArrowUpRight size={14} /></Link>
            </div>
          </div>
          <div className="min-w-0 space-y-6">
            <RateBars fixed={[d.fixed_rate, d.fixed_ci_low, d.fixed_ci_high]} exit={[d.exit_link_rate, d.exit_link_ci_low, d.exit_link_ci_high]} />
            {t000 && (
              <div className="reveal rounded-3xl border border-white/[0.08] bg-white/[0.02] p-5" style={{ ['--i' as string]: 3 }} data-testid="story-t000">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="text-[13px] text-ink">사례 t000 · Fixed · {t000.cell.condition} · {t000.cell.fault_timing}</div>
                  <span className="rounded-full border border-white/12 px-2 py-0.5 text-[11px] text-ink-3">사례 1건 · 통계 표본 아님</span>
                </div>
                <div className="mt-3 grid items-center gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
                  <StoryNetwork trial={t000} t={t000.clock.observation_end_offset_ms ?? 0} focus={null} still={still} label="t000 관측 구간 끝의 네트워크 상태" className="w-full" />
                  <dl className="space-y-3">
                    <Stat k="ACK" v={`${t000.messages.filter((m) => m.result?.ack).length} / ${t000.messages.length}`} sub="결과 ack" />
                    <Stat k="장애 확인" v={t000.events.filter((e) => e.event === 'fault_confirmed').map((e) => `${e.node} ${sec(e.offset_ms)}`).join(' · ') || '기록 없음'} />
                    <Stat k="오류" v={<span className="font-mono text-[15px]">{[...new Set(t000.messages.map((m) => m.result?.error).filter(Boolean))].join(', ') || '기록 없음'}</span>} sub="고정 경로는 우회하지 않음" />
                  </dl>
                </div>
                <Link to="/twin?mode=cinematic&case=t000" className="story-btn mt-3 inline-flex items-center gap-1.5 text-[12.5px] text-ink-3 hover:text-ink" data-testid="story-cine-t000"><Clapperboard size={13} /> t000 을 CINEMATIC 으로 <ArrowUpRight size={13} /></Link>
              </div>
            )}
          </div>
          <div className="reveal lg:col-span-2" data-testid="story-caveats">
            <div className="mb-3 text-[13px] text-ink">해석 주의사항 · 한계</div>
            <ul className="grid grid-cols-1 gap-x-10 gap-y-2 text-[13px] leading-relaxed text-ink-3 lg:grid-cols-2">
              {caveats.map((c) => <li key={c} className="flex gap-2.5"><span aria-hidden className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-ink-3" />{c}</li>)}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}

function BigRate({ label, color, value, frac, ci, testId, i = 2 }: { label: string; color: string; value: string; frac: string; ci: string; testId: string; i?: number }) {
  return (
    <div className="reveal" style={{ ['--i' as string]: i }} data-testid={testId}>
      <div className="flex items-center gap-2 text-[12px] text-ink-2"><span className="h-2 w-2 rounded-full" style={{ background: color }} />{label}</div>
      <div className="mt-2 text-[clamp(44px,5.4vw,88px)] font-extralight leading-none tracking-[-0.045em] text-ink" data-value={value}>{value}</div>
      <div className="mt-2 font-mono text-[13px] text-ink-2" data-frac={frac}>{frac} 전달</div>
      <div className="mt-0.5 text-[11.5px] text-ink-3">95% 구간 {ci}</div>
    </div>
  );
}

/** 전달 성공률 막대 + 95% 구간(0~100% 축). 장면에 들어오면 왼쪽에서 차오릅니다(움직임 줄이기에서는 바로 표시). */
function RateBars({ fixed, exit }: { fixed: [number, number, number]; exit: [number, number, number] }) {
  const rows: [string, string, [number, number, number]][] = [['Fixed', '#C86A9A', fixed], ['EXIT-LINK', '#4A8FE0', exit]];
  return (
    <figure className="reveal story-bars" aria-label="전달 성공률 비교(95% 구간 포함)">
      <div className="space-y-5">
        {rows.map(([name, col, [r, lo, hi]]) => (
          <div key={name}>
            <div className="flex justify-between text-[12px] text-ink-2"><span>{name}</span><span className="font-mono">{pct(r)}</span></div>
            <div className="relative mt-1.5 h-3 rounded-full bg-white/[0.06]">
              <span className="story-bar absolute inset-y-0 left-0 rounded-full" style={{ width: `${r * 100}%`, background: col }} />
              <span className="absolute top-1/2 h-px bg-white/70" style={{ left: `${lo * 100}%`, width: `${(hi - lo) * 100}%` }} />
              <span className="absolute top-[-3px] h-[18px] w-px bg-white/70" style={{ left: `${lo * 100}%` }} />
              <span className="absolute top-[-3px] h-[18px] w-px bg-white/70" style={{ left: `${hi * 100}%` }} />
            </div>
          </div>
        ))}
        <div className="flex justify-between font-mono text-[10.5px] text-ink-3"><span>0%</span><span>50%</span><span>100%</span></div>
      </div>
      <figcaption className="mt-2 text-[11.5px] text-ink-3">전체 조건 · 전달 성공률 · 흰 선 = 95% 구간</figcaption>
    </figure>
  );
}
