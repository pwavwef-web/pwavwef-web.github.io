import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AudioLines, CircleAlert, Copy, Download, ExternalLink, FileText, Loader2, RotateCcw, Sparkles, X } from 'lucide-react';
import {
  CLEANUP_LABELS,
  PASSAGE_STATE_LABELS,
  bloggerEmbedHtml,
  fmtClock,
  formatUsd,
  proposeCleanup,
  proposeSkips,
  relativeTime,
  toMillis,
  type CleanupKind,
  type NarratorClipDoc,
  type NarratorExportDoc,
  type NarratorPassage,
  type NarratorScript,
  type PassageAudioState,
  type SoundCloudLink,
} from '@az-studio/shared';
import { errorMessage } from '../../lib/api';
import { downloadNarratorFile, nar, useNarratorMedia, type EstimateResult, type WithId } from '../../lib/narrator';
import { Badge, Button, cx, Field, Input, Modal, Notice, Textarea } from '../../components/ui';
import { ClipPlayer } from '../../components/narrator/audio';

export const STATE_TONE: Record<PassageAudioState, string> = {
  current: 'bg-success',
  stale: 'bg-warning',
  missing: 'bg-white/25',
  generating: 'bg-accent animate-pulse-soft',
  needs_recovery: 'bg-danger',
  failed: 'bg-danger',
  skipped: 'bg-transparent border border-white/25',
  empty: 'bg-transparent border border-white/25',
};

// ---------------------------------------------------------------------------
// Passage row
// ---------------------------------------------------------------------------

export interface PassageView {
  passage: NarratorPassage;
  state: PassageAudioState;
  selected: WithId<NarratorClipDoc> | null;
  takes: WithId<NarratorClipDoc>[];
  latestProblem: WithId<NarratorClipDoc> | null;
  spokenAs: string | null;
  startSec: number | null;
  /** Accepted directions the provider cannot render (with the reason). */
  flags: { id: string; reason: string }[];
}

function autoRows(text: string, min = 2): number {
  return Math.max(min, Math.min(18, Math.ceil(text.length / 95) + (text.match(/\n/g)?.length ?? 0)));
}

export function PassageRow({ v, editionId, onText, onSkip, onGenerate, onSelectTake, onDismiss, onSelectText, onSelectRange, onSeek, busy, heading, chips, panel }: { chips?: React.ReactNode; panel?: React.ReactNode; onSelectRange?: (r: { start: number; end: number }) => void; v: PassageView; editionId: string; onText: (t: string) => void; onSkip: (skip: boolean) => void; onGenerate: () => void; onSelectTake: (clipId: string) => void; onDismiss: (clipId: string) => void; onSelectText: (t: string) => void; onSeek: (sec: number) => void; busy: boolean; heading?: boolean }) {
  const [open, setOpen] = useState(false);
  const p = v.passage;
  const src = useNarratorMedia(open && v.selected?.status === 'ready' ? { kind: 'clip', id: v.selected.id, editionId } : null);
  const edited = p.source && p.text !== p.source;
  return (
    <div className={cx('group relative rounded-xl px-3 py-2.5 transition-colors sm:px-4', open ? 'bg-white/[0.035]' : 'hover:bg-white/[0.02]', p.skip && 'opacity-60')}>
      <div className="flex items-start gap-3">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={`${PASSAGE_STATE_LABELS[v.state]} — ${open ? 'hide' : 'show'} audio and options`} title={PASSAGE_STATE_LABELS[v.state]} className="mt-2.5 grid size-4 shrink-0 cursor-pointer place-items-center">
          <span className={cx('size-2.5 rounded-full', STATE_TONE[v.state])} />
        </button>
        <div className="min-w-0 flex-1">
          <textarea
            value={p.text}
            onChange={(e) => onText(e.target.value)}
            onSelect={(e) => {
              const t = e.currentTarget;
              onSelectText(t.value.slice(t.selectionStart, t.selectionEnd));
              onSelectRange?.({ start: t.selectionStart, end: t.selectionEnd });
            }}
            rows={heading ? 1 : autoRows(p.text)}
            aria-label={p.kind === 'heading' ? 'Heading (spoken)' : p.kind === 'opening' ? 'Opening (spoken)' : p.kind === 'closing' ? 'Closing (spoken)' : 'Paragraph (spoken)'}
            className={cx('w-full resize-none bg-transparent leading-[1.7] text-fg outline-none placeholder:text-faint focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-accent/40', heading ? 'display text-[25px] leading-snug' : 'text-[16.5px]', p.skip && 'line-through decoration-white/30')}
          />
          {(v.spokenAs || edited || v.state === 'stale' || v.state === 'needs_recovery' || v.state === 'failed') && (
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px]">
              {v.spokenAs && <span className="text-faint">Sent to the voice as: “{v.spokenAs.length > 160 ? `${v.spokenAs.slice(0, 160)}…` : v.spokenAs}”</span>}
              {edited && (
                <button type="button" className="cursor-pointer text-faint hover:text-dim" onClick={() => setOpen(true)}>
                  Edited from the article
                </button>
              )}
              {v.state === 'stale' && <span className="text-warning">Audio out of date</span>}
              {(v.state === 'needs_recovery' || v.state === 'failed') && <span className="text-[#ff9b9b]">{v.state === 'needs_recovery' ? 'Needs recovery' : 'Generation failed'}</span>}
            </div>
          )}
          {chips && <div className="mt-1.5 flex flex-wrap gap-1.5">{chips}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-1 pt-1.5 opacity-80 group-hover:opacity-100">
          {v.startSec !== null && (
            <button type="button" onClick={() => onSeek(v.startSec!)} className="timecode cursor-pointer rounded px-1.5 py-0.5 text-[11px] text-faint hover:bg-white/5 hover:text-fg" aria-label={`Play the export from ${fmtClock(v.startSec)}`}>
              {fmtClock(v.startSec)}
            </button>
          )}
          {!p.skip && p.text.trim() && (
            <Button size="sm" variant="ghost" disabled={busy || v.state === 'generating'} onClick={onGenerate} aria-label={v.selected ? 'Regenerate this passage' : 'Generate this passage'} title={v.selected ? 'Regenerate this passage (keeps earlier takes)' : 'Generate this passage'}>
              {v.state === 'generating' ? <Loader2 className="size-3.5 animate-spin" /> : v.selected ? <RotateCcw className="size-3.5" /> : <Sparkles className="size-3.5" />}
            </Button>
          )}
        </div>
      </div>
      {open && (
        <div className="mt-3 space-y-3 border-t border-line pt-3 pl-7">
          <p className="text-xs text-dim">{PASSAGE_STATE_LABELS[v.state]}</p>
          {panel}
          {v.selected?.status === 'ready' && <ClipPlayer src={src} peaks={v.selected.peaks} label="selected take" />}
          {v.latestProblem && (
            <Notice tone="danger" icon={<CircleAlert className="size-4" />}>
              <p>{v.latestProblem.error?.message}</p>
              {v.latestProblem.status === 'needs_recovery' && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" variant="danger" onClick={onGenerate} disabled={busy}>
                    Retry (may charge again)
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => onDismiss(v.latestProblem!.id)}>
                    Dismiss
                  </Button>
                </div>
              )}
            </Notice>
          )}
          {v.takes.length > 1 && (
            <Field label="Take">
              <select className="field max-w-xs py-1.5 text-sm" value={v.selected?.id ?? ''} onChange={(e) => onSelectTake(e.target.value)}>
                {v.takes.map((t) => (
                  <option key={t.id} value={t.id}>
                    Take {t.version} · {t.durationSec?.toFixed(1)} s · {relativeTime(toMillis(t.createdAt))}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {edited && (
            <div className="rounded-lg bg-black/20 p-3 text-[13px] leading-relaxed text-dim">
              <p className="eyebrow mb-1">In the article</p>
              {p.source}
              <div className="mt-2">
                <Button size="sm" variant="ghost" onClick={() => onText(p.source)}>
                  Restore the article text
                </Button>
              </div>
            </div>
          )}
          {p.kind === 'paragraph' && (
            <label className="flex cursor-pointer items-center gap-2 text-xs text-dim">
              <input type="checkbox" checked={Boolean(p.skip)} onChange={(e) => onSkip(e.target.checked)} className="accent-[#4c8dff]" /> Leave this paragraph out of the narration (the text stays here)
            </label>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cleanup review
// ---------------------------------------------------------------------------

export function CleanupDialog({ open, onOpenChange, script, onApply }: { open: boolean; onOpenChange: (o: boolean) => void; script: NarratorScript; onApply: (accepted: Set<string>, skips: Set<string>) => void }) {
  const proposals = useMemo(() => (open ? proposeCleanup(script) : []), [open, script]);
  const skips = useMemo(() => (open ? proposeSkips(script) : []), [open, script]);
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [skipSel, setSkipSel] = useState<Set<string>>(new Set());
  const kinds = [...new Set(proposals.map((p) => p.kind))] as CleanupKind[];
  const toggle = (set: Set<string>, id: string, on: boolean) => {
    const n = new Set(set);
    if (on) n.add(id);
    else n.delete(id);
    return n;
  };
  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) {
          setAccepted(new Set());
          setSkipSel(new Set());
        }
      }}
      size="lg"
      title="Review text cleanup"
      description="Proposed changes to the spoken text only. Nothing is applied unless you tick it; the article itself never changes."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!accepted.size && !skipSel.size}
            onClick={() => {
              onApply(accepted, skipSel);
              onOpenChange(false);
              setAccepted(new Set());
              setSkipSel(new Set());
            }}
          >
            Apply {accepted.size + skipSel.size} change{accepted.size + skipSel.size === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      {!proposals.length && !skips.length ? (
        <p className="text-sm text-dim">Nothing to clean up — no Markdown, raw links, citation markers, credits or symbols were found.</p>
      ) : (
        <div className="space-y-6">
          {skips.length > 0 && (
            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-fg">Leave out of the narration</h3>
                <Button size="sm" variant="ghost" onClick={() => setSkipSel(new Set(skips.map((s) => s.passageId)))}>
                  Select all
                </Button>
              </div>
              {skips.map((s) => (
                <label key={s.passageId} className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line p-2.5 text-[13px] text-dim">
                  <input type="checkbox" className="mt-1 accent-[#4c8dff]" checked={skipSel.has(s.passageId)} onChange={(e) => setSkipSel(toggle(skipSel, s.passageId, e.target.checked))} />
                  <span>
                    <Badge className="mr-1.5">{s.reason === 'image_credit' ? 'Image credit' : s.reason === 'interface_text' ? 'Interface text' : 'Empty'}</Badge>
                    {s.text}
                  </span>
                </label>
              ))}
            </section>
          )}
          {kinds.map((k) => {
            const items = proposals.filter((p) => p.kind === k);
            return (
              <section key={k} className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium text-fg">
                    {CLEANUP_LABELS[k]} <span className="text-faint">· {items.length}</span>
                  </h3>
                  <Button size="sm" variant="ghost" onClick={() => setAccepted(new Set([...accepted, ...items.map((i) => i.id)]))}>
                    Select all
                  </Button>
                </div>
                {items.map((p) => (
                  <label key={p.id} className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line p-2.5 text-[13px] text-dim">
                    <input type="checkbox" className="mt-1 accent-[#4c8dff]" checked={accepted.has(p.id)} onChange={(e) => setAccepted(toggle(accepted, p.id, e.target.checked))} />
                    <span className="min-w-0">
                      <span className="text-[#ff9b9b] line-through">{p.before || '∅'}</span> → <span className="text-success">{p.after || '(removed)'}</span>
                      <span className="mt-0.5 block truncate text-faint">{p.context.replace(/⟦.*?⟧/, '▮')}</span>
                    </span>
                  </label>
                ))}
              </section>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Generation confirmation
// ---------------------------------------------------------------------------

export function GenerateDialog({ open, onOpenChange, estimate, title, onConfirm, busy }: { open: boolean; onOpenChange: (o: boolean) => void; estimate: EstimateResult | null; title: string; onConfirm: () => void; busy: boolean }) {
  const e = estimate;
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" icon={<AudioLines className="size-4" />} loading={busy} disabled={!e || Boolean(e.limitProblem) || (!e.items.length && !e.reuse.length)} onClick={onConfirm}>
            {e && !e.items.length && e.reuse.length ? 'Use existing takes' : 'Generate'}
          </Button>
        </>
      }
    >
      {!e ? (
        <p className="text-sm text-dim">Estimating…</p>
      ) : (
        <div className="space-y-4 text-sm">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3">
            <div>
              <dt className="text-xs text-faint">To generate</dt>
              <dd className="text-fg">
                {e.items.length} passage{e.items.length === 1 ? '' : 's'} · {e.estimate.requests} request{e.estimate.requests === 1 ? '' : 's'}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-faint">Estimated speech</dt>
              <dd className="text-fg">≈ {fmtClock(e.estimate.speechSec)}</dd>
            </div>
            <div>
              <dt className="text-xs text-faint">Estimated cost</dt>
              <dd className="text-fg">≈ {formatUsd(e.estimate.usd, { precise: true })}</dd>
            </div>
            <div>
              <dt className="text-xs text-faint">Your budget per request</dt>
              <dd className="text-fg">{formatUsd(e.budgetUsd)}</dd>
            </div>
          </dl>
          {e.reuse.length > 0 && <p className="text-dim">{e.reuse.length} passage(s) already have a take made from exactly this text and voice; it will be used again at no cost.</p>}
          {e.skipped.length > 0 && <p className="text-dim">{e.skipped.length} passage(s) skipped ({[...new Set(e.skipped.map((s) => s.reason))].join(', ')}).</p>}
          {e.limitProblem && <Notice tone="danger">{e.limitProblem}</Notice>}
          <details className="text-xs text-faint">
            <summary className="cursor-pointer">How this is estimated</summary>
            {e.estimate.notes.map((n) => (
              <p key={n} className="mt-1.5">
                {n}
              </p>
            ))}
          </details>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function ExportPanel({ editionId, latest, outdated, canExport, blockers, onExport, exporting }: { editionId: string; latest: WithId<NarratorExportDoc> | null; outdated: number; canExport: boolean; blockers: string | null; onExport: () => void; exporting: boolean }) {
  const dl = (file: 'wav' | 'mp3' | 'transcript' | 'chapters') => latest && void downloadNarratorFile({ kind: 'export', id: latest.id, editionId, file }).catch((e) => toast.error(errorMessage(e)));
  return (
    <section aria-labelledby="export-h" className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 id="export-h" className="eyebrow">
          Export
        </h2>
        <Button size="sm" variant={canExport ? 'primary' : 'secondary'} disabled={!canExport || exporting} loading={exporting} onClick={onExport}>
          {latest ? 'Export again' : 'Export'}
        </Button>
      </div>
      {blockers && <p className="text-xs text-warning">{blockers}</p>}
      {latest && (
        <div className="space-y-2.5 text-[13px]">
          <p className="text-dim">
            Version {latest.version} · {latest.status === 'ready' ? `${fmtClock(latest.durationSec ?? 0)} · ${relativeTime(toMillis(latest.createdAt))}` : latest.status === 'rendering' ? 'assembling…' : 'failed'}
          </p>
          {latest.status === 'failed' && <p className="text-[#ff9b9b]">{latest.error?.message}</p>}
          {outdated > 0 && latest.status === 'ready' && <Badge tone="warning">Out of date — {outdated} passage{outdated === 1 ? '' : 's'} changed since</Badge>}
          {latest.status === 'ready' && (
            <>
              <div className="flex flex-wrap gap-1.5">
                <Button size="sm" variant="secondary" icon={<Download className="size-3.5" />} onClick={() => dl('mp3')}>
                  MP3
                </Button>
                <Button size="sm" variant="secondary" icon={<Download className="size-3.5" />} onClick={() => dl('wav')}>
                  WAV master
                </Button>
                <Button size="sm" variant="ghost" icon={<FileText className="size-3.5" />} onClick={() => dl('transcript')}>
                  Transcript
                </Button>
                <Button size="sm" variant="ghost" icon={<FileText className="size-3.5" />} onClick={() => dl('chapters')}>
                  Section times
                </Button>
              </div>
              {latest.after && (
                <p className="text-xs text-faint">
                  Measured after processing: {latest.after.integratedLufs} LUFS integrated, {latest.after.truePeakDbtp} dBTP true peak, LRA {latest.after.lra} LU (target {latest.target.integratedLufs} LUFS / {latest.target.truePeakDbtp} dBTP). Before: {latest.before?.integratedLufs} LUFS, {latest.before?.truePeakDbtp} dBTP.
                </p>
              )}
              <details className="text-xs text-faint">
                <summary className="cursor-pointer">Processing applied</summary>
                {latest.processing.map((p) => (
                  <p key={p} className="mt-1.5">
                    {p}
                  </p>
                ))}
                <p className="mt-1.5">Timed captions are not offered: word-level alignment is not implemented, and timings would otherwise be guesses. Section start times are measured from the assembled audio.</p>
              </details>
            </>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// SoundCloud and Blogger
// ---------------------------------------------------------------------------

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied.`);
  } catch {
    toast.error('Copy failed — select the text and copy it manually.');
  }
}

export function SoundCloudPanel({ editionId, edTitle, title, description, link, onTitle, onDescription }: { editionId: string; edTitle: string; title: string; description: string; link: SoundCloudLink | null; onTitle: (t: string) => void; onDescription: (d: string) => void }) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [variant, setVariant] = useState<'theme' | 'standalone'>('theme');
  const save = async (value: string | null) => {
    setBusy(true);
    try {
      await nar('soundcloudSave', { editionId, input: value });
      setInput('');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const embed = link ? bloggerEmbedHtml(link, edTitle, variant) : '';
  return (
    <section aria-labelledby="sc-h" className="space-y-4">
      <h2 id="sc-h" className="eyebrow">
        SoundCloud
      </h2>
      <p className="text-xs text-faint">An optional extra route. The AZ Studio player above is the primary way to publish.</p>
      <ol className="space-y-4 text-[13px] text-dim">
        <li className="space-y-2">
          <p className="text-fg">1 · Upload the MP3 to SoundCloud yourself</p>
          <Field label="Title">
            <Input value={title} maxLength={100} onChange={(e) => onTitle(e.target.value)} />
          </Field>
          <Field label="Description">
            <Textarea rows={5} value={description} onChange={(e) => onDescription(e.target.value)} />
          </Field>
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="ghost" icon={<Copy className="size-3.5" />} onClick={() => void copy(title, 'Title')}>
              Copy title
            </Button>
            <Button size="sm" variant="ghost" icon={<Copy className="size-3.5" />} onClick={() => void copy(description, 'Description')}>
              Copy description
            </Button>
            <a href="https://soundcloud.com/upload" target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] text-accent-2 hover:bg-accent/10">
              <ExternalLink className="size-3.5" /> Open SoundCloud upload
            </a>
          </div>
        </li>
        <li className="space-y-2">
          <p className="text-fg">2 · Paste the track address or its embed code</p>
          {link ? (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-2">
              <a href={link.pageUrl} target="_blank" rel="noreferrer" className="min-w-0 truncate text-accent-2 hover:underline">
                {link.pageUrl.replace('https://', '')}
              </a>
              <Button size="sm" variant="ghost" aria-label="Remove the SoundCloud link" onClick={() => void save(null)} disabled={busy}>
                <X className="size-3.5" />
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <Textarea rows={2} value={input} onChange={(e) => setInput(e.target.value)} placeholder="https://soundcloud.com/… or <iframe … w.soundcloud.com/player …>" aria-label="SoundCloud track address or embed code" />
              <Button size="sm" variant="secondary" loading={busy} disabled={!input.trim()} onClick={() => void save(input)}>
                Check and save
              </Button>
              <p className="text-xs text-faint">Only the SoundCloud track address is read from pasted embed code; nothing pasted is run or copied into your post.</p>
            </div>
          )}
        </li>
        {link && (
          <li className="space-y-2">
            <p className="text-fg">3 · Paste this at the top of the Blogger post (HTML view)</p>
            <div className="flex gap-1">
              {(['theme', 'standalone'] as const).map((v) => (
                <button key={v} type="button" onClick={() => setVariant(v)} aria-pressed={variant === v} className={cx('cursor-pointer rounded-lg px-2.5 py-1 text-xs', variant === v ? 'bg-accent/18 text-fg' : 'text-dim hover:text-fg')}>
                  {v === 'theme' ? 'Pwavwe Papers theme' : 'Any template'}
                </button>
              ))}
            </div>
            <p className="text-xs text-faint">{variant === 'theme' ? 'Your blog theme (checked on blogs.pwavwe.com, 17 October 2026) moves the first SoundCloud player in a post into its “Listen to this paper” panel under the title, with the link below as its fallback.' : 'A self-contained block with its own “Listen to this paper” label and a fallback link.'} The rest of the post HTML stays as it is.</p>
            <textarea readOnly value={embed} rows={6} className="field font-mono text-[11.5px]" aria-label="Blogger embed code" onFocus={(e) => e.currentTarget.select()} />
            <Button size="sm" variant="secondary" icon={<Copy className="size-3.5" />} onClick={() => void copy(embed, 'Embed code')}>
              Copy embed code
            </Button>
          </li>
        )}
      </ol>
    </section>
  );
}
