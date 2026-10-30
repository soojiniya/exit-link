import { useEffect, useState } from 'react';

/** 넓은 화면(오른쪽 상세 패널을 옆에 두는 화면) 기준. Tailwind `lg`(1024px)와 같습니다. */
export const WIDE_QUERY = '(min-width: 1024px)';
/** 작은 화면(휴대폰) 기준. Tailwind `sm`(640px) 미만입니다. */
export const NARROW_QUERY = '(max-width: 639.98px)';

/** 브라우저가 아니거나 matchMedia 가 없으면(서버 렌더·단위 테스트) 넓은 화면으로 봅니다 — PC 기존 동작이 기본값입니다. */
export function matches(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return query === WIDE_QUERY;
  return window.matchMedia(query).matches;
}

/** 미디어 쿼리 일치 여부를 구독합니다. */
export function useMediaQuery(query: string): boolean {
  const [on, setOn] = useState(() => matches(query));
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const update = () => setOn(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, [query]);
  return on;
}

/**
 * 오른쪽 상세 패널의 반응형 클래스.
 * - lg(1024px) 이상: 기존과 같은 오른쪽 고정 폭 패널(접으면 폭 0)
 * - lg 미만: 무대 아래에 붙는 하단 패널(접으면 높이 0) — 3D·토폴로지 무대의 폭을 줄이지 않습니다.
 */
export function asideShellClass(show: boolean, wide = 'lg:w-[320px] xl:w-[380px]') {
  return [
    'aside-shell relative shrink-0 overflow-hidden lg:h-full',
    show ? `h-[46%] w-full ${wide}` : 'h-0 w-full lg:w-0',
  ].join(' ');
}

/** 패널 내부 aside 의 반응형 폭·테두리. */
export function asideInnerClass(wide = 'lg:w-[320px] xl:w-[380px]') {
  return `h-full w-full border-t lg:border-l lg:border-t-0 ${wide}`;
}
