import { useEffect } from 'react';
import { X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useApp } from '@/store/store';
import { TokenSection } from './lab/TokenSection';
import { ExperimentControl } from './lab/ExperimentControl';
import { ScenarioCreator } from './lab/ScenarioCreator';
import { HazardEditor } from './lab/HazardEditor';
import { GuidanceForm } from './lab/GuidanceForm';

/** 어느 화면에서나 여는 빠른 제어 패널. Simulation Lab과 같은 컴포넌트·요청 로직을 공유합니다. */
export function ControlDrawer() {
  const open = useApp((s) => s.controlOpen);
  const setOpen = useApp((s) => s.setControlOpen);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-[#03060b]/55 backdrop-blur-[2px]" onClick={() => setOpen(false)}>
      <aside className="glass-chrome panel-scroll h-full w-[440px] max-w-full border-l shadow-[-30px_0_60px_-20px_rgba(0,0,0,0.8)]" onClick={(e) => e.stopPropagation()} aria-label="제어 패널">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/10 bg-[#0a0f18]/90 px-5 py-4 backdrop-blur">
          <div>
            <div className="eyebrow mb-1">Control</div>
            <div className="text-[16px] font-semibold tracking-[-0.01em]">관제 제어</div>
            <div className="text-2xs text-ink-3">
              모든 요청은 실제 FastAPI로 전송됩니다 ·{' '}
              <Link to="/lab" className="text-action hover:underline" onClick={() => setOpen(false)}>Simulation Lab에서 자세히</Link>
            </div>
          </div>
          <button onClick={() => setOpen(false)} className="rounded-full border border-white/10 bg-white/[0.04] p-1.5 text-ink-3 transition hover:border-white/20 hover:text-ink" aria-label="닫기">
            <X size={16} />
          </button>
        </div>
        <div className="space-y-7 px-5 py-5">
          <TokenSection />
          <ExperimentControl compact />
          <ScenarioCreator />
          <HazardEditor compact />
          <GuidanceForm />
        </div>
      </aside>
    </div>
  );
}
