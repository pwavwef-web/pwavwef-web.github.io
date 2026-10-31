import { useMemo } from 'react';
import { ShieldAlert, ShieldCheck, ShieldQuestion, Wand2 } from 'lucide-react';
import { likenessLabel, lintBrief, type LikenessVerdict } from '@az-studio/shared';
import { Badge, Button, Tip } from './ui';

/**
 * Brand safety before spending: the brief linter's warnings under a shot or scene brief, with one click to use the
 * safer wording. Nothing is changed unless the director asks.
 */
export function BrandWarnings({ text, onApply, className }: { text: string; onApply?: (saferText: string) => void; className?: string }) {
  const lint = useMemo(() => lintBrief(text), [text]);
  if (!lint.warnings.length) return null;
  return (
    <div className={`rounded-lg border border-warning/30 bg-warning/[0.07] px-2.5 py-1.5 text-[11px] text-dim ${className ?? ''}`} role="status">
      <div className="flex items-start gap-1.5">
        <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
        <div className="min-w-0 flex-1 space-y-0.5">
          {lint.warnings.slice(0, 4).map((w) => (
            <p key={w}>{w}</p>
          ))}
        </div>
        {onApply && (
          <Button size="sm" variant="ghost" icon={<Wand2 className="size-3" />} onClick={() => onApply(lint.saferText)}>
            Use safer wording
          </Button>
        )}
      </div>
    </div>
  );
}

/** The likeness and wardrobe verdict of a still (shot card and candidate list). */
export function LikenessBadge({ verdict }: { verdict: LikenessVerdict | null | undefined }) {
  if (!verdict) return null;
  const label = likenessLabel(verdict) ?? '';
  const detail = verdict.differences.length ? verdict.differences.join(' · ') : label;
  if (verdict.verdict === 'pass')
    return (
      <Tip label={detail}>
        <span>
          <Badge tone="success" icon={<ShieldCheck className="size-3" />}>
            Likeness OK
          </Badge>
        </span>
      </Tip>
    );
  if (verdict.verdict === 'fail')
    return (
      <Tip label={`${label}. ${detail} — kept as a candidate, never approved automatically.`}>
        <span>
          <Badge tone="danger" icon={<ShieldAlert className="size-3" />}>
            Likeness differs
          </Badge>
        </span>
      </Tip>
    );
  return (
    <Tip label={label}>
      <span>
        <Badge tone="neutral" icon={<ShieldQuestion className="size-3" />}>
          Not checked
        </Badge>
      </span>
    </Tip>
  );
}

/** The likeness verdict of a shot's image, and a note when the newest still failed and was kept aside (newest first). */
export function LikenessNote({ generated, imageId }: { generated: { assetId: string; likeness?: LikenessVerdict | null }[]; imageId: string | null }) {
  const current = generated.find((c) => c.assetId === imageId) ?? null;
  const newest = generated[0];
  const rejected = newest && newest.assetId !== imageId && newest.likeness?.verdict === 'fail';
  if (!current?.likeness && !rejected) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <LikenessBadge verdict={current?.likeness} />
      {rejected && <span className="text-[11px] text-danger">The newest still differs from the reference — kept as a candidate, not approved.</span>}
    </div>
  );
}
