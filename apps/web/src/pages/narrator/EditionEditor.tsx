import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { ArrowLeft, AudioLines, CircleAlert, Eraser, Play, Square, Trash2 } from 'lucide-react';
import {
  DELIVERY_PRESETS,
  DELIVERY_PRESET_IDS,
  applyCleanup,
  flattenScript,
  passageAudioState,
  passageSynthesisInput,
  buildScript,
  type EditionSettings,
  type NarratorEditionDoc,
  type NarratorPassage,
  type NarratorScript,
  mergeSuggestions,
  passageDirections,
  reanchorDirections,
  type Direction,
  type DirectionIntensity,
} from '@az-studio/shared';
import { ApiError, errorMessage } from '../../lib/api';
import { nar, newRequestId, useClips, useDirectJobs, useEdition, useExports, useNarratorJobs, useNarratorMedia, useVoices, type EstimateResult } from '../../lib/narrator';
import { Badge, Button, ConfirmDialog, Field, Input, Notice, ProgressBar, Segmented, Select, Skeleton, Tabs, Toggle } from '../../components/ui';
import { ClipPlayer, EditionPlayer } from '../../components/narrator/audio';
import { CleanupDialog, ExportPanel, GenerateDialog, PassageRow, SoundCloudPanel, type PassageView } from './editor-parts';
import { useNarrator } from './NarratorShell';
import { AddDirection, DirectionChip, DirectionsToolbar } from './directions';
import { PublishPanel } from './PublishPanel';

type Draft = Pick<NarratorEditionDoc, 'title' | 'author' | 'publishedDate' | 'sourceUrl' | 'voiceId' | 'script' | 'settings'> & { soundcloud: { title: string; description: string }; directions: Direction[]; directionsMergedJobs: string[] };
type Scope = 'selection' | 'passages' | 'section' | 'edition' | 'preview';

function draftOf(e: NarratorEditionDoc): Draft {
  return { title: e.title, author: e.author, publishedDate: e.publishedDate, sourceUrl: e.sourceUrl, voiceId: e.voiceId, script: e.script, settings: e.settings, soundcloud: { title: e.soundcloud?.title ?? '', description: e.soundcloud?.description ?? '' }, directions: e.directions ?? [], directionsMergedJobs: e.directionsMergedJobs ?? [] };
}

function mapPassages(script: NarratorScript, fn: (p: NarratorPassage) => NarratorPassage): NarratorScript {
  return { opening: script.opening ? fn(script.opening) : null, sections: script.sections.map((s) => ({ ...s, passages: s.passages.map(fn) })), closing: script.closing ? fn(script.closing) : null };
}

export default function EditionEditor() {
  const { editionId } = useParams();
  const navigate = useNavigate();
  const { status } = useNarrator();
  const live = useEdition(editionId);
  const clips = useClips(editionId);
  const exports = useExports(editionId);
  const voices = useVoices();
  const jobs = useNarratorJobs();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [rev, setRev] = useState(0);
  const [saveState, setSaveState] = useState<'saved' | 'pending' | 'saving' | 'conflict' | 'error'>('saved');
  const [tab, setTab] = useState('script');
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [gen, setGen] = useState<{ scope: Scope; passageIds: string[]; sectionId: string | null; selection?: string; force: boolean; title: string; variant?: 'directed' | 'undirected' } | null>(null);
  const [intensity, setIntensity] = useState<DirectionIntensity>('subtle');
  const [range, setRange] = useState<{ passageId: string; start: number; end: number } | null>(null);
  const undoStack = useRef<Direction[][]>([]);
  const [undoCount, setUndoCount] = useState(0);
  const directJobs = useDirectJobs(editionId);
  const [estimate, setEstimate] = useState<EstimateResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState('');
  const [seekTo, setSeekTo] = useState<{ sec: number; n: number } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [rebuild, setRebuild] = useState(false);
  const requestKey = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingDraft = useRef<Draft | null>(null);

  // Adopt the server copy on first load, and later whenever nothing local is waiting to be saved.
  useEffect(() => {
    const e = live.data;
    if (!e) return;
    if (!draft || (saveState === 'saved' && e.rev > rev)) {
      setDraft(draftOf(e));
      setRev(e.rev);
    }
  }, [live.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const flush = useCallback(async () => {
    const d = pendingDraft.current;
    if (!d || !editionId) return;
    pendingDraft.current = null;
    setSaveState('saving');
    try {
      const r = await nar<{ rev: number }>('editionSave', { editionId, baseRev: rev, patch: d });
      setRev(r.rev);
      setSaveState(pendingDraft.current ? 'pending' : 'saved');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'aborted') setSaveState('conflict');
      else {
        pendingDraft.current = pendingDraft.current ?? d;
        setSaveState('error');
        toast.error(`Not saved: ${errorMessage(e)}`);
      }
    }
  }, [editionId, rev]);

  useEffect(() => {
    if (saveState === 'pending' && pendingDraft.current) {
      saveTimer.current = setTimeout(() => void flush(), 1200);
      return () => {
        if (saveTimer.current) clearTimeout(saveTimer.current);
      };
    }
  }, [saveState, flush, draft]);

  const update = (patch: Partial<Draft>) => {
    if (!draft || saveState === 'conflict') return;
    const next = { ...draft, ...patch };
    setDraft(next);
    pendingDraft.current = next;
    if (saveState !== 'saving') setSaveState('pending');
  };

  // Warn before leaving with unsaved edits.
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (pendingDraft.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, []);

  const edition = live.data;
  const voice = voices.data.find((v) => v.id === draft?.voiceId) ?? null;
  const notebook = status?.pronunciations ?? [];
  const editionJobs = jobs.data.filter((j) => (j.params as { editionId?: string }).editionId === editionId);
  const inFlight = new Set(editionJobs.filter((j) => j.type === 'narrator.speak').flatMap((j) => ((j.params as { items?: { passageId: string | null }[] }).items ?? []).map((i) => i.passageId).filter(Boolean) as string[]));
  const latestExport = exports.data[0] ?? null;
  const readyExport = exports.data.find((x) => x.status === 'ready') ?? null;
  const exportUrl = useNarratorMedia(readyExport ? { kind: 'export', id: readyExport.id, editionId, file: 'mp3' } : null);

  const views = useMemo(() => {
    const map = new Map<string, PassageView>();
    if (!draft || !edition) return map;
    const byPassage = new Map<string, typeof clips.data>();
    for (const c of clips.data) byPassage.set(c.passageId, [...(byPassage.get(c.passageId) ?? []), c]);
    const exportStart = new Map((readyExport?.parts ?? []).map((p) => [p.passageId, p]));
    for (const f of flattenScript(draft.script, true)) {
      const p = f.passage;
      const input = voice ? passageSynthesisInput(p, draft.settings, notebook, { id: voice.id, modelId: voice.modelId }, draft.directions) : null;
      const takes = (byPassage.get(p.id) ?? []).filter((c) => c.status === 'ready').sort((a, b) => b.version - a.version);
      const selected = takes.find((c) => c.id === edition.takes?.[p.id]) ?? null;
      const forHash = (byPassage.get(p.id) ?? []).filter((c) => input && c.inputHash === input.inputHash).sort((a, b) => b.version - a.version)[0] ?? null;
      const state = passageAudioState(p, input?.inputHash ?? null, selected, forHash, inFlight.has(p.id));
      const ex = exportStart.get(p.id);
      map.set(p.id, {
        passage: p,
        state,
        selected,
        takes,
        latestProblem: forHash && forHash.status !== 'ready' ? forHash : null,
        spokenAs: input && (input.applied.length || input.directionsApplied) ? input.segments.map((s) => (s.style && s.style !== input.style ? `[${s.style}] ${s.text}` : s.text)).join(' ') : null,
        flags: input?.flagged ?? [],
        startSec: ex && selected && ex.clipId === selected.id && state === 'current' ? ex.startSec : null,
      });
    }
    return map;
  }, [draft, edition, clips.data, voice, notebook, readyExport, inFlight.size]); // eslint-disable-line react-hooks/exhaustive-deps

  // Finished Auto-direct jobs are merged once: suggestions only, re-anchored to the current text, never duplicated.
  useEffect(() => {
    if (!draft || saveState === 'conflict') return;
    const fresh = directJobs.data.filter((j) => j.status === 'completed' && !draft.directionsMergedJobs.includes(j.id));
    if (!fresh.length) return;
    let directions = draft.directions;
    let added = 0;
    for (const j of fresh) {
      const data = (j.result?.data ?? {}) as { suggestions?: Direction[]; analysed?: string[] };
      const texts = new Map(flattenScript(draft.script, true).map((f) => [f.passage.id, f.passage.text]));
      const incoming = (data.suggestions ?? []).filter((d) => texts.has(d.passageId)).flatMap((d) => reanchorDirections(texts.get(d.passageId)!, [d])).filter((d) => d.status === 'suggested');
      const merged = mergeSuggestions(directions, incoming, new Set(data.analysed ?? []));
      directions = merged.directions;
      added += merged.added;
    }
    undoStack.current.push(draft.directions);
    setUndoCount(undoStack.current.length);
    update({ directions, directionsMergedJobs: [...draft.directionsMergedJobs, ...fresh.map((j) => j.id)].slice(-200) });
    toast.success(added ? `${added} delivery suggestion${added === 1 ? '' : 's'} to review.` : 'Auto-direct found nothing new to suggest.');
  }, [directJobs.data, draft?.directionsMergedJobs.length]); // eslint-disable-line react-hooks/exhaustive-deps

  if (live.loading || !status) return <Skeleton className="h-[70vh]" />;
  if (!edition || edition.deleted || !draft) return <Notice tone="danger">This edition does not exist or was deleted. <Link to="/narrator" className="underline">Back to editions</Link></Notice>;

  const spoken = flattenScript(draft.script, draft.settings.includeClosing).filter((f) => !f.passage.skip && f.passage.text.trim());
  const counts = { current: 0, stale: 0, missing: 0, problem: 0 };
  for (const f of spoken) {
    const s = views.get(f.passage.id)?.state;
    if (s === 'current') counts.current++;
    else if (s === 'stale') counts.stale++;
    else if (s === 'needs_recovery' || s === 'failed') counts.problem++;
    else counts.missing++;
  }
  const allCurrent = spoken.length > 0 && counts.current === spoken.length;
  const exportOutdated = readyExport ? spoken.filter((f) => { const part = readyExport.parts.find((p) => p.passageId === f.passage.id); const v = views.get(f.passage.id); return !part || !v?.selected || part.clipId !== v.selected.id || v.state !== 'current'; }).length + readyExport.parts.filter((p) => !spoken.some((f) => f.passage.id === p.passageId)).length : 0;
  const approved = voice?.status === 'active' && voice.approval.state === 'approved';

  const setPassage = (id: string, patch: Partial<NarratorPassage>) => {
    const script = mapPassages(draft.script, (p) => (p.id === id ? { ...p, ...patch } : p));
    // Text edits move directions with their words; directions whose words are gone wait for review.
    if (patch.text === undefined) return update({ script });
    const mine = draft.directions.filter((d) => d.passageId === id);
    update({ script, directions: mine.length ? [...draft.directions.filter((d) => d.passageId !== id), ...reanchorDirections(patch.text, mine)] : draft.directions });
  };
  const setDirections = (next: Direction[]) => {
    undoStack.current.push(draft.directions);
    if (undoStack.current.length > 40) undoStack.current.shift();
    setUndoCount(undoStack.current.length);
    update({ directions: next });
  };
  const undoDirections = () => {
    const prev = undoStack.current.pop();
    setUndoCount(undoStack.current.length);
    if (prev) update({ directions: prev });
  };
  const directionCounts = { suggested: draft.directions.filter((d) => d.status === 'suggested').length, accepted: draft.directions.filter((d) => d.status === 'accepted').length, review: draft.directions.filter((d) => d.status === 'needs_review').length };
  const directJob = editionJobs.find((j) => j.type === 'narrator.direct');
  const runAutoDirect = async () => {
    if (saveState !== 'saved') await flush();
    try {
      const r = await nar<{ jobId: string; duplicate: boolean; estimateUsd?: number }>('autodirect', { editionId: edition.id, intensity, passageIds: [], requestId: newRequestId('ad') });
      toast.message(r.duplicate ? 'Auto-direct is already running for this edition.' : `Auto-direct is reading the script${r.estimateUsd ? ` (≈ ${r.estimateUsd.toFixed(3)})` : ''}. Suggestions appear here for review.`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const setSettings = (patch: Partial<EditionSettings>) => update({ settings: { ...draft.settings, ...patch } });

  const openGenerate = async (g: NonNullable<typeof gen>) => {
    if (saveState !== 'saved') await flush();
    setGen(g);
    setEstimate(null);
    requestKey.current = newRequestId('g');
    try {
      const est = await nar<EstimateResult>('estimate', { editionId: edition.id, scope: g.scope, passageIds: g.passageIds, sectionId: g.sectionId, ...(g.selection ? { selection: g.selection } : {}), ...(g.variant ? { variant: g.variant } : {}), force: g.force });
      // Small single-passage requests start straight away; anything else is confirmed first.
      if (!est.confirmationRequired && g.scope !== 'edition' && !est.limitProblem && est.items.length + est.reuse.length > 0) {
        setGen(null);
        await startGenerate(g, est);
        return;
      }
      setEstimate(est);
    } catch (e) {
      setGen(null);
      toast.error(errorMessage(e));
    }
  };

  const startGenerate = async (g: NonNullable<typeof gen>, est: EstimateResult) => {
    setBusy(true);
    try {
      const r = await nar<{ jobId: string | null; reused: string[] }>('generate', { editionId: edition.id, scope: g.scope, passageIds: g.passageIds, sectionId: g.sectionId, ...(g.selection ? { selection: g.selection } : {}), ...(g.variant ? { variant: g.variant } : {}), force: g.force, requestId: requestKey.current ?? newRequestId('g'), confirmedUsd: est.estimate.usd });
      if (!r.jobId && r.reused.length) toast.success('Existing takes reused — nothing new was generated.');
      setGen(null);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
      requestKey.current = null;
    }
  };

  const cancelJob = async (jobId: string) => {
    try {
      const r = await nar<{ message: string }>('jobCancel', { jobId });
      toast.message(r.message);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const exportNow = async () => {
    if (saveState !== 'saved') await flush();
    setBusy(true);
    try {
      await nar('exportStart', { editionId: edition.id, requestId: newRequestId('x') });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await nar('editionDelete', { editionId: edition.id });
      navigate('/narrator');
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(false);
    }
  };

  const previewClip = clips.data.filter((c) => c.passageId === 'preview' && c.status === 'ready').sort((a, b) => b.version - a.version)[0] ?? null;
  const exportBlockers = !spoken.length ? 'Nothing to export yet.' : allCurrent ? null : `${counts.missing + counts.problem} without audio, ${counts.stale} out of date — generate them first.`;
  const speakingJob = editionJobs.find((j) => j.type === 'narrator.speak');
  const exportJob = editionJobs.find((j) => j.type === 'narrator.export');
  const row = (p: NarratorPassage, heading = false) => {
    const v = views.get(p.id);
    if (!v) return null;
    return (
      <PassageRow
        key={p.id}
        v={v}
        heading={heading}
        editionId={edition.id}
        busy={busy || !voice}
        onText={(t) => setPassage(p.id, { text: t })}
        onSkip={(skip) => setPassage(p.id, { skip })}
        onGenerate={() => void openGenerate({ scope: 'passages', passageIds: [p.id], sectionId: null, force: v.state === 'current' || v.state === 'needs_recovery', title: 'Generate passage' })}
        onSelectTake={(clipId) => void nar('takeSelect', { editionId: edition.id, passageId: p.id, clipId }).catch((e) => toast.error(errorMessage(e)))}
        onDismiss={(clipId) => void nar('clipDismiss', { editionId: edition.id, clipId }).catch((e) => toast.error(errorMessage(e)))}
        onSelectText={setSelection}
        onSelectRange={(r) => setRange({ passageId: p.id, ...r })}
        onSeek={(sec) => setSeekTo({ sec, n: Date.now() })}
        chips={(() => {
          const mine = passageDirections(draft.directions, p).filter((d) => d.status !== 'rejected');
          if (!mine.length) return null;
          return mine.map((d) => (
            <DirectionChip
              key={d.id}
              d={d}
              flag={v.flags.find((f) => f.id === d.id)?.reason}
              onChange={(nd) => setDirections(draft.directions.map((x) => (x.id === d.id ? nd : x)))}
              onRemove={() => setDirections(d.source === 'auto' && d.status === 'suggested' ? draft.directions.map((x) => (x.id === d.id ? { ...x, status: 'rejected' } : x)) : draft.directions.filter((x) => x.id !== d.id))}
            />
          ));
        })()}
        panel={
          !p.skip && p.text.trim() ? (
            <div className="space-y-2.5">
              <AddDirection passageId={p.id} text={p.text} range={range?.passageId === p.id ? range : null} onAdd={(d) => setDirections([...draft.directions, d])} />
              <div className="flex flex-wrap gap-1.5">
                <Button size="sm" variant="ghost" disabled={!voice || busy} onClick={() => void openGenerate({ scope: 'preview', passageIds: [p.id], sectionId: null, force: false, variant: 'directed', title: 'Preview this passage' })}>
                  Preview this passage
                </Button>
                <Button size="sm" variant="ghost" disabled={!voice || busy} onClick={() => void openGenerate({ scope: 'preview', passageIds: [p.id], sectionId: null, force: false, variant: 'undirected', title: 'Preview without directions' })}>
                  Preview without directions
                </Button>
              </div>
              {(['directed', 'undirected'] as const).map((variant) => {
                const c = clips.data.filter((x) => x.passageId === `preview-${variant}-${p.id}` && x.status === 'ready').sort((a, b) => b.version - a.version)[0];
                return c ? <PreviewLine key={variant} editionId={edition.id} clipId={c.id} text={variant === 'directed' ? 'With directions' : 'Without directions'} peaks={c.peaks} /> : null;
              })}
            </div>
          ) : null
        }
      />
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link to="/narrator" className="inline-flex items-center gap-1.5 text-sm text-dim hover:text-fg">
          <ArrowLeft className="size-4" /> Editions
        </Link>
        <p className="text-xs text-faint" role="status" aria-live="polite">
          {saveState === 'saved' ? 'All changes saved' : saveState === 'saving' ? 'Saving…' : saveState === 'pending' ? 'Unsaved changes' : saveState === 'conflict' ? '' : 'Not saved — retrying on the next change'}
        </p>
      </div>
      {saveState === 'conflict' && (
        <Notice tone="warning" icon={<CircleAlert className="size-4" />}>
          This edition was changed in another tab or window, so your latest edit was not saved.{' '}
          <button type="button" className="cursor-pointer font-medium underline" onClick={() => window.location.reload()}>
            Reload the latest version
          </button>
        </Notice>
      )}

      <div className="space-y-3">
        <label className="sr-only" htmlFor="ed-title">
          Title
        </label>
        <textarea id="ed-title" rows={1} value={draft.title} maxLength={200} onChange={(e) => update({ title: e.target.value.replace(/\s*\n\s*/g, ' ') })} ref={(el) => { if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; } }} className="display w-full resize-none overflow-hidden bg-transparent text-[34px] leading-tight text-fg outline-none sm:text-[46px]" />
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Author" className="w-44">
            <Input value={draft.author} onChange={(e) => update({ author: e.target.value })} />
          </Field>
          <Field label="Published" className="w-44">
            <Input type="date" value={draft.publishedDate ?? ''} onChange={(e) => update({ publishedDate: e.target.value || null })} />
          </Field>
          <Field label="Article URL" className="min-w-56 flex-1">
            <Input type="url" value={draft.sourceUrl ?? ''} onChange={(e) => update({ sourceUrl: e.target.value.trim() || null })} placeholder="https://blogs.pwavwe.com/…" />
          </Field>
          <Field label="Voice" className="w-56">
            <Select value={draft.voiceId ?? ''} onChange={(e) => update({ voiceId: e.target.value || null })}>
              <option value="">No voice</option>
              {voices.data
                .filter((v) => v.status !== 'deleted')
                .map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.displayName} · {v.approval.state === 'approved' ? 'approved' : v.status === 'active' ? 'not approved' : v.status.replace(/_/g, ' ')}
                  </option>
                ))}
            </Select>
          </Field>
        </div>
        {!approved && (
          <Notice tone="warning">
            {voice ? 'This voice is not approved yet. You can preview a selection, but approve it in My Voice before narrating the edition.' : 'Choose a voice. '}{' '}
            <Link to="/narrator/voice" className="font-medium underline">
              My Voice
            </Link>
          </Notice>
        )}
      </div>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="order-2 min-w-0 space-y-4 lg:order-1">
          <Tabs value={tab} onValueChange={setTab} tabs={[{ value: 'script', label: 'Narration script' }, { value: 'article', label: 'Original article' }]} />
          {tab === 'article' ? (
            <div className="space-y-4">
              {edition.article.notes.length > 0 && (
                <Notice tone="accent">
                  {edition.article.notes.map((n) => (
                    <p key={n}>{n}</p>
                  ))}
                </Notice>
              )}
              <div className="max-w-[70ch] text-[16.5px] leading-[1.75] whitespace-pre-wrap text-dim">{edition.article.body || 'No article text.'}</div>
              <Button size="sm" variant="ghost" onClick={() => setRebuild(true)}>
                Rebuild the script from the article
              </Button>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-black/20 p-2">
                <Segmented size="sm" label="Delivery" value={draft.settings.preset} onChange={(v) => setSettings({ preset: v })} options={DELIVERY_PRESET_IDS.map((id) => ({ value: id, label: DELIVERY_PRESETS[id].label }))} />
                <Button size="sm" variant="ghost" icon={<Eraser className="size-3.5" />} onClick={() => setCleanupOpen(true)}>
                  Review cleanup
                </Button>
                <Button size="sm" variant="ghost" icon={<Play className="size-3.5" />} disabled={!selection.trim() || selection.length > 1500 || !voice || busy} title={selection.trim() ? 'Hear the selected text' : 'Select text in a passage first'} onClick={() => void openGenerate({ scope: 'selection', passageIds: [], sectionId: null, selection: selection.trim(), force: false, title: 'Preview selection' })}>
                  Preview selection
                </Button>
                <span className="ml-auto pr-1 text-[11.5px] text-faint">
                  {counts.current}/{spoken.length} current{counts.stale ? ` · ${counts.stale} out of date` : ''}
                  {counts.problem ? ` · ${counts.problem} need attention` : ''}
                </span>
              </div>
              <DirectionsToolbar
                intensity={intensity}
                onIntensity={setIntensity}
                onRun={() => void runAutoDirect()}
                running={Boolean(directJob)}
                counts={directionCounts}
                onAcceptAll={() => setDirections(draft.directions.map((d) => (d.status === 'suggested' ? { ...d, status: 'accepted' } : d)))}
                onRejectAll={() => setDirections(draft.directions.map((d) => (d.status === 'suggested' ? { ...d, status: 'rejected' } : d)))}
                onRemoveAll={() => window.confirm('Remove every direction from this edition (accepted, suggested and manual)? Undo can bring them back.') && setDirections([])}
                onUndo={undoDirections}
                canUndo={undoCount > 0}
              />
              <details className="rounded-xl border border-line px-4 py-2.5 text-sm">
                <summary className="cursor-pointer text-dim">Delivery direction and pauses</summary>
                <div className="mt-3 grid gap-4 sm:grid-cols-2">
                  <Field label="Custom delivery (replaces the preset)" hint="Short, e.g. “warm, unhurried”. Sent as a style direction, never spoken.">
                    <Input value={draft.settings.customStyle} maxLength={80} onChange={(e) => setSettings({ customStyle: e.target.value })} />
                  </Field>
                  <Field label="Pause between paragraphs (s)">
                    <Input type="number" min={0.15} max={4} step={0.05} value={draft.settings.pauses.betweenParagraphsSec} onChange={(e) => setSettings({ pauses: { ...draft.settings.pauses, betweenParagraphsSec: Math.min(4, Math.max(0.15, Number(e.target.value) || 0.15)) } })} />
                  </Field>
                  <Field label="Pause between sections (s)">
                    <Input type="number" min={0.15} max={4} step={0.05} value={draft.settings.pauses.betweenSectionsSec} onChange={(e) => setSettings({ pauses: { ...draft.settings.pauses, betweenSectionsSec: Math.min(4, Math.max(0.15, Number(e.target.value) || 0.15)) } })} />
                  </Field>
                  <Field label="Pause after the opening (s)">
                    <Input type="number" min={0.15} max={4} step={0.05} value={draft.settings.pauses.afterOpeningSec} onChange={(e) => setSettings({ pauses: { ...draft.settings.pauses, afterOpeningSec: Math.min(4, Math.max(0.15, Number(e.target.value) || 0.15)) } })} />
                  </Field>
                </div>
                <p className="mt-2 text-xs text-faint">Changing the delivery changes every passage’s inputs, so existing audio becomes out of date. Pauses only affect the export.</p>
              </details>

              <article className="space-y-6">
                {draft.script.opening && (
                  <section aria-label="Opening" className="space-y-1">
                    <p className="eyebrow px-4">Opening</p>
                    {row(draft.script.opening)}
                  </section>
                )}
                {draft.script.sections.map((s, i) => (
                  <section key={s.id} aria-label={s.title ?? `Section ${i + 1}`} className="space-y-1">
                    <div className="flex items-center justify-between gap-2 px-4">
                      <p className="eyebrow">{s.title ? `Section ${i + 1}` : 'Introduction'}</p>
                      <Button size="sm" variant="ghost" disabled={!approved || busy} onClick={() => void openGenerate({ scope: 'section', passageIds: [], sectionId: s.id, force: false, title: `Generate “${s.title ?? 'Introduction'}”` })}>
                        Generate section
                      </Button>
                    </div>
                    {s.passages.map((p) => row(p, p.kind === 'heading'))}
                  </section>
                ))}
                {draft.script.closing && (
                  <section aria-label="Closing" className="space-y-1">
                    <div className="flex items-center justify-between gap-2 px-4">
                      <p className="eyebrow">Closing</p>
                      <Toggle checked={draft.settings.includeClosing} onChange={(v) => setSettings({ includeClosing: v })} label={<span className="text-xs text-dim">Include</span>} />
                    </div>
                    {draft.settings.includeClosing && row(draft.script.closing)}
                  </section>
                )}
              </article>
            </>
          )}
        </div>

        <aside className="order-1 space-y-8 lg:sticky lg:top-6 lg:order-2 lg:self-start">
          <section aria-label="Player" className="space-y-3 rounded-2xl border border-line bg-panel/60 p-4">
            {readyExport ? (
              <>
                {exportOutdated > 0 && <Badge tone="warning">Playing export v{readyExport.version} — out of date</Badge>}
                <EditionPlayer src={exportUrl} peaks={readyExport.peaks} duration={readyExport.durationSec} sections={readyExport.sections.map((s) => ({ title: s.title, startSec: s.startSec }))} seekTo={seekTo} />
              </>
            ) : (
              <p className="text-sm text-dim">The full edition plays here once it is exported. Until then, open any passage (the dot beside it) to hear its take.</p>
            )}
            {previewClip && <PreviewLine editionId={edition.id} clipId={previewClip.id} text={previewClip.text} peaks={previewClip.peaks} />}
          </section>

          <section aria-label="Generate" className="space-y-3">
            {editionJobs.map((j) => (
              <div key={j.id} className="space-y-2 rounded-xl border border-accent/25 bg-accent/[0.06] p-3" aria-live="polite">
                <div className="flex items-center justify-between gap-2">
                  <p className="min-w-0 truncate text-sm text-fg">{j.stage}</p>
                  <Button size="sm" variant="ghost" icon={<Square className="size-3" />} onClick={() => void cancelJob(j.id)} disabled={j.cancelRequested}>
                    {j.cancelRequested ? 'Stopping…' : 'Cancel'}
                  </Button>
                </div>
                <ProgressBar value={j.progress} label={j.label} />
              </div>
            ))}
            <Button variant="primary" size="lg" className="w-full" icon={<AudioLines className="size-4" />} disabled={!approved || busy || Boolean(speakingJob) || allCurrent} onClick={() => void openGenerate({ scope: 'edition', passageIds: [], sectionId: null, force: false, title: 'Generate the edition' })}>
              {allCurrent ? 'All passages are current' : counts.current ? `Generate the remaining ${spoken.length - counts.current}` : 'Generate full edition'}
            </Button>
            <p className="text-xs text-faint">Only passages without current audio are generated. You confirm the estimate first; nothing paid starts on its own.</p>
          </section>

          <ExportPanel editionId={edition.id} latest={latestExport} outdated={exportOutdated} canExport={allCurrent && !exportJob && saveState !== 'conflict'} blockers={exportBlockers} onExport={() => void exportNow()} exporting={Boolean(exportJob)} />

          <PublishPanel editionId={edition.id} title={draft.title} publication={edition.publication ?? null} exports={exports.data} />

          <details className="rounded-xl border border-line px-4 py-3">
            <summary className="cursor-pointer text-sm text-dim">SoundCloud (optional distribution)</summary>
            <div className="mt-3">
          <SoundCloudPanel editionId={edition.id} edTitle={draft.title} title={draft.soundcloud.title} description={draft.soundcloud.description} link={edition.soundcloud?.link ?? null} onTitle={(t) => update({ soundcloud: { ...draft.soundcloud, title: t } })} onDescription={(d) => update({ soundcloud: { ...draft.soundcloud, description: d } })} />
            </div>
          </details>

          <div className="border-t border-line pt-4">
            <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => setDeleting(true)}>
              Delete edition
            </Button>
          </div>
        </aside>
      </div>

      <CleanupDialog
        open={cleanupOpen}
        onOpenChange={setCleanupOpen}
        script={draft.script}
        onApply={(accepted, skips) => {
          update({ script: applyCleanup(draft.script, accepted, skips) });
          toast.success('Cleanup applied to the spoken text.');
        }}
      />
      <GenerateDialog open={Boolean(gen)} onOpenChange={(o) => !o && setGen(null)} estimate={estimate} title={gen?.title ?? ''} busy={busy} onConfirm={() => gen && estimate && void startGenerate(gen, estimate)} />
      <ConfirmDialog open={deleting} onOpenChange={setDeleting} danger loading={busy} title="Delete this edition?" confirmLabel="Delete edition" onConfirm={() => void remove()} body="The script, every generated take and every export of this edition are deleted. Your voice and other editions are not affected. Anything already uploaded to SoundCloud stays there." />
      <ConfirmDialog
        open={rebuild}
        onOpenChange={setRebuild}
        title="Rebuild the script?"
        confirmLabel="Rebuild"
        onConfirm={() => {
          const built = buildScript({ title: draft.title, body: edition.article.body, openingTemplate: status.settings.openingTemplate, closingText: status.settings.closingText });
          update({ script: built.script });
          setRebuild(false);
        }}
        body="Your edits to the spoken text are replaced by a fresh script from the original article. Existing takes stay stored but no longer match, so the passages need generating again."
      />
    </div>
  );
}

function PreviewLine({ editionId, clipId, text, peaks }: { editionId: string; clipId: string; text: string; peaks: number[] | null }) {
  const src = useNarratorMedia({ kind: 'clip', id: clipId, editionId });
  return (
    <div className="space-y-1.5 border-t border-line pt-3">
      <p className="text-xs text-faint">Selection preview: “{text.length > 90 ? `${text.slice(0, 90)}…` : text}”</p>
      <ClipPlayer src={src} peaks={peaks} label="selection preview" />
    </div>
  );
}

