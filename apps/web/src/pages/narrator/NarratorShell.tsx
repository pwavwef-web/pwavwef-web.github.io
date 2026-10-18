import { NavLink, Outlet, useOutletContext } from 'react-router';
import { BookOpenText, Mic, Settings2 } from 'lucide-react';
import { NARRATOR } from '@az-studio/shared';
import { useNarratorStatus, type NarratorStatus } from '../../lib/narrator';
import { cx } from '../../components/ui';

export interface NarratorContext {
  status: NarratorStatus | null;
  statusError: unknown;
  reloadStatus: (refresh?: boolean) => Promise<void>;
  setStatus: (s: NarratorStatus) => void;
}

export const useNarrator = () => useOutletContext<NarratorContext>();

const TABS = [
  { to: '/narrator', label: 'Editions', icon: BookOpenText, end: true },
  { to: '/narrator/voice', label: 'My Voice', icon: Mic },
  { to: '/narrator/settings', label: 'Settings', icon: Settings2 },
];

export default function NarratorShell() {
  const s = useNarratorStatus();
  const ctx: NarratorContext = { status: s.data, statusError: s.error, reloadStatus: s.reload, setStatus: s.setData };
  return (
    <div className="mx-auto max-w-[1180px] space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4 border-b border-line pb-5">
        <div>
          <p className="eyebrow">AZ Studio</p>
          <h1 className="display mt-1 text-[44px] leading-none text-fg sm:text-[52px]">{NARRATOR.name}</h1>
          <p className="mt-2 text-[15px] text-dim">{NARRATOR.subtitle}</p>
        </div>
        <nav aria-label="Pwavwe Narrator" className="flex gap-1 rounded-xl border border-line bg-black/20 p-1">
          {TABS.map((t) => (
            <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => cx('inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors', isActive ? 'bg-accent/18 text-fg shadow-[inset_0_0_0_1px_rgba(76,141,255,0.35)]' : 'text-dim hover:bg-white/[0.05] hover:text-fg')}>
              <t.icon className="size-4" aria-hidden />
              {t.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <Outlet context={ctx} />
    </div>
  );
}
