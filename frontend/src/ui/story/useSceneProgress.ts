import { useEffect, useState, type RefObject } from 'react';

/**
 * 긴 섹션 안에서의 스크롤 진행도(0~1). 스크롤을 가로채지 않고(passive) 읽기만 합니다.
 * - smooth: 마우스 휠처럼 계단식으로 들어오는 스크롤 값을 화면 쪽에서만 지수 감쇠로 따라가게 합니다(실제 스크롤 위치·속도는 사용자 그대로).
 *   따라가는 값은 언제나 목표(실제 스크롤 위치)로 수렴하므로, 멈추면 같은 스크롤 위치 = 같은 기록 시각입니다.
 *   빠르게 스크롤하거나 방향을 바꿔도 값이 연속적으로 이어져 장면이 튀지 않습니다.
 * - requestAnimationFrame 은 목표에 도달하면 멈춥니다. 값이 바뀔 때만 이 장면만 다시 그립니다(부모는 다시 그리지 않음).
 * - 탭이 숨겨지면 남은 보간을 건너뛰고 목표값으로 맞춥니다.
 */
const TAU_MS = 120;
export function useSceneProgress(section: RefObject<HTMLElement>, root: RefObject<HTMLElement>, enabled: boolean, onChange?: (p: number) => void, smooth = true) {
  const [p, setP] = useState(0);
  useEffect(() => {
    const sec = section.current;
    const box = root.current;
    if (!enabled || !sec || !box) return;
    let raf = 0;
    let last = 0;
    let target = 0;
    let shown = -1;
    const read = () => {
      const r = sec.getBoundingClientRect();
      const rr = box.getBoundingClientRect();
      const total = r.height - rr.height;
      return Math.min(1, Math.max(0, (rr.top - r.top) / Math.max(1, total)));
    };
    const emit = (v: number) => {
      const q = Math.round(v * 4000) / 4000;
      setP((prev) => (prev === q ? prev : q));
      onChange?.(q);
    };
    const step = (now: number) => {
      raf = 0;
      const dt = last ? Math.min(64, now - last) : 16;
      last = now;
      shown += (target - shown) * (1 - Math.exp(-dt / TAU_MS));
      if (Math.abs(target - shown) < 0.0005 || document.hidden) shown = target;
      emit(shown);
      if (shown !== target) raf = requestAnimationFrame(step);
      else last = 0;
    };
    const on = () => {
      target = read();
      if (!smooth || shown < 0) { shown = target; emit(shown); return; }
      if (!raf) raf = requestAnimationFrame(step);
    };
    box.addEventListener('scroll', on, { passive: true });
    window.addEventListener('resize', on);
    on();
    return () => {
      box.removeEventListener('scroll', on);
      window.removeEventListener('resize', on);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [section, root, enabled, smooth]); // eslint-disable-line react-hooks/exhaustive-deps
  return p;
}

/** 스크롤 연동(긴 섹션 + 고정 화면) 또는 정적(움직임 줄이기 · 휴대폰 폭) */
export function useStoryMode(): { mode: 'scroll' | 'static'; reduced: boolean } {
  const get = () => {
    const reduced = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const narrow = typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 767px)').matches;
    return { mode: (reduced || narrow ? 'static' : 'scroll') as 'scroll' | 'static', reduced };
  };
  const [v, setV] = useState(get);
  useEffect(() => {
    const qs = ['(prefers-reduced-motion: reduce)', '(max-width: 767px)'].map((q) => window.matchMedia(q));
    const on = () => setV((prev) => { const n = get(); return n.mode === prev.mode && n.reduced === prev.reduced ? prev : n; });
    qs.forEach((q) => q.addEventListener('change', on));
    return () => qs.forEach((q) => q.removeEventListener('change', on));
  }, []);
  return v;
}
