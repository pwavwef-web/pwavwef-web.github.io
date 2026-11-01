import { Link } from 'react-router';
import { AlertTriangle, Palette } from 'lucide-react';
import { kitWarnings, todayKey, type BrandKitInput, type KitWarning } from '@az-studio/shared';
import { useBrandKits, type StoredKit } from '../lib/brand-kits';
import { Notice, Select } from './ui';

/**
 * Chooses a brand kit to fill a tool from (Short Ads brief, Link to Ad, Motion Poster Ad). Prices and contacts past
 * their review-by day are listed wherever the kit is used, so a stale price never slips into an ad unnoticed.
 */
export function KitPicker({ appliedKitId, onApply, busy, label = 'Fill from a brand kit', hint }: { appliedKitId?: string | null; onApply: (kit: StoredKit) => void | Promise<void>; busy?: boolean; label?: string; hint?: string }) {
  const kits = useBrandKits();
  const applied = kits.data.find((k) => k.id === appliedKitId) ?? null;
  if (kits.loading) return null;
  if (!kits.data.length)
    return (
      <p className="flex flex-wrap items-center gap-1.5 text-xs text-faint">
        <Palette className="size-3.5" aria-hidden /> No brand kits yet.{' '}
        <Link to="/studio/brands" className="text-accent-2 underline">
          Make one
        </Link>{' '}
        so colours, logo, prices, contacts and real photos fill in by themselves.
      </p>
    );
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Palette className="size-4 text-accent-2" aria-hidden />
        <Select
          aria-label={label}
          value=""
          disabled={busy}
          onChange={(e) => {
            const k = kits.data.find((x) => x.id === e.target.value);
            if (k) void onApply(k);
          }}
        >
          <option value="">{applied ? `Re-apply a kit (now: ${applied.kit.name})` : label}</option>
          {kits.data.map((k) => (
            <option key={k.id} value={k.id}>
              {k.kit.name}
              {kitWarnings(k.kit).some((w) => w.state === 'overdue') ? ' · needs re-confirming' : ''}
            </option>
          ))}
        </Select>
        <Link to={applied ? `/studio/brands/${applied.id}` : '/studio/brands'} className="text-xs text-dim underline hover:text-fg">
          {applied ? 'Open the kit' : 'Brand kits'}
        </Link>
      </div>
      {hint && <p className="text-[11px] text-faint">{hint}</p>}
      {applied && <KitWarningList kit={applied.kit} kitId={applied.id} />}
    </div>
  );
}

/** Stale and due-soon prices and contacts of a kit, with a link to re-confirm them in the kit. */
export function KitWarningList({ kit, kitId, compact }: { kit: BrandKitInput; kitId?: string; compact?: boolean }) {
  const warnings: KitWarning[] = kitWarnings(kit, todayKey());
  if (!warnings.length) return null;
  const overdue = warnings.filter((w) => w.state === 'overdue');
  return (
    <Notice tone={overdue.length ? 'warning' : 'accent'} icon={<AlertTriangle className="size-4" />}>
      <p className="font-medium text-fg">{overdue.length ? `${overdue.length} price${overdue.length === 1 ? '' : 's'} or contact${overdue.length === 1 ? '' : 's'} in “${kit.name}” must be re-confirmed` : `Due for re-confirmation soon in “${kit.name}”`}</p>
      {!compact && (
        <ul className="mt-1 space-y-0.5 text-xs">
          {warnings.slice(0, 6).map((w) => (
            <li key={w.entryId}>{w.message}</li>
          ))}
          {warnings.length > 6 && <li>+{warnings.length - 6} more</li>}
        </ul>
      )}
      {kitId && (
        <Link to={`/studio/brands/${kitId}`} className="mt-1 inline-block text-xs font-medium text-accent-2 underline">
          Re-confirm in the kit
        </Link>
      )}
    </Notice>
  );
}
