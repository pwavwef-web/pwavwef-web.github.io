import { collection, query, where } from 'firebase/firestore';
import { NavLink, Outlet, useLocation } from 'react-router';
import { Clapperboard, FolderOpen, House, Layers, ListChecks, LogOut, Settings2, Sparkles } from 'lucide-react';
import { ACTIVE_STATUSES, formatUsd, type JobDoc } from '@az-studio/shared';
import { db } from '../lib/firebase';
import { useQuery } from '../lib/data';
import { useSession } from '../lib/session';
import { cx, Tip } from './ui';

const NAV = [
  { to: '/', label: 'Home', icon: House, end: true },
  { to: '/projects', label: 'Projects', icon: FolderOpen },
  { to: '/create', label: 'Create', icon: Sparkles },
  { to: '/assets', label: 'Assets', icon: Layers },
  { to: '/jobs', label: 'Jobs', icon: ListChecks },
  { to: '/settings', label: 'Settings', icon: Settings2 },
];

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-2.5', className)}>
      <span className="relative grid size-8 place-items-center rounded-xl bg-gradient-to-br from-[#16264a] to-[#0a1224] shadow-[inset_0_0_0_1px_rgba(138,182,255,0.35)]">
        <Clapperboard className="size-4 text-accent-2" aria-hidden />
      </span>
      <span className="leading-none">
        <span className="display block text-[21px] tracking-tight text-fg">AZ Studio</span>
        <span className="block text-[9.5px] font-semibold tracking-[0.22em] text-faint uppercase">Private portal</span>
      </span>
    </span>
  );
}

export function useActiveJobs() {
  const uid = useSession((s) => s.user?.uid ?? '');
  return useQuery<JobDoc>(() => (uid ? query(collection(db, 'jobs'), where('ownerUid', '==', uid), where('status', 'in', [...ACTIVE_STATUSES])) : null), [uid]);
}

function ActiveJobsPill({ collapsed }: { collapsed?: boolean }) {
  const active = useActiveJobs();
  const n = active.data.length;
  return (
    <NavLink
      to="/jobs"
      className={cx(
        'flex items-center gap-2 rounded-xl border px-3 py-2 text-xs transition-colors',
        n ? 'border-accent/30 bg-accent/10 text-accent-2' : 'border-line text-faint hover:text-dim',
      )}
      aria-label={`${n} active jobs`}
    >
      <span className={cx('size-2 rounded-full', n ? 'bg-accent animate-pulse-soft' : 'bg-white/20')} />
      {!collapsed && <span>{n ? `${n} generating` : 'No active jobs'}</span>}
      {collapsed && n > 0 && <span>{n}</span>}
    </NavLink>
  );
}

export function AppShell() {
  const { user, boot, signOut } = useSession();
  const location = useLocation();
  const today = boot?.spend.today.costUsd ?? 0;
  return (
    <div className="flex min-h-dvh">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-line bg-ink/70 px-4 py-5 backdrop-blur-xl lg:flex">
        <NavLink to="/" className="px-2" aria-label="AZ Studio home">
          <Logo />
        </NavLink>
        <nav aria-label="Primary" className="mt-8 flex flex-col gap-1">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                cx(
                  'group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all',
                  isActive ? 'bg-gradient-to-r from-accent/18 to-transparent text-fg shadow-[inset_2px_0_0_var(--color-accent)]' : 'text-dim hover:bg-white/[0.04] hover:text-fg',
                )
              }
            >
              <n.icon className="size-[18px]" aria-hidden />
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto space-y-3">
          <ActiveJobsPill />
          <div className="rounded-xl border border-line px-3 py-2.5 text-xs">
            <p className="text-faint">Vertex usage today (est.)</p>
            <p className="timecode mt-0.5 text-sm text-fg">
              {formatUsd(today)} <span className="text-faint">/ {formatUsd(boot?.settings.dailyLimitUsd ?? 0)}</span>
            </p>
          </div>
          <div className="flex items-center gap-2 px-1">
            <div className="grid size-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-accent to-violet text-xs font-semibold text-white">{(user?.email ?? '?').slice(0, 1).toUpperCase()}</div>
            <p className="min-w-0 flex-1 truncate text-xs text-dim">{user?.email}</p>
            <Tip label="Sign out">
              <button type="button" onClick={() => void signOut()} aria-label="Sign out" className="grid size-8 cursor-pointer place-items-center rounded-lg text-faint hover:bg-white/5 hover:text-fg">
                <LogOut className="size-4" />
              </button>
            </Tip>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <header className="glass sticky top-0 z-30 flex items-center justify-between border-x-0 border-t-0 px-4 py-3 lg:hidden">
          <NavLink to="/" aria-label="AZ Studio home">
            <Logo />
          </NavLink>
          <ActiveJobsPill collapsed />
        </header>
        <main key={location.pathname.split('/').slice(0, 3).join('/')} className="mx-auto w-full max-w-[1480px] flex-1 px-4 pt-6 pb-28 sm:px-6 lg:px-10 lg:pt-9 lg:pb-12 animate-fade">
          <Outlet />
        </main>
      </div>

      {/* Mobile bottom navigation */}
      <nav aria-label="Primary" className="glass fixed inset-x-0 bottom-0 z-30 grid grid-cols-6 border-x-0 border-b-0 px-1 pt-1.5 pb-[max(0.5rem,env(safe-area-inset-bottom))] lg:hidden">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => cx('flex flex-col items-center gap-0.5 rounded-lg py-1.5 text-[10px] font-medium', isActive ? 'text-accent-2' : 'text-faint')}>
            <n.icon className="size-5" aria-hidden />
            {n.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
