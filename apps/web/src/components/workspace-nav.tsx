import type { ReactNode } from 'react';
import { cx, Tabs } from './ui';

export interface WorkspaceTab {
  value: string;
  label: string;
  icon: ReactNode;
  group: string;
  /** Shown only when the project turns on the advanced workspaces (or when opened directly). */
  advanced?: boolean;
}

/**
 * Two-level navigation for large studios: a row of stages (Develop, Bibles, Direct, Finish…) and the
 * workspaces of the current stage. Advanced workspaces stay hidden until the project asks for them, so a
 * simple project never has to open every panel.
 */
export function WorkspaceNav({ groups, tabs, value, onChange, advanced }: { groups: { value: string; label: string; icon: ReactNode }[]; tabs: WorkspaceTab[]; value: string; onChange: (v: string) => void; advanced: boolean }) {
  const current = tabs.find((t) => t.value === value) ?? tabs[0]!;
  const visible = (t: WorkspaceTab) => !t.advanced || advanced || t.value === current.value;
  return (
    <div className="space-y-2">
      <div role="tablist" aria-label="Stages" className="scroll-x flex gap-1">
        {groups.map((g) => {
          const first = tabs.find((t) => t.group === g.value && visible(t));
          if (!first) return null;
          const active = g.value === current.group;
          return (
            <button
              key={g.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => !active && onChange(first.value)}
              className={cx('inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors', active ? 'border-accent/60 bg-accent/15 text-fg' : 'border-line text-dim hover:text-fg')}
            >
              {g.icon}
              {g.label}
            </button>
          );
        })}
      </div>
      <Tabs value={current.value} onValueChange={onChange} tabs={tabs.filter((t) => t.group === current.group && visible(t)).map(({ value, label, icon }) => ({ value, label, icon }))} />
    </div>
  );
}
