import { useState } from 'react';
import { Check, Pencil, Undo2, Wand2, X } from 'lucide-react';
import { DIRECTION_LABELS, GEMINI_TTS_TAGS, MAX_DIRECTION_STYLE_CHARS, makeDirection, type Direction, type DirectionIntensity, type DirectionKind } from '@az-studio/shared';
import { Badge, Button, cx, Segmented } from '../../components/ui';

const newDirectionId = () => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

function describe(d: Direction): string {
  const where = d.kind === 'emphasis' ? `“${d.quote}”` : d.kind === 'style' ? `from “${d.quote.split(/\s+/).slice(0, 3).join(' ')}…”` : `before “${d.quote.split(/\s+/).slice(0, 2).join(' ')}”`;
  if (d.kind === 'pause') return `${d.value} ${where}`;
  if (d.kind === 'vocal') return `<${d.value}> ${where}`;
  if (d.kind === 'emphasis') return where;
  return `“${d.value}” ${where}`;
}

/** One direction as an editable chip. Suggestions are dashed until accepted; nothing is rendered unless accepted. */
export function DirectionChip({ d, flag, onChange, onRemove }: { d: Direction; flag?: string; onChange: (d: Direction) => void; onRemove: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(d.value);
  const tone = d.status === 'accepted' ? 'border-accent/45 bg-accent/12 text-fg' : d.status === 'needs_review' ? 'border-warning/50 bg-warning/10 text-warning' : 'border-dashed border-accent/40 text-dim';
  return (
    <span className={cx('inline-flex max-w-full items-center gap-1 rounded-full border py-0.5 pr-1 pl-2.5 text-[11.5px]', tone)} title={[d.rationale, flag, d.status === 'needs_review' ? 'The text changed here — check where this belongs.' : null].filter(Boolean).join(' · ') || undefined}>
      <span className="font-medium">{DIRECTION_LABELS[d.kind]}</span>
      {editing && d.kind === 'style' ? (
        <input
          autoFocus
          aria-label="Delivery direction"
          className="w-36 rounded bg-black/30 px-1 text-[11.5px] text-fg outline-none"
          maxLength={MAX_DIRECTION_STYLE_CHARS}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => {
            setEditing(false);
            if (value.trim() && value.trim() !== d.value) onChange({ ...d, value: value.trim(), source: 'manual' });
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
        />
      ) : (
        <span className="truncate">{describe(d)}</span>
      )}
      {flag && <Badge tone="warning">unsupported</Badge>}
      {d.kind === 'style' && !editing && (
        <button type="button" aria-label="Edit delivery direction" className="grid size-5 cursor-pointer place-items-center rounded-full hover:bg-white/10" onClick={() => setEditing(true)}>
          <Pencil className="size-3" />
        </button>
      )}
      {d.status !== 'accepted' && (
        <button type="button" aria-label={`Accept: ${describe(d)}`} className="grid size-5 cursor-pointer place-items-center rounded-full text-success hover:bg-success/15" onClick={() => onChange({ ...d, status: 'accepted' })}>
          <Check className="size-3" />
        </button>
      )}
      <button type="button" aria-label={d.source === 'auto' && d.status === 'suggested' ? `Reject: ${describe(d)}` : `Remove: ${describe(d)}`} className="grid size-5 cursor-pointer place-items-center rounded-full text-[#ff9b9b] hover:bg-danger/15" onClick={onRemove}>
        <X className="size-3" />
      </button>
    </span>
  );
}

/** Manual directions at the current selection in a passage. */
export function AddDirection({ passageId, text, range, onAdd }: { passageId: string; text: string; range: { start: number; end: number } | null; onAdd: (d: Direction) => void }) {
  const [vocal, setVocal] = useState<string>('breath');
  const at = range?.start ?? null;
  const add = (kind: DirectionKind, value: string) => {
    if (at === null) return;
    const base = { id: newDirectionId(), passageId, kind, value, source: 'manual' as const };
    onAdd(kind === 'emphasis' ? makeDirection(text, { ...base, start: range!.start, end: range!.end }) : kind === 'style' ? makeDirection(text, { ...base, start: at }) : makeDirection(text, { ...base, at }));
  };
  const hasSpan = Boolean(range && range.end > range.start && range.end - range.start <= 60);
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-faint">{at === null ? 'Click in the text (or select words) to add a direction there:' : 'Add at the cursor:'}</span>
      <Button size="sm" variant="ghost" disabled={at === null} onClick={() => add('pause', 'short pause')}>
        Short pause
      </Button>
      <Button size="sm" variant="ghost" disabled={at === null} onClick={() => add('pause', 'long pause')}>
        Long pause
      </Button>
      <Button size="sm" variant="ghost" disabled={!hasSpan} title="Select one to three words first" onClick={() => add('emphasis', '')}>
        Emphasis
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={at === null}
        onClick={() => {
          const v = window.prompt('Delivery from here (short, e.g. “slower, reflective”)', 'slower, reflective');
          if (v && v.trim()) add('style', v.trim().slice(0, MAX_DIRECTION_STYLE_CHARS));
        }}
      >
        Delivery…
      </Button>
      <span className="inline-flex items-center gap-1">
        <select aria-label="Vocal sound" className="field w-auto py-1 text-xs" value={vocal} onChange={(e) => setVocal(e.target.value)}>
          {GEMINI_TTS_TAGS.filter((t) => !t.includes('pause')).map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <Button size="sm" variant="ghost" disabled={at === null} onClick={() => add('vocal', vocal)}>
          Add sound
        </Button>
      </span>
    </div>
  );
}

/** Edition-level Auto-direct controls. */
export function DirectionsToolbar({ intensity, onIntensity, onRun, running, counts, onAcceptAll, onRejectAll, onRemoveAll, onUndo, canUndo }: { intensity: DirectionIntensity; onIntensity: (i: DirectionIntensity) => void; onRun: () => void; running: boolean; counts: { suggested: number; accepted: number; review: number }; onAcceptAll: () => void; onRejectAll: () => void; onRemoveAll: () => void; onUndo: () => void; canUndo: boolean }) {
  return (
    <div className="space-y-2 rounded-xl border border-line px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-fg">Auto-direct</span>
        <Segmented size="sm" label="Intensity" value={intensity} onChange={onIntensity} options={[{ value: 'subtle', label: 'Subtle' }, { value: 'expressive', label: 'Expressive' }, { value: 'dramatic', label: 'Dramatic' }]} />
        <Button size="sm" variant="subtle" icon={<Wand2 className="size-3.5" />} loading={running} disabled={running} onClick={onRun}>
          Suggest directions
        </Button>
        <Button size="sm" variant="ghost" icon={<Undo2 className="size-3.5" />} disabled={!canUndo} onClick={onUndo}>
          Undo
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-dim">
        <span>
          {counts.suggested} to review · {counts.accepted} accepted{counts.review ? ` · ${counts.review} need checking after edits` : ''}
        </span>
        <Button size="sm" variant="ghost" disabled={!counts.suggested} onClick={onAcceptAll}>
          Accept all
        </Button>
        <Button size="sm" variant="ghost" disabled={!counts.suggested} onClick={onRejectAll}>
          Reject all
        </Button>
        <Button size="sm" variant="ghost" disabled={!counts.suggested && !counts.accepted && !counts.review} onClick={onRemoveAll}>
          Remove all directions
        </Button>
      </div>
      <p className="text-[11px] text-faint">Suggestions only: nothing is spoken differently until you accept it, words are never changed, and no audio is generated. Directions are never part of the transcript or the public player.</p>
    </div>
  );
}
