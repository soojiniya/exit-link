import { Suspense, lazy, useEffect, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Sidebar } from '@/ui/Sidebar';
import { TopBar } from '@/ui/TopBar';
import { ControlDrawer } from '@/ui/ControlDrawer';
import { eventStream, loadBuilding } from '@/realtime/socket';
import { onTokenChange } from '@/api/client';
import { useApp } from '@/store/store';
import DigitalTwin from '@/pages/DigitalTwin';
const Overview = lazy(() => import('@/pages/Overview'));
const NetworkMonitor = lazy(() => import('@/pages/NetworkMonitor'));
import SimulationLab from '@/pages/SimulationLab';
const Analytics = lazy(() => import('@/pages/Analytics'));
const Replay = lazy(() => import('@/pages/Replay'));
/** 발표용 소개 화면(스크롤 스토리텔링). 관제 화면과 분리되어 있습니다. */
const Story = lazy(() => import('@/pages/Story'));

function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<div className="p-10 text-xs text-ink-3">화면 로딩 중…</div>}>{children}</Suspense>;
}

/** 유리 카드(.spotlight) 위 커서 위치를 CSS 변수로 전달 — 표시용이며 입력을 가로채지 않습니다. */
function useSpotlight() {
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    let raf = 0;
    let last: PointerEvent | null = null;
    const apply = () => {
      raf = 0;
      const e = last;
      const el = e?.target instanceof Element ? (e.target.closest('.spotlight') as HTMLElement | null) : null;
      if (!e || !el) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', `${e.clientX - r.left}px`);
      el.style.setProperty('--my', `${e.clientY - r.top}px`);
    };
    const onMove = (e: PointerEvent) => {
      last = e;
      if (!raf) raf = requestAnimationFrame(apply);
    };
    document.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      document.removeEventListener('pointermove', onMove);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
}

export default function App() {
  const location = useLocation();
  const isReplay = location.pathname === '/replay';
  // Static public demos must not connect to visitors' localhost TCP/API service.
  const isPublicDemo = import.meta.env.VITE_DEMO_MODE === '1';
  const hasPublicReadOnlyApi = isPublicDemo && import.meta.env.VITE_PUBLIC_READONLY_API === '1';
  useSpotlight();
  useEffect(() => {
    if (!isReplay && (!isPublicDemo || hasPublicReadOnlyApi)) {
      loadBuilding();
      eventStream.start();
    }
    const off = onTokenChange((has) => useApp.getState().setHasToken(has));
    return () => {
      if (!isReplay && (!isPublicDemo || hasPublicReadOnlyApi)) eventStream.stop();
      off();
    };
  }, [isReplay, isPublicDemo, hasPublicReadOnlyApi]);

  return (
    <div className="flex h-full min-h-[640px] flex-col">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="min-w-0 flex-1">
          {/* 화면 전환: 경로가 바뀔 때만 짧은 페이드(같은 화면의 모드·쿼리 변경에는 다시 그리지 않음) */}
          <div key={location.pathname} className="page-enter h-full">
          <Routes>
            <Route path="/" element={<Navigate to={isPublicDemo ? "/story" : "/twin"} replace />} />
            <Route path="/twin" element={<DigitalTwin />} />
            <Route path="/overview" element={<Lazy><Overview /></Lazy>} />
            <Route path="/network" element={<Lazy><NetworkMonitor /></Lazy>} />
            <Route path="/lab" element={<SimulationLab />} />
            <Route path="/analytics" element={<Lazy><Analytics /></Lazy>} />
            <Route path="/replay" element={<Lazy><Replay /></Lazy>} />
            <Route path="/story" element={<Lazy><Story /></Lazy>} />
            <Route path="*" element={<Navigate to={isPublicDemo ? "/story" : "/twin"} replace />} />
          </Routes>
          </div>
        </main>
      </div>
      {!isReplay && !isPublicDemo && <ControlDrawer />}
    </div>
  );
}
