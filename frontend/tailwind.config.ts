import type { Config } from 'tailwindcss';

/**
 * 디자인 토큰 — "Liquid Glass Command Center"
 * 남색·먹색 레이어 위에 반투명 유리 패널을 띄우는 체계입니다.
 * 색 이름(base/panel/raised/line/ink/ok/warn/fail/action)은 기존 컴포넌트와 호환되도록 유지하고 값만 바꿨습니다.
 * 텍스트 대비(배경 #0D131D 기준): ink 16.6:1, ink-2 10.2:1, ink-3 6.4:1 (WCAG AA 이상).
 * 상태색(ok/warn/fail)의 의미는 그대로이며, 강조색(action: 현재 선택·현재 통신 경로·주요 버튼)은 노란색 대신 아이스 블루입니다.
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        base: '#070B12',
        panel: '#0D131D',
        raised: '#151C28',
        line: '#222C3B',
        ink: { DEFAULT: '#EEF2F8', 2: '#B7C0CE', 3: '#8D98AB' },
        ok: '#3FC28A',
        warn: '#E9954A',
        fail: '#EF5A5F',
        action: '#7CC8FF',
        unknown: '#7C8799',
        glow: '#6FD3FF',
        ice: '#A9C7FF',
      },
      fontFamily: {
        sans: ['"Pretendard Variable"', 'Pretendard', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      fontSize: { '2xs': ['11px', '15px'] },
      boxShadow: {
        glass: 'inset 0 1px 0 0 rgba(255,255,255,0.07), 0 18px 40px -24px rgba(0,0,0,0.85)',
        'glow-action': '0 0 0 1px rgba(124,200,255,0.35), 0 0 18px -4px rgba(124,200,255,0.45)',
        'glow-cyan': '0 0 0 1px rgba(111,211,255,0.35), 0 0 18px -4px rgba(111,211,255,0.45)',
      },
    },
  },
  plugins: [],
} satisfies Config;
