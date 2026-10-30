/**
 * PR #2 (M1): 모바일 반응형 레이아웃 회귀 테스트. 단위 fixture 만 사용합니다 — 백엔드·TCP 없음.
 * 실제 화면 폭별 측정(375/390/768/1440)은 브라우저 검증에서 따로 수행하며, 여기서는 그 결과를 만드는 클래스 규칙을 고정합니다.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { NARROW_QUERY, WIDE_QUERY, asideInnerClass, asideShellClass, matches } from '../src/ui/useMediaQuery';
import { setPublicDemoForTest } from '../src/domain/mode';
import DigitalTwin from '../src/pages/DigitalTwin';
import { TopBar } from '../src/ui/TopBar';
import { useApp } from '../src/store/store';

const cls = (s: string) => new Set(s.split(/\s+/).filter(Boolean));
const render = (path: string, el: Parameters<typeof createElement>[0]) =>
  renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [path] }, createElement(el)));
/** data-testid 가 붙은 요소의 class 속성 */
function classOf(html: string, testId: string) {
  const m = new RegExp(`<[^>]*class="([^"]*)"[^>]*data-testid="${testId}"|<[^>]*data-testid="${testId}"[^>]*class="([^"]*)"`).exec(html);
  assert.ok(m, `no element with data-testid=${testId}`);
  return cls(m[1] ?? m[2]);
}

await test('right panel: desktop keeps the fixed side widths, small screens stack it full-width below the stage', () => {
  const open = cls(asideShellClass(true));
  for (const c of ['lg:w-[320px]', 'xl:w-[380px]', 'lg:h-full', 'w-full', 'h-[46%]']) assert.ok(open.has(c), c);
  // 고정 폭(w-[320px])이 접두사 없이 남아 있으면 375px 에서 3D 무대 폭이 0 이 됩니다.
  assert.ok(![...open].some((c) => c === 'w-[320px]' || c === 'w-[380px]'), 'unprefixed fixed width');
  const closed = cls(asideShellClass(false));
  for (const c of ['h-0', 'w-full', 'lg:w-0', 'lg:h-full']) assert.ok(closed.has(c), c);
  const inner = cls(asideInnerClass());
  for (const c of ['w-full', 'lg:w-[320px]', 'xl:w-[380px]', 'border-t', 'lg:border-l', 'lg:border-t-0']) assert.ok(inner.has(c), c);
  assert.ok(cls(asideShellClass(true, 'lg:w-[320px] xl:w-[370px]')).has('xl:w-[370px]'));
});

await test('without a browser (SSR/unit) the layout defaults to the existing desktop behaviour', () => {
  assert.equal(matches(WIDE_QUERY), true);
  assert.equal(matches(NARROW_QUERY), false);
});

await test('Digital Twin: stage and panel stack vertically below lg, side by side from lg', () => {
  useApp.setState(useApp.getInitialState(), true);
  const html = render('/twin', DigitalTwin);
  assert.ok(html.includes('class="flex h-full min-h-0 flex-col lg:flex-row"'), 'root must be flex-col below lg');
  const aside = classOf(html, 'twin-aside');
  assert.ok(aside.has('lg:w-[320px]') && aside.has('w-full'), [...aside].join(' '));
  // 왼쪽 HUD(층 타이포·상태 타일 폭 250px)는 휴대폰 폭에서 숨겨 3D 를 가리지 않고, sm 이상에서는 기존과 같습니다.
  const hud = classOf(html, 'twin-left-hud');
  assert.ok(hud.has('hidden') && hud.has('sm:flex') && hud.has('left-6') && hud.has('top-[84px]'), [...hud].join(' '));
});

await test('TopBar: no per-character wrapping on phones (scenario text hidden below md, labels nowrap)', () => {
  setPublicDemoForTest(true);
  useApp.setState(useApp.getInitialState(), true);
  const html = render('/twin', TopBar);
  const header = classOf(html, 'topbar');
  assert.ok(header.has('overflow-hidden') && header.has('h-14'));
  const sc = classOf(html, 'topbar-scenario');
  for (const c of ['hidden', 'md:flex', 'whitespace-nowrap', 'min-w-0']) assert.ok(sc.has(c), c);
  assert.ok(classOf(html, 'topbar-readonly').has('whitespace-nowrap'));
  setPublicDemoForTest(false);
});
