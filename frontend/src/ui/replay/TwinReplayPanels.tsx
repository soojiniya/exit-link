import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Focus, History, Pause, Play, RotateCcw } from 'lucide-react';
import { NODE_STATUS_LABEL, STATUS_COLOR } from '@/domain/network';
import { STAGE_COLOR, STAGE_LABEL, describeEvent, type TimelineKind, type TimelineMark } from '@/domain/replayEngine';
import { cx } from '@/ui/primitives';
import { HudTile, type HudTone } from '@/ui/twin/HudTile';
import type { TwinReplayState } from './useTwinReplay';
import type { CaptionTone } from './cinematicDirector';

/**
 * Digital Twin REPLAY · CINEMATIC 화면 조각. 모든 값은 useTwinReplay(공통 재생 엔진)에서만 받습니다.
 * 연출(배너·장 이동·카드 강조)은 기록된 이벤트 시각과 상태를 따라가며, 이벤트를 새로 만들지 않습니다.
 */
export const TWIN_REPLAY_NOTICE = '저장된 TCP 실험 기록을 재생하는 시각화입니다. 메시지의 연속 이동은 시각적으로 보간되며, 사람의 실제 대피 동선을 나타내지 않습니다.';
const SPEEDS = [0.1, 0.25, 0.5, 1, 2] as const;
const MARK: Record<TimelineKind, { color: string; text: string; tone: HudTone }> = {
  fault: { color: '#EF5A5F', text: '장애 확인', tone: 'fail' },
  send: { color: '#7CC8FF', text: '전송 시작', tone: 'info' },
  ack: { color: '#3FC28A', text: 'ACK 수신', tone: 'ok' },
  error: { color: '#EF5A5F', text: '오류', tone: 'fail' },
  retry: { color: '#E9954A', text: '재전송 예약', tone: 'warn' },
  reroute: { color: '#E9954A', text: '경로 변경', tone: 'warn' },
};
export const fmt = (ms: number) => `+${(ms / 1000).toFixed(3)}s`;

function StagePill({ stage }: { stage: keyof typeof STAGE_LABEL }) {
  const c = STAGE_COLOR[stage];
  return <span className="rounded-full border px-2 py-0.5 text-[11px] font-semibold" style={{ color: c, background: `${c}1a`, borderColor: `${c}55` }}>{STAGE_LABEL[stage]}</span>;
}

/** 상단 control bar 의 재생 영역: 사례 · 초기화 · 재생 · 속도 · 시각 */
export function TwinReplayTransport({ r }: { r: TwinReplayState }) {
  const { trial, pb, duration, t } = r;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2" data-testid="twin-replay-controls">
      <div className="seg" role="tablist" aria-label="재생 사례">
        {r.manifest?.cases.map((c) => (
          <button key={c.id} role="tab" aria-selected={c.id === r.caseId} onClick={() => r.setCaseId(c.id)} title={c.description}>
            {c.title.split('·')[0].trim()} <span className="font-mono text-ink-3">{c.id}</span>
          </button>
        ))}
      </div>
      {r.problem && <span role="alert" className="flex items-center gap-1 text-[12px] text-[#F6C79A]"><AlertCircle size={13} />{r.problem}</span>}
      {trial && (
        <>
          <span aria-hidden className="mx-1 h-5 w-px bg-white/10" />
          <button type="button" onClick={pb.reset} aria-label="초기화" title="처음으로" className="lift inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/[0.05] text-ink hover:border-white/25">
            <RotateCcw size={14} />
          </button>
          <button
            type="button"
            onClick={pb.toggle}
            aria-label={pb.playing ? '일시정지' : '재생'}
            className="lift inline-flex h-8 min-w-[96px] items-center justify-center gap-1.5 rounded-full bg-gradient-to-b from-[#F4F8FF] to-[#C6D6EC] px-3.5 text-[13px] font-semibold text-[#0A1220] shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_6px_18px_-8px_rgba(124,200,255,0.7)] hover:brightness-110"
          >
            {pb.playing ? <Pause size={14} /> : <Play size={14} />} {pb.playing ? '일시정지' : '재생'}
          </button>
          <div className="seg" role="tablist" aria-label="재생 속도">
            {SPEEDS.map((s) => (
              <button key={s} role="tab" aria-selected={pb.speed === s} onClick={() => pb.setSpeed(s)}>{s}×</button>
            ))}
          </div>
          <span className="font-mono text-[13px] tabular-nums text-ink" data-testid="twin-replay-time">{fmt(t)} / {fmt(duration)}</span>
        </>
      )}
    </div>
  );
}

/** 좌상단 핵심 상태 4개 + 현재 이벤트 헤드라인 */
export function TwinReplayHud({ r, cinematic }: { r: TwinReplayState; cinematic: boolean }) {
  const { trial, progress, sel, nodes, keyMark } = r;
  const caseTitle = r.manifest?.cases.find((c) => c.id === r.caseId)?.title ?? r.caseId;
  const acked = progress.filter((p) => p.stage === 'acked').length;
  const failed = progress.filter((p) => p.stage === 'failed').length;
  const faults = nodes.filter((n) => n.status === 'fail').map((n) => n.id);
  const suspect = nodes.filter((n) => n.status === 'warn').map((n) => n.id);
  return (
    <div className={cx('pointer-events-none flex w-[250px] flex-col gap-2.5', cinematic && 'hud-compact')}>
      <span className="pill pointer-events-auto w-fit border-ice/40 bg-ice/[0.08] text-[12px] font-semibold text-ice" data-testid="twin-replay-badge">
        <History size={12} /> {cinematic ? 'CINEMATIC' : 'REPLAY'} · 저장된 실험 기록 · 실시간 아님
      </span>
      {trial && sel && (
        <div className="pointer-events-auto grid gap-1.5">
          <HudTile large={cinematic} label="사례" value={caseTitle} sub={`${trial.cell.method === 'fixed' ? 'Fixed' : 'EXIT-LINK'} · ${trial.cell.cell}`} tone="neutral" testId="twin-hud-case" />
          <HudTile
            label={`M${sel.position} 메시지 경로`}
            value={sel.route ? sel.route.join(' → ') : '기록 없음'}
            sub={sel.previousRoute ? <span>이전 <s className="text-[#FFA9AC]">{sel.previousRoute.join('→')}</s> · 시도 {sel.attempt}</span> : `${STAGE_LABEL[sel.stage]} · 시도 ${sel.attempt || '—'}`}
            tone={sel.previousRoute ? 'warn' : sel.stage === 'failed' ? 'fail' : 'info'}
            testId="twin-hud-route"
          />
          <HudTile
            label="ACK"
            value={`${acked} / ${trial.messages.length}`}
            sub={failed ? `미수신 ${failed}건(기록)` : '재생 위치까지 수신'}
            tone={failed ? 'fail' : acked ? 'ok' : 'idle'}
            testId="twin-hud-ack"
          />
          <HudTile
            label="장애"
            value={faults.length ? faults.join(' · ') : suspect.length ? `의심 ${suspect.join(' · ')}` : '확인 기록 없음'}
            sub={faults.length ? '장애 확인 기록(fault_confirmed)' : suspect.length ? '이웃 판정 기록' : '정상으로 단정하지 않음'}
            tone={faults.length ? 'fail' : suspect.length ? 'warn' : 'idle'}
            testId="twin-hud-fault"
          />
        </div>
      )}
      {!cinematic && keyMark && <EventHeadline mark={keyMark} large={false} />}
    </div>
  );
}

/** 현재 이벤트 헤드라인: 재생 위치 이전의 가장 최근 핵심 기록. 값이 바뀔 때만 짧게 등장합니다. */
function EventHeadline({ mark, large }: { mark: TimelineMark; large: boolean }) {
  const m = MARK[mark.kind];
  return (
    <div key={`${mark.kind}-${mark.t}`} className="headline-enter pointer-events-auto mt-2 w-[min(440px,40vw)]" data-testid="twin-event-headline">
      <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em]" style={{ color: m.color }}>
        <span className="h-px w-6" style={{ background: m.color }} />
        {m.text} · {fmt(mark.t)}
      </div>
      <div className={cx('mt-1 font-light tracking-[-0.02em] text-ink [text-shadow:0_2px_18px_rgba(0,0,0,0.9)]', large ? 'text-[36px] leading-[1.08]' : 'text-[22px] leading-tight')}>{mark.label}</div>
    </div>
  );
}

const CAPTION_TONE: Record<CaptionTone, string> = { fail: '#FF7A7F', warn: '#F2A766', ok: '#4FD39A', info: '#8FD3FF' };
/** 재생 중 캡션이 화면에 머무는 시간(화면 시간). 일시정지 중에는 계속 보입니다(발표자 설명용). */
const CAPTION_MS = 3400;

/**
 * CINEMATIC 이벤트 타이포그래피: 영문 보조 라벨 + 한글 제목 + 기록 경로 한 줄.
 * - 재생 위치 이전에 실제로 기록된 이벤트만(cinematicDirector.captionAt). 한 번에 하나만.
 * - 중요도(weight)에 따라 크기, 성격(tone)에 따라 색. 짧게 등장했다가 재생 중이면 잠시 뒤 물러납니다.
 * - 3D 를 가리지 않도록 왼쪽 HUD 아래 고정 영역에만 표시합니다.
 */
export function CinematicCaption({ r }: { r: TwinReplayState }) {
  const cap = r.caption;
  const playing = r.pb.playing;
  const key = cap?.key ?? '';
  const shownAt = useMemo(() => performance.now(), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const [, tick] = useState(0);
  useEffect(() => {
    if (!playing || !key) return;
    const left = CAPTION_MS - (performance.now() - shownAt);
    if (left <= 0) return;
    const id = window.setTimeout(() => tick((x) => x + 1), left + 30);
    return () => window.clearTimeout(id);
  }, [playing, key, shownAt]);
  if (!cap) return null;
  const out = playing && performance.now() - shownAt > CAPTION_MS;
  const color = CAPTION_TONE[cap.tone];
  const size = cap.weight === 3 ? 'text-[clamp(20px,min(2.15vw,4.6vh),36px)]' : cap.weight === 2 ? 'text-[clamp(18px,min(1.75vw,3.8vh),29px)]' : 'text-[clamp(17px,1.4vw,22px)]';
  return (
    <div
      key={cap.key}
      data-testid="twin-event-headline"
      data-caption-en={cap.en}
      aria-live="polite"
      className={cx('cine-caption pointer-events-none w-[min(560px,38vw)] min-w-[280px]', out && 'is-out')}
    >
      <div className="flex items-center gap-2.5 font-mono text-[11.5px] font-medium uppercase tracking-[0.2em]" style={{ color }}>
        <span className="cine-rule h-px w-8" style={{ background: color, boxShadow: `0 0 10px ${color}` }} />
        <span className="truncate">{cap.en}</span>
      </div>
      <div className={cx('mt-1.5 font-semibold leading-[1.08] tracking-[-0.025em] text-ink [text-shadow:0_2px_22px_rgba(0,0,0,0.95)]', size)}>{cap.ko}</div>
      {cap.route && (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 font-mono text-[clamp(14px,1.25vw,19px)] [text-shadow:0_2px_14px_rgba(0,0,0,0.9)]">
          {cap.oldRoute && (
            <>
              <s className="text-[#FF9EA1]/75 decoration-[#FF9EA1]/60">{cap.oldRoute.join(' → ')}</s>
              <span className="text-ink-3">⇒</span>
            </>
          )}
          <span style={{ color: cap.tone === 'fail' ? '#FFB3B6' : cap.tone === 'ok' ? '#9EEBC6' : '#CFEAFF' }}>{cap.route.join(' → ')}</span>
        </div>
      )}
      <div className="cine-detail mt-1.5 font-mono text-[11.5px] text-ink-3 [text-shadow:0_1px_8px_rgba(0,0,0,0.9)]">{fmt(cap.t)} · {cap.detail}</div>
    </div>
  );
}

/** 하단 이벤트 덱: 핵심 이벤트 카드 · 타임라인 · 메시지 선택 · 안내 */
export function TwinReplayDeck({ r, cinematic }: { r: TwinReplayState; cinematic: boolean }) {
  const { trial, pb, duration, t, marks, progress, sel, chapters } = r;
  const pct = (x: number) => `${Math.min(100, Math.max(0, (x / duration) * 100)).toFixed(3)}%`;
  const key = marks.filter((m) => m.kind !== 'send');
  const cards = useRef<HTMLDivElement>(null);
  const current = r.keyMark;
  useEffect(() => {
    const el = cards.current?.querySelector<HTMLElement>('[data-current="1"]');
    if (el && cards.current) cards.current.scrollTo({ left: el.offsetLeft - cards.current.clientWidth / 2 + el.clientWidth / 2, behavior: 'smooth' });
  }, [current]);
  const go = (x: number) => { pb.setPlaying(false); pb.seek(x); };
  return (
    <div className="space-y-3 px-5 pb-4 pt-3">
      {cinematic ? (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="시연 장 이동">
          {chapters.map((c, i) => {
            const done = c.t !== null && c.t <= t;
            return (
              <button
                key={c.key}
                type="button"
                disabled={c.t === null}
                onClick={() => c.t !== null && go(c.t)}
                data-testid={`twin-chapter-${c.key}`}
                title={c.t === null ? '이 사례에는 해당 기록이 없습니다' : `${fmt(c.t)}로 이동`}
                className={cx('chapter lift group flex items-baseline gap-3 rounded-2xl border px-4 py-2.5 text-left disabled:cursor-not-allowed disabled:opacity-35', done ? 'border-white/20 bg-white/[0.06]' : 'border-white/10 bg-white/[0.02]')}
              >
                <span className="font-mono text-[11px] text-ink-3">0{i + 1}</span>
                <span className="text-[16px] font-medium text-ink">{c.label}</span>
                <span className="font-mono text-[11px] text-ink-3">{c.t === null ? '기록 없음' : fmt(c.t)}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <div ref={cards} className="no-scrollbar flex gap-2 overflow-x-auto pb-1" role="list" aria-label="핵심 이벤트">
          {key.length === 0 && <div className="text-[13px] text-ink-3">이 사례에는 장애·재전송·ACK 같은 핵심 이벤트 기록이 없습니다.</div>}
          {key.map((m, i) => {
            const past = m.t <= t;
            const isCur = current?.t === m.t && current?.kind === m.kind;
            const s = MARK[m.kind];
            return (
              <button
                key={i}
                role="listitem"
                type="button"
                data-current={isCur ? '1' : undefined}
                onClick={() => go(m.t)}
                className={cx('event-card lift spotlight relative min-w-[178px] shrink-0 rounded-2xl border px-3.5 py-2.5 text-left transition', past ? 'opacity-100' : 'opacity-45', isCur ? 'bg-white/[0.07]' : 'bg-white/[0.025] hover:bg-white/[0.05]')}
                style={{ borderColor: isCur ? `${s.color}99` : 'rgba(255,255,255,0.09)', boxShadow: isCur ? `0 0 0 1px ${s.color}55, 0 0 26px -10px ${s.color}` : undefined }}
              >
                <span className="absolute left-0 top-3 h-6 w-[3px] rounded-r" style={{ background: s.color }} />
                <div className="flex items-center justify-between gap-2 font-mono text-[11px]">
                  <span style={{ color: s.color }}>{s.text}</span>
                  <span className="text-ink-3">{fmt(m.t)}</span>
                </div>
                <div className="mt-1 truncate text-[13.5px] text-ink">{m.label}</div>
              </button>
            );
          })}
        </div>
      )}

      {trial && (
        <div>
          <div className="relative h-4">
            {marks.map((m, i) => (
              <button key={i} type="button" onClick={() => go(m.t)} title={`${m.label} · ${fmt(m.t)}`} aria-label={`${m.label} ${fmt(m.t)}`} className="absolute top-0 -translate-x-1/2" style={{ left: pct(m.t) }}>
                <span className={cx('block h-3 w-1.5 rounded-sm transition-transform hover:scale-125', m.kind === 'fault' && 'h-3 w-3 rotate-45 rounded-[3px]')} style={{ background: MARK[m.kind].color, boxShadow: `0 0 6px ${MARK[m.kind].color}` }} />
              </button>
            ))}
          </div>
          <input type="range" min={0} max={duration} step={0.1} value={t} onChange={(e) => go(Number(e.target.value))} aria-label="기록 재생 위치" className="timeline-range w-full" style={{ ['--p' as string]: pct(t) }} />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="메시지 선택">
          {progress.map((p) => (
            <button
              key={p.messageId}
              onClick={() => r.setPicked(p.messageId)}
              data-testid={`twin-replay-msg-${p.position}`}
              className={cx('lift flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px]', p.messageId === sel?.messageId ? 'border-action/60 bg-action/10 text-ink shadow-glow-action' : 'border-white/10 text-ink-2 hover:border-white/25')}
            >
              <span className="font-mono">M{p.position}</span>
              <StagePill stage={p.stage} />
            </button>
          ))}
          {!r.following && <button className="text-[12px] text-action hover:underline" onClick={() => r.setPicked(null)}>자동 추적</button>}
          <button
            onClick={() => r.setFocusOnly(!r.focusOnly)}
            aria-pressed={r.focusOnly}
            className={cx('lift flex items-center gap-1 rounded-full border px-2.5 py-1 text-[12px]', r.focusOnly ? 'border-action/50 text-action' : 'border-white/10 text-ink-3 hover:text-ink')}
            title="선택한 메시지의 마커만 표시"
          >
            <Focus size={12} /> 선택 메시지만
          </button>
        </div>
        <p className="ml-auto max-w-[620px] text-right text-[12px] leading-snug text-ink-3" data-testid="twin-replay-notice">{TWIN_REPLAY_NOTICE}</p>
      </div>
    </div>
  );
}

/** 오른쪽 패널: 선택 메시지 → 노드 상태 → 범례 → 기록 없음·출처(접힘) */
export function TwinReplayAside({ r }: { r: TwinReplayState }) {
  const { trial, nodes, sel, selMsg } = r;
  return (
    <div className="space-y-5 px-5 py-5">
      <section className="glass-inset rounded-2xl p-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[12px] font-medium uppercase tracking-[0.14em] text-ink-3">선택 메시지</span>
          {sel && <StagePill stage={sel.stage} />}
        </div>
        {selMsg && sel ? (
          <>
            <div className="text-[20px] font-semibold tracking-[-0.01em]">M{sel.position} <span className="font-mono text-[14px] font-normal text-ink-2">{(selMsg.result?.route ?? sel.route ?? []).join(' → ') || '경로 기록 없음'}</span></div>
            {sel.previousRoute && sel.route && (
              <div className="mt-2 rounded-xl border border-[#E9954A]/30 bg-[#E9954A]/[0.06] px-3 py-2 font-mono text-[13px]" data-testid="twin-replay-reroute">
                <span className="text-[#F6C79A]">우회: </span>
                <s className="text-ink-3">{sel.previousRoute.join('→')}</s>
                <span className="text-ink-3"> ⇒ </span>
                <span className="text-[#BFE4FF]">{sel.route.join('→')}</span>
              </div>
            )}
            <dl className="mt-3 grid grid-cols-2 gap-2 text-[13px]">
              <div className="rounded-xl bg-white/[0.03] px-3 py-2">
                <dt className="text-[11px] text-ink-3">ACK 수신</dt>
                <dd className="mt-0.5 font-semibold" data-testid="twin-replay-ack">{selMsg.result?.ack === undefined ? '기록 없음' : selMsg.result.ack ? <span className="text-[#8FE6BE]">수신</span> : <span className="text-[#FFA9AC]">미수신</span>}</dd>
              </div>
              <div className="rounded-xl bg-white/[0.03] px-3 py-2">
                <dt className="text-[11px] text-ink-3">재전송</dt>
                <dd className="mt-0.5 font-mono font-semibold" data-testid="twin-replay-retries">{selMsg.result?.retries ?? '기록 없음'}</dd>
              </div>
              <div className="rounded-xl bg-white/[0.03] px-3 py-2">
                <dt className="text-[11px] text-ink-3">측정 지연</dt>
                <dd className="mt-0.5 font-mono">{selMsg.result?.client_elapsed_ms === undefined ? '기록 없음' : `${selMsg.result.client_elapsed_ms} ms`}</dd>
              </div>
              <div className="rounded-xl bg-white/[0.03] px-3 py-2">
                <dt className="text-[11px] text-ink-3">오류</dt>
                <dd className="mt-0.5 font-mono">{selMsg.result?.error ?? '—'}</dd>
              </div>
            </dl>
            <ul className="mt-3 space-y-1 font-mono text-[12px] text-ink-2">
              {selMsg.attempts?.length ? selMsg.attempts.map((a) => (
                <li key={a.number} className="flex justify-between gap-2"><span>#{a.number} {a.route.join('→')}</span><span className={a.outcome === 'ack' ? 'text-[#8FE6BE]' : 'text-[#FFA9AC]'}>{a.duration_ms.toFixed(1)}ms · {a.outcome}</span></li>
              )) : <li className="text-ink-3">시도별 기록 없음</li>}
            </ul>
            <p className="mt-2 text-[11.5px] leading-snug text-ink-3">ACK·재전송·지연·오류는 기록된 최종 결과(재생 위치와 무관), 상태 배지는 재생 위치까지의 기록 기준입니다.</p>
          </>
        ) : (
          <p className="text-[13px] text-ink-3">저장된 기록을 불러오는 중입니다.</p>
        )}
      </section>

      <section>
        <div className="mb-2 text-[12px] font-medium uppercase tracking-[0.14em] text-ink-3">노드 상태 · 기록 기준</div>
        <ul className="grid grid-cols-3 gap-1.5">
          {nodes.map((n) => (
            <li key={n.id} data-testid={`twin-replay-node-${n.id}`} title={n.reason}>
              <button
                className={cx('lift flex w-full flex-col items-start rounded-xl border px-2.5 py-1.5 text-left', r.selectedNode === n.id ? 'border-white/40 bg-white/[0.06]' : 'border-white/10 bg-white/[0.02]')}
                onClick={() => r.setSelectedNode(r.selectedNode === n.id ? null : n.id)}
              >
                <span className="flex items-center gap-1.5 font-mono text-[13px] text-ink"><span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLOR[n.status] }} />{n.id}</span>
                <span className="text-[11.5px]" style={{ color: n.status === 'unknown' ? '#8D98AB' : STATUS_COLOR[n.status] }}>{NODE_STATUS_LABEL[n.status]}</span>
              </button>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[11.5px] leading-snug text-ink-3">빨강 장애 확인 · 주황 이웃 판정 · 회색 기록 없음(정상으로 단정하지 않음). 노드를 누르면 카메라가 이동합니다.</p>
      </section>

      <section>
        <div className="mb-2 text-[12px] font-medium uppercase tracking-[0.14em] text-ink-3">3D 표시</div>
        <ul className="space-y-1.5 text-[12.5px] text-ink-2">
          {([
            ['#7CC8FF', 'solid', '메시지 전달 구간 · 현재 경로(빛 흐름)'],
            ['#E08A3C', 'dashed', '연결 시도 중 · 응답 기록 전'],
            ['#3FB27F', 'solid', 'ACK 구간(위쪽에 띄워 표시)'],
            ['#E5484D', 'dashed', '실패 · 이전 시도 경로 · ✕ 제외 링크'],
            ['#6B727C', 'dashed', '상태 기록 없는 링크'],
          ] as const).map(([c, s, l]) => (
            <li key={l} className="flex items-center gap-2.5"><span className="w-6" style={{ borderTop: `3px ${s} ${c}` }} />{l}</li>
          ))}
        </ul>
      </section>

      {trial && (
        <details className="group rounded-2xl border border-white/[0.07] bg-white/[0.02] px-4 py-3">
          <summary className="cursor-pointer list-none text-[12px] font-medium uppercase tracking-[0.14em] text-ink-3 group-open:text-ink-2">
            전체 기록 로그 · {trial.events.filter((e) => e.offset_ms <= r.t).length}/{trial.events.length}
          </summary>
          <ul className="panel-scroll mt-3 max-h-[260px] space-y-1 pr-1">
            {trial.events.filter((e) => e.offset_ms <= r.t).map((e) => (
              <li key={e.seq} className={cx('grid grid-cols-[64px_1fr] gap-2 text-[12px]', e.message_id && e.message_id === sel?.messageId ? 'text-ink' : 'text-ink-2', (e.event === 'fault_confirmed' || e.event === 'error') && 'text-[#FFA9AC]')}>
                <span className="font-mono text-[11px] text-ink-3">{fmt(e.offset_ms)}</span>
                <span>{describeEvent(trial, e)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {trial && (
        <details className="group rounded-2xl border border-white/[0.07] bg-white/[0.02] px-4 py-3">
          <summary className="cursor-pointer list-none text-[12px] font-medium uppercase tracking-[0.14em] text-ink-3 group-open:text-ink-2">기록되지 않은 정보 · 출처</summary>
          <ul className="mt-3 space-y-1.5 text-[12.5px] leading-relaxed text-ink-2">
            {trial.not_recorded?.map((n, i) => <li key={i}><span className="font-mono text-[11px] text-ink-3">{n.scope}</span> · {n.text}</li>)}
            <li><span className="font-mono text-[11px] text-ink-3">marker</span> · 메시지의 연속 위치는 기록되지 않았습니다. 곡선 위 이동은 기록된 송신·수신 이벤트 사이의 시각적 보간입니다.</li>
            {trial.cell.method === 'fixed' && <li><span className="font-mono text-[11px] text-ink-3">fixed</span> · Fixed 방식은 이웃 판정 기록이 없어 링크 상태를 '기록 없음'으로 둡니다.</li>}
          </ul>
          <div className="mt-3 text-[11.5px] leading-relaxed text-ink-3">
            사례 {trial.cell.cell} · {trial.cell.condition} · 실행 {trial.cell.experiment_id ?? '—'}
            <br />trial.json SHA-256 <span className="break-all font-mono">{trial.provenance.trial_sha256}</span>
          </div>
        </details>
      )}
    </div>
  );
}
