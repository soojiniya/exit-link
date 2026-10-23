import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 기록 재생 시계. 재생 위치 t(ms, 기록 시간)를 화면 경과 시간 × 속도만큼 옮깁니다.
 * - 속도는 화면 진행 속도만 바꿉니다. 기록된 시각·측정값은 그대로입니다.
 * - 컴포넌트가 사라지거나(다른 화면 이동·모드 전환) 탭이 숨겨지면 requestAnimationFrame 을 정리합니다.
 */
export function useReplayPlayback(duration: number, initialSpeed = 1) {
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(initialSpeed);
  const tRef = useRef(0);
  tRef.current = t;

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(250, now - last); // 탭 전환 등으로 생긴 큰 간격은 건너뜁니다.
      last = now;
      const next = Math.min(duration, tRef.current + dt * speed);
      tRef.current = next;
      setT(next);
      if (next >= duration) {
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    const onHide = () => document.hidden && setPlaying(false);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [playing, speed, duration]);

  const seek = useCallback((x: number) => setT(Math.min(duration, Math.max(0, x))), [duration]);
  const reset = useCallback(() => {
    setPlaying(false);
    setT(0);
  }, []);
  const toggle = useCallback(() => {
    setPlaying((p) => {
      if (!p && tRef.current >= duration) setT(0);
      return !p;
    });
  }, [duration]);

  return { t, playing, speed, setSpeed, setPlaying, seek, reset, toggle };
}
