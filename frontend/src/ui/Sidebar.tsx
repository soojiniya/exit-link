import { NavLink } from 'react-router-dom';
import { BarChart3, Box, FlaskConical, LayoutGrid, Network, Film, Presentation } from 'lucide-react';
import { cx } from './primitives';

const NAV = [
  { to: '/overview', label: 'Overview', icon: LayoutGrid },
  { to: '/twin', label: 'Digital Twin', icon: Box },
  { to: '/network', label: 'Network Monitor', icon: Network },
  { to: '/lab', label: 'Simulation Lab', icon: FlaskConical },
  { to: '/analytics', label: 'Analytics', icon: BarChart3 },
  { to: '/replay', label: 'REPLAY · 저장된 기록', icon: Film },
  { to: '/story', label: 'STORY · 발표 소개', icon: Presentation },
];

export function Sidebar() {
  return (
    <nav className="glass-chrome relative z-10 flex w-[60px] shrink-0 flex-col items-center gap-1.5 border-r pt-3" aria-label="주요 화면">
      {NAV.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          title={label}
          aria-label={label}
          className={({ isActive }) =>
            cx(
              'lift group relative flex h-10 w-10 items-center justify-center rounded-xl border',
              isActive
                ? 'border-action/35 bg-gradient-to-b from-white/[0.10] to-white/[0.03] text-action shadow-glow-action'
                : 'border-transparent text-ink-3 hover:border-white/10 hover:bg-white/[0.05] hover:text-ink',
            )
          }
        >
          {({ isActive }) => (
            <>
              {isActive && <span className="absolute -left-[10px] top-2 h-6 w-[2px] rounded-full bg-action shadow-[0_0_8px_rgba(124,200,255,0.9)]" />}
              <Icon size={18} strokeWidth={1.6} />
              <span className="glass-float pointer-events-none absolute left-12 z-30 whitespace-nowrap rounded-lg px-2.5 py-1 text-2xs text-ink opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100">
                {label}
              </span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
