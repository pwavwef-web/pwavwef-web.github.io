import { useState } from 'react';
import { ImagePlus, Plus, X } from 'lucide-react';
import { useAsset, AssetThumb, type Asset } from './media';
import { Button, cx, Input } from './ui';

/** Short list of phrases edited as chips (accessories, protected features, palette…). */
export function ChipList({ value, onChange, placeholder, max = 30, className }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; max?: number; className?: string }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const t = draft.trim();
    if (!t || value.includes(t) || value.length >= max) return;
    onChange([...value, t]);
    setDraft('');
  };
  return (
    <div className={cx('space-y-1.5', className)}>
      <div className="flex flex-wrap gap-1">
        {value.map((v) => (
          <span key={v} className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-xs text-dim">
            {v}
            <button type="button" aria-label={`Remove ${v}`} className="cursor-pointer text-faint hover:text-fg" onClick={() => onChange(value.filter((x) => x !== v))}>
              <X className="size-3" />
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-1.5">
        <Input
          className="h-8 text-xs"
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} disabled={!draft.trim() || value.length >= max} onClick={add}>
          Add
        </Button>
      </div>
    </div>
  );
}

/** One image slot (view reference, costume image, set view…). */
export function AssetSlot({ label, assetId, onPick, onClear, action, className, aspect = 'aspect-video', badge }: { label: string; assetId: string | null; onPick: () => void; onClear?: () => void; action?: React.ReactNode; className?: string; aspect?: string; badge?: React.ReactNode }) {
  const a = useAsset(assetId);
  return (
    <div className={cx('space-y-1.5 rounded-xl border border-line p-2', className)}>
      <div className="flex items-center justify-between gap-1">
        <span className="truncate text-xs text-dim">{label}</span>
        {badge}
      </div>
      {a.data ? <AssetThumb asset={a.data as Asset} showMeta={false} aspect={aspect} hoverPlay={false} /> : <div className={cx('grid place-items-center rounded-lg border border-dashed border-line text-[11px] text-faint', aspect)}>Empty</div>}
      <div className="flex flex-wrap gap-1">
        <Button size="sm" variant="ghost" icon={<ImagePlus className="size-3.5" />} onClick={onPick}>
          {assetId ? 'Change' : 'Choose'}
        </Button>
        {assetId && onClear && (
          <Button size="sm" variant="ghost" onClick={onClear}>
            Clear
          </Button>
        )}
        {action}
      </div>
    </div>
  );
}
