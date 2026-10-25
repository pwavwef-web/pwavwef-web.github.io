import { useMemo, useRef, useState } from 'react';
import { collection, limit, orderBy, query, where } from 'firebase/firestore';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, Check, CircleAlert, Mic, Music2, PenLine, Plus, Sparkles, Trash2, Wand2 } from 'lucide-react';
import {
  allFacts,
  assembleLinkAd,
  CAPTION_PRESETS,
  linkAdReadiness,
  linkAdStatus,
  LINKAD_LIMITS,
  LINKAD_MOTIONS,
  LINKAD_VOICES,
  newId,
  restampScene,
  wordCount,
  type AdScene,
  type AssetDoc,
  type CostEstimate,
  type LiteAssetInfo,
  type LinkAdAsset,
} from '@az-studio/shared';
import { errorMessage } from '../../lib/api';
import { useQuery } from '../../lib/data';
import { db } from '../../lib/firebase';
import { useAssetMap } from '../../lib/lite';
import { linkAdCall, newRequestId } from '../../lib/linkad';
import { uploadFile } from '../../lib/media';
import { useUid } from '../../lib/session';
import { LitePlayer } from '../../components/lite/LitePlayer';
import { Badge, Button, cx, Field, Input, Modal, Notice, Select, Textarea } from '../../components/ui';
import { CostLine, EstimateBlock, Panel, StoryboardPreview, Thumb, useEstimate, type EstimateReply } from './common';
import type { StepProps } from './LinkAdWorkspace';

const MOTION_LABEL: Record<(typeof LINKAD_MOTIONS)[number], string> = { still: 'Hold still', push_in: 'Slow push in', pull_out: 'Slow pull out', pan_left: 'Drift left', pan_right: 'Drift right' };
const ROLE_LABEL: Record<AdScene['role'], string> = { hook: 'Opening hook', offer: 'Offering and main benefit', detail: 'Supporting detail', cta: 'Closing action' };

function FocalPicker({ asset, scene, onPick }: { asset: LinkAdAsset; scene: AdScene; onPick: (x: number, y: number) => void }) {
  const box = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={box}
      role="button"
      tabIndex={0}
      aria-label="Choose the part of the picture that must stay in view"
      className="relative h-28 w-40 shrink-0 cursor-crosshair overflow-hidden rounded-lg border border-line bg-black/40"
      onClick={(e) => {
        const r = box.current!.getBoundingClientRect();
        onPick(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)));
      }}
      onKeyDown={(e) => {
        const step = 0.08;
        if (e.key === 'ArrowLeft') onPick(Math.max(0, scene.focal.x - step), scene.focal.y);
        if (e.key === 'ArrowRight') onPick(Math.min(1, scene.focal.x + step), scene.focal.y);
        if (e.key === 'ArrowUp') onPick(scene.focal.x, Math.max(0, scene.focal.y - step));
        if (e.key === 'ArrowDown') onPick(scene.focal.x, Math.min(1, scene.focal.y + step));
      }}
    >
      <Thumb asset={asset} className="object-fill" />
      <span className="pointer-events-none absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-accent/70 shadow" style={{ left: `${scene.focal.x * 100}%`, top: `${scene.focal.y * 100}%` }} />
    </div>
  );
}

export function EditStep(p: StepProps) {
  const { editor, project, act, job } = p;
  const uid = useUid();
  const doc = editor.doc;
  const server = editor.server;
  const [reviseOpen, setReviseOpen] = useState<{ scope: 'hook' | 'script' | 'scene'; sceneId: string | null } | null>(null);
  const [guidance, setGuidance] = useState('');
  const [enhanceFor, setEnhanceFor] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const status = useMemo(() => linkAdStatus(doc), [doc]);
  const busyJob = Boolean(server.activeJobId);
  const recording = server.activeJobId && job?.type === 'linkad.run' && (job.params as { step?: string }).step === 'voice';

  const refs = useMemo(() => new Map(doc.source.assets.map((a) => [a.id, a])), [doc.source.assets]);
  const studioIds = useMemo(() => {
    const ids: string[] = [];
    for (const s of doc.ad.scenes) {
      const a = s.assetId ? refs.get(s.assetId) : null;
      if (a?.assetId) ids.push(a.assetId);
    }
    const logo = doc.brief.logoId ? refs.get(doc.brief.logoId) : null;
    if (logo?.assetId) ids.push(logo.assetId);
    for (const t of Object.values(doc.ad.takes)) ids.push(t.assetId);
    if (doc.ad.music.assetId) ids.push(doc.ad.music.assetId);
    return ids;
  }, [doc.ad.scenes, doc.ad.takes, doc.ad.music.assetId, doc.brief.logoId, refs]);
  const assetDocs = useAssetMap(studioIds);
  const assembly = useMemo(() => {
    const assets: Record<string, LiteAssetInfo> = {};
    for (const [id, a] of Object.entries(assetDocs)) if (a.status === 'ready') assets[id] = { width: a.width ?? null, height: a.height ?? null, durationSec: a.durationSec ?? null };
    return assembleLinkAd({ doc, assets, outWidth: 1080 });
  }, [doc, assetDocs]);
  const issues = useMemo(() => linkAdReadiness(doc, { final: true }), [doc]);
  const errors = issues.filter((i) => i.severity === 'error');

  const libraryAudio = useQuery<AssetDoc>(() => (uid ? query(collection(db, 'assets'), where('ownerUid', '==', uid), where('kind', '==', 'audio'), where('status', '==', 'ready'), orderBy('createdAt', 'desc'), limit(30)) : null), [uid]);
  const fileRef = useRef<HTMLInputElement>(null);

  const setScenes = (fn: (s: AdScene[]) => AdScene[]) => editor.update((d) => ({ ...d, ad: { ...d.ad, scenes: fn(d.ad.scenes) } }));
  const patchScene = (id: string, patch: Partial<AdScene>) => setScenes((ss) => ss.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const move = (i: number, dir: -1 | 1) => setScenes((ss) => {
    const j = i + dir;
    if (j < 0 || j >= ss.length) return ss;
    const c = [...ss];
    [c[i], c[j]] = [c[j]!, c[i]!];
    return c;
  });
  const patchAd = (patch: Partial<typeof doc.ad>) => editor.update((d) => ({ ...d, ad: { ...d.ad, ...patch } }));
  const stored = doc.source.assets.filter((a) => a.status === 'stored' && a.role === 'image');
  const totalNow = status.totalSec;

  // --- voice -------------------------------------------------------------------------------------------------------
  const voiceKey = status.scenesNeedingVoice.join(',') + `|${doc.brief.voice}|${server.revision}`;
  const voiceEst = useEstimate(busyJob || !server.ad.scenes.length ? null : () => linkAdCall<{ estimate: CostEstimate | null; problem?: string | null; capUsd?: number; committedUsd?: number; noop?: boolean; interrupted?: string[]; sceneIds?: string[]; needsConfirm?: boolean; fixture?: boolean }>({ op: 'voice', projectId: project.id, requestId: 'estimate-only', estimateOnly: true }), voiceKey);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const record = (sceneIds?: string[]) =>
    act('Could not record', async () => {
      const e = await linkAdCall<{ estimate: CostEstimate | null; interrupted?: string[]; needsConfirm?: boolean; noop?: boolean }>({ op: 'voice', projectId: project.id, requestId: 'estimate-only', estimateOnly: true, sceneIds });
      if (e.noop) {
        toast.message('Every scene already has a current recording.');
        return;
      }
      const r = await linkAdCall<{ started: boolean }>({ op: 'voice', projectId: project.id, requestId: newRequestId(), sceneIds, confirmedUsd: e.estimate?.usd ?? 0, acknowledgeInterrupted: Boolean(e.interrupted?.length) });
      toast.success(r.started ? 'Recording the voice' : 'Already recording', { description: 'Each scene is saved as soon as it is recorded, so nothing is lost if you leave.' });
      setVoiceOpen(false);
    });

  // --- revise ------------------------------------------------------------------------------------------------------
  const reviseEst = useEstimate(reviseOpen ? () => linkAdCall<EstimateReply>({ op: 'revise', projectId: project.id, requestId: 'estimate-only', scope: reviseOpen.scope, sceneId: reviseOpen.sceneId, guidance, estimateOnly: true }) : null, `${reviseOpen?.scope}|${reviseOpen?.sceneId}`);
  const revise = () =>
    act('Could not rewrite', async () => {
      if (!reviseOpen) return;
      await linkAdCall({ op: 'revise', projectId: project.id, requestId: newRequestId(), scope: reviseOpen.scope, sceneId: reviseOpen.sceneId, guidance });
      toast.success('Rewriting', { description: 'Only the words you chose change. Pictures and the other recordings stay.' });
      setReviseOpen(null);
    });

  // --- music -------------------------------------------------------------------------------------------------------
  const chooseMusic = (assetId: string) => {
    const a = libraryAudio.data.find((x) => x.id === assetId);
    patchAd({ music: { ...doc.ad.music, assetId: assetId || null, title: a?.title ?? '', rightsConfirmed: assetId === doc.ad.music.assetId ? doc.ad.music.rightsConfirmed : false } });
  };
  const uploadMusic = async (file: File | undefined) => {
    if (!file) return;
    await act('Could not add the music', async () => {
      const id = await uploadFile(file, { kind: 'audio', projectId: project.id, collections: ['linkad:music'] });
      patchAd({ music: { ...doc.ad.music, assetId: id, title: file.name.replace(/\.[^.]+$/, ''), rightsConfirmed: false } });
    });
  };

  // --- enhance -----------------------------------------------------------------------------------------------------
  const enhanceEst = useEstimate(enhanceFor ? () => linkAdCall<{ estimate: CostEstimate; problem: string | null; capUsd: number; committedUsd: number; warning: string }>({ op: 'enhance', projectId: project.id, requestId: newRequestId(), sceneId: enhanceFor, estimateOnly: true }) : null, `${enhanceFor}`);
  const enhance = () =>
    act('Could not start', async () => {
      if (!enhanceFor || !enhanceEst.data?.estimate) return;
      await linkAdCall({ op: 'enhance', projectId: project.id, requestId: newRequestId(), sceneId: enhanceFor, estimateOnly: false, confirmedUsd: enhanceEst.data.estimate.usd });
      toast.success('Extending the picture', { description: 'It will appear in your pictures marked as AI-made. You must look at it before using it.' });
      setEnhanceFor(null);
    });

  const addScene = () => setScenes((ss) => (ss.length >= LINKAD_LIMITS.maxScenes ? ss : [...ss.slice(0, -1), { id: newId('s'), role: 'detail', narration: '', overlay: '', overlayPos: 'upper', assetId: null, focal: { x: 0.5, y: 0.5 }, motion: 'still', factIds: [], factStamp: {}, review: null }, ...ss.slice(-1)]));
  const factsById = new Map(allFacts(doc).map((f) => [f.id, f]));

  const sceneIssues = (id: string) => issues.filter((i) => i.sceneId === id);
  const playable = status.voiceComplete && assembly.durationSec > 0;

  if (!doc.ad.scenes.length) {
    return (
      <Notice tone="accent">
        Choose a direction first.{' '}
        <button type="button" className="cursor-pointer underline" onClick={() => p.go('directions')}>
          See the directions
        </button>
      </Notice>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
      <aside className="space-y-4 xl:sticky xl:top-4 xl:self-start">
        <div className="card space-y-3 p-4">
          <p className="eyebrow">Preview</p>
          {playable ? (
            <LitePlayer state={assembly.state} durationSec={assembly.durationSec} markers={assembly.windows.map((w, i) => ({ time: w.start, label: `Scene ${i + 1}` }))} className="mx-auto max-w-[280px]" />
          ) : (
            <StoryboardPreview doc={doc} scenes={doc.ad.scenes} onScene={setSelected} />
          )}
          {!playable && <p className="text-center text-[11px] text-faint">Rough preview. Record the voice for the real one, with the timing and captions of the video.</p>}
          {playable && <p className="text-center text-[11px] text-faint">Drawn from the same timeline the renderer uses. A draft export shows the exact pixels.</p>}
        </div>
        <div className="card space-y-2 p-4">
          <p className="eyebrow">Length</p>
          <p className="timecode text-3xl text-fg">{totalNow.toFixed(1)} s</p>
          <p className="text-xs text-dim">
            {status.scenes.every((s) => !s.spokenEstimate || !s.words) ? 'Measured from the recorded voice.' : 'Estimated from the words until the voice is recorded.'} Allowed: {LINKAD_LIMITS.durationMin}–{LINKAD_LIMITS.durationMax} s.
          </p>
          {status.lengthProblem && <Notice tone="warning">{status.lengthProblem}</Notice>}
        </div>
        <div className="card space-y-2 p-4">
          <p className="eyebrow">Before export</p>
          {errors.length === 0 ? (
            <Notice tone="success">Nothing blocks the final export.</Notice>
          ) : (
            <ul className="space-y-1.5">
              {errors.slice(0, 8).map((i, k) => (
                <li key={k} className="flex gap-1.5 text-xs text-dim">
                  <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden />
                  {i.message}
                </li>
              ))}
              {errors.length > 8 && <li className="text-xs text-faint">+{errors.length - 8} more on the Export step</li>}
            </ul>
          )}
          <Button variant="primary" className="w-full" onClick={() => p.go('export')}>
            Go to export
          </Button>
        </div>
      </aside>

      <div className="min-w-0 space-y-6">
        <Panel
          title={doc.ad.title || 'Your ad'}
          sub="Change anything. Only the work that depends on a change is redone: new words need a new recording for that scene; a caption colour needs nothing but the export."
          action={
            <div className="flex flex-wrap gap-2">
              <Button icon={<Wand2 className="size-4" />} onClick={() => setReviseOpen({ scope: 'hook', sceneId: null })} disabled={busyJob}>
                Rewrite the hook
              </Button>
              <Button icon={<PenLine className="size-4" />} onClick={() => setReviseOpen({ scope: 'script', sceneId: null })} disabled={busyJob}>
                Rewrite the script
              </Button>
            </div>
          }
        >
          <ol className="space-y-4">
            {doc.ad.scenes.map((s, i) => {
              const st = status.scenes.find((x) => x.id === s.id)!;
              const ref = s.assetId ? refs.get(s.assetId) : undefined;
              const take = doc.ad.takes[s.id];
              const my = sceneIssues(s.id).filter((x) => x.severity === 'error');
              return (
                <li key={s.id} className={cx('space-y-3 rounded-2xl border p-4', selected === i ? 'border-accent/40' : 'border-line')} onFocus={() => setSelected(i)}>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="accent">Scene {i + 1}</Badge>
                    <span className="text-xs text-dim">{ROLE_LABEL[s.role]}</span>
                    <Badge tone={st.voice === 'current' ? 'success' : st.voice === 'stale' ? 'warning' : 'neutral'}>{st.voice === 'current' ? 'Voice recorded' : st.voice === 'stale' ? 'Voice out of date' : st.words ? 'No voice yet' : 'No narration'}</Badge>
                    {take?.alignment === 'estimated' && st.voice === 'current' && <Badge tone="warning">Caption timing estimated</Badge>}
                    {take?.source === 'fixture' && <Badge tone="violet">Fixture tones</Badge>}
                    <span className="ml-auto flex items-center gap-1">
                      <button type="button" aria-label="Move up" disabled={i === 0} className="cursor-pointer rounded p-1 text-dim hover:text-fg disabled:opacity-30" onClick={() => move(i, -1)}>
                        <ArrowUp className="size-4" />
                      </button>
                      <button type="button" aria-label="Move down" disabled={i === doc.ad.scenes.length - 1} className="cursor-pointer rounded p-1 text-dim hover:text-fg disabled:opacity-30" onClick={() => move(i, 1)}>
                        <ArrowDown className="size-4" />
                      </button>
                      <button type="button" aria-label="Remove this scene" disabled={doc.ad.scenes.length <= LINKAD_LIMITS.minScenes} className="cursor-pointer rounded p-1 text-dim hover:text-danger disabled:opacity-30" onClick={() => setScenes((ss) => ss.filter((x) => x.id !== s.id))}>
                        <Trash2 className="size-4" />
                      </button>
                    </span>
                  </div>

                  {s.review && (
                    <Notice tone="warning">
                      {s.review}{' '}
                      <button type="button" className="cursor-pointer underline" onClick={() => setScenes((ss) => ss.map((x) => (x.id === s.id ? restampScene(doc, x) : x)))}>
                        The words are still right
                      </button>
                    </Notice>
                  )}

                  <Field label="What the voice says" htmlFor={`n-${s.id}`} hint={`${wordCount(s.narration)} words · about ${st.speechSec.toFixed(1)} s${st.spokenEstimate ? ' (estimate)' : ''} · ${s.narration.length}/${LINKAD_LIMITS.narrationChars}`}>
                    <Textarea id={`n-${s.id}`} rows={2} maxLength={LINKAD_LIMITS.narrationChars} value={s.narration} onChange={(e) => patchScene(s.id, { narration: e.target.value })} />
                  </Field>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_9rem]">
                    <Field label="Text on screen" htmlFor={`o-${s.id}`} hint="Drawn by the editor in exact letters, never inside a picture.">
                      <Input id={`o-${s.id}`} value={s.overlay} maxLength={LINKAD_LIMITS.overlayChars} onChange={(e) => patchScene(s.id, { overlay: e.target.value })} />
                    </Field>
                    <Field label="Position" htmlFor={`p-${s.id}`}>
                      <Select id={`p-${s.id}`} value={s.overlayPos} onChange={(e) => patchScene(s.id, { overlayPos: e.target.value as AdScene['overlayPos'] })}>
                        <option value="upper">Upper</option>
                        <option value="middle">Middle</option>
                        <option value="lower">Lower</option>
                      </Select>
                    </Field>
                  </div>

                  <div className="space-y-2">
                    <p className="text-xs font-medium text-dim">Picture</p>
                    <ul className="flex flex-wrap gap-2">
                      <li>
                        <button type="button" aria-pressed={!s.assetId} onClick={() => patchScene(s.id, { assetId: null, motion: 'still' })} className={cx('grid h-14 w-12 cursor-pointer place-items-center rounded-lg border text-[10px] text-dim', !s.assetId ? 'border-accent bg-accent/10' : 'border-line hover:text-fg')}>
                          Text only
                        </button>
                      </li>
                      {stored.map((a) => (
                        <li key={a.id}>
                          <button type="button" aria-pressed={s.assetId === a.id} title={a.alt || 'Picture'} onClick={() => patchScene(s.id, { assetId: a.id, motion: s.motion === 'still' && !s.assetId ? 'push_in' : s.motion })} className={cx('relative h-14 w-12 cursor-pointer overflow-hidden rounded-lg border', s.assetId === a.id ? 'border-accent ring-1 ring-accent/50' : 'border-line opacity-70 hover:opacity-100')}>
                            <Thumb asset={a} />
                            {a.origin === 'generated' && <span className="absolute inset-x-0 bottom-0 bg-warning/80 text-center text-[8px] text-black">AI</span>}
                          </button>
                        </li>
                      ))}
                    </ul>
                    {ref && ref.status === 'stored' && (
                      <div className="flex flex-wrap items-start gap-3">
                        <FocalPicker asset={ref} scene={s} onPick={(x, y) => patchScene(s.id, { focal: { x, y } })} />
                        <div className="space-y-2">
                          <p className="max-w-[16rem] text-[11px] text-faint">Click the part that must stay in view when the picture is cropped to vertical. Pictures too small to fill the frame sharply are shown whole, framed on the brand colour.</p>
                          <Select aria-label="Camera move" value={s.motion} onChange={(e) => patchScene(s.id, { motion: e.target.value as AdScene['motion'] })}>
                            {LINKAD_MOTIONS.map((m) => (
                              <option key={m} value={m}>
                                {MOTION_LABEL[m]}
                              </option>
                            ))}
                          </Select>
                          {ref.origin !== 'generated' && (
                            <Button size="sm" variant="ghost" icon={<Sparkles className="size-3.5" />} onClick={() => setEnhanceFor(s.id)} disabled={busyJob}>
                              Extend with AI (optional, paid)
                            </Button>
                          )}
                          {ref.needsReview && !ref.reviewed && (
                            <label className="flex items-center gap-1.5 text-[11px] text-warning">
                              <input type="checkbox" checked={ref.reviewed} onChange={(e) => void editor.commit({ assets: [{ id: ref.id, reviewed: e.target.checked }] }).catch(() => undefined)} /> I have looked at this AI-made picture and it shows the real thing
                            </label>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  {s.factIds.length > 0 && <p className="text-[11px] text-faint">Relies on: {s.factIds.map((id) => factsById.get(id)?.text.slice(0, 40) ?? 'a removed fact').join(' · ')}</p>}
                  {my.length > 0 && (
                    <ul className="space-y-0.5">
                      {my.slice(0, 3).map((x, k) => (
                        <li key={k} className="text-[11px] text-danger">
                          {x.message}
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" icon={<Wand2 className="size-3.5" />} onClick={() => setReviseOpen({ scope: 'scene', sceneId: s.id })} disabled={busyJob}>
                      Rewrite this scene
                    </Button>
                    <Button size="sm" icon={<Mic className="size-3.5" />} onClick={() => void record([s.id])} disabled={busyJob || p.busy || !s.narration.trim() || st.voice === 'current'}>
                      {st.voice === 'stale' ? 'Record again' : 'Record this scene'}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ol>
          <Button icon={<Plus className="size-4" />} onClick={addScene} disabled={doc.ad.scenes.length >= LINKAD_LIMITS.maxScenes}>
            Add a scene
          </Button>
        </Panel>

        <Panel title="Closing" sub="The last thing the viewer sees: what to do, and where.">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="Call to action" htmlFor="cl-h">
              <Input id="cl-h" value={doc.ad.closing.headline} maxLength={LINKAD_LIMITS.overlayChars} onChange={(e) => patchAd({ closing: { ...doc.ad.closing, headline: e.target.value } })} />
            </Field>
            <Field label="Website, phone or email" htmlFor="cl-l">
              <Input id="cl-l" value={doc.ad.closing.line} maxLength={120} onChange={(e) => patchAd({ closing: { ...doc.ad.closing, line: e.target.value } })} />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm text-dim">
            <input type="checkbox" checked={doc.ad.closing.showLogo} onChange={(e) => patchAd({ closing: { ...doc.ad.closing, showLogo: e.target.checked } })} /> Show the logo
          </label>
        </Panel>

        <Panel title="Voice and sound" sub="Voice and music are separate tracks; music is lowered automatically while the voice speaks.">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <Field label="Voice" htmlFor="v-v" hint="Changing the voice re-records every scene.">
              <Select id="v-v" value={doc.brief.voice} onChange={(e) => editor.update((d) => ({ ...d, brief: { ...d.brief, voice: e.target.value as typeof d.brief.voice } }))}>
                {LINKAD_VOICES.map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </Select>
            </Field>
            <Field label="How it is read" htmlFor="v-d" className="md:col-span-2">
              <Input id="v-d" value={doc.brief.voiceDirection} maxLength={160} onChange={(e) => editor.update((d) => ({ ...d, brief: { ...d.brief, voiceDirection: e.target.value } }))} />
            </Field>
            <Field label={`Voice level ${doc.ad.voiceGainDb > 0 ? '+' : ''}${doc.ad.voiceGainDb} dB`} hint="Mixing only — no re-recording.">
              <input type="range" min={-12} max={6} step={1} value={doc.ad.voiceGainDb} onChange={(e) => patchAd({ voiceGainDb: Number(e.target.value) })} aria-label="Voice level" className="w-full accent-[var(--color-accent)]" />
            </Field>
          </div>
          <div className="space-y-3 rounded-xl border border-line p-3">
            <p className="flex items-center gap-2 text-sm font-medium text-fg">
              <Music2 className="size-4 text-accent-2" aria-hidden /> Music (optional)
            </p>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_auto]">
              <Select aria-label="Music from your library" value={doc.ad.music.assetId ?? ''} onChange={(e) => chooseMusic(e.target.value)}>
                <option value="">No music</option>
                {doc.ad.music.assetId && !libraryAudio.data.some((a) => a.id === doc.ad.music.assetId) && <option value={doc.ad.music.assetId}>{doc.ad.music.title || 'Chosen track'}</option>}
                {libraryAudio.data.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.title}
                  </option>
                ))}
              </Select>
              <input ref={fileRef} type="file" accept="audio/*" hidden onChange={(e) => void uploadMusic(e.target.files?.[0]).finally(() => (e.target.value = ''))} />
              <Button onClick={() => fileRef.current?.click()} disabled={p.busy}>
                Upload music
              </Button>
            </div>
            {doc.ad.music.assetId && (
              <>
                <label className="flex items-start gap-2 text-sm text-dim">
                  <input type="checkbox" className="mt-1" checked={doc.ad.music.rightsConfirmed} onChange={(e) => patchAd({ music: { ...doc.ad.music, rightsConfirmed: e.target.checked } })} />
                  <span>I own this music or have a licence to use it in an advert.</span>
                </label>
                <Field label={`Music level ${doc.ad.music.gainDb} dB`}>
                  <input type="range" min={-30} max={-6} step={1} value={doc.ad.music.gainDb} onChange={(e) => patchAd({ music: { ...doc.ad.music, gainDb: Number(e.target.value) } })} aria-label="Music level" className="w-full max-w-sm accent-[var(--color-accent)]" />
                </Field>
              </>
            )}
            <p className="text-[11px] text-faint">Only music you are entitled to use. No music is generated or added for you.</p>
          </div>
        </Panel>

        <Panel title="Captions and brand" sub="Captions are timed from the recorded voice. These choices change only how the video is composed.">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <Field label="Captions">
              <label className="flex items-center gap-2 pt-2 text-sm text-dim">
                <input type="checkbox" checked={doc.ad.captions.enabled} onChange={(e) => patchAd({ captions: { ...doc.ad.captions, enabled: e.target.checked } })} /> Show captions
              </label>
            </Field>
            <Field label="Style" htmlFor="c-s">
              <Select id="c-s" value={doc.ad.captions.preset} onChange={(e) => patchAd({ captions: { ...doc.ad.captions, preset: e.target.value as (typeof CAPTION_PRESETS)[number] } })}>
                <option value="bold">Bold with outline</option>
                <option value="clean">Clean</option>
                <option value="boxed">On a dark box</option>
              </Select>
            </Field>
            <Field label="Colour" htmlFor="c-c">
              <input id="c-c" type="color" value={doc.ad.captions.color} onChange={(e) => patchAd({ captions: { ...doc.ad.captions, color: e.target.value.toUpperCase() } })} className="h-10 w-full cursor-pointer rounded-lg border border-line bg-transparent" />
            </Field>
            <Field label={`Size ${doc.ad.captions.sizePct.toFixed(1)}%`}>
              <input type="range" min={2.4} max={5} step={0.1} value={doc.ad.captions.sizePct} onChange={(e) => patchAd({ captions: { ...doc.ad.captions, sizePct: Number(e.target.value) } })} aria-label="Caption size" className="w-full accent-[var(--color-accent)]" />
            </Field>
            {(['background', 'text', 'accent', 'primary'] as const).map((k) => (
              <Field key={k} label={`Brand: ${k === 'background' ? 'background' : k === 'text' ? 'text' : k === 'accent' ? 'accent' : 'main'}`} htmlFor={`b-${k}`}>
                <input id={`b-${k}`} type="color" value={doc.ad.brand[k]} onChange={(e) => patchAd({ brand: { ...doc.ad.brand, [k]: e.target.value.toUpperCase() } })} className="h-10 w-full cursor-pointer rounded-lg border border-line bg-transparent" />
              </Field>
            ))}
          </div>
        </Panel>

        <Panel title="Voice" sub="Records every scene that has new or changed words, one request per scene, each saved before it is timed.">
          <EstimateBlock state={voiceEst} doc={server} />
          {recording && job && (
            <Notice tone="accent">
              <span className="text-fg">{job.stage}</span>
            </Notice>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" size="lg" icon={<Mic className="size-4" />} disabled={busyJob || p.busy || status.scenesNeedingVoice.length === 0} onClick={() => setVoiceOpen(true)}>
              {status.scenesNeedingVoice.length === 0 ? 'Voice is up to date' : `Make the voice (${status.scenesNeedingVoice.length} scene${status.scenesNeedingVoice.length === 1 ? '' : 's'})`}
            </Button>
            {status.voiceComplete && (
              <Button onClick={() => p.go('export')} icon={<Check className="size-4" />}>
                Continue to export
              </Button>
            )}
          </div>
        </Panel>
      </div>

      {voiceOpen && (
        <Modal
          open
          onOpenChange={(o) => !o && setVoiceOpen(false)}
          title="Record the voice?"
          description={`${status.scenesNeedingVoice.length} scene${status.scenesNeedingVoice.length === 1 ? '' : 's'} will be recorded in ${doc.brief.voice}'s voice. Unchanged scenes are not recorded again.`}
          footer={
            <>
              <Button variant="ghost" onClick={() => setVoiceOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" loading={p.busy} disabled={Boolean(voiceEst.data?.problem)} onClick={() => void record()}>
                Record
              </Button>
            </>
          }
        >
          <EstimateBlock state={voiceEst} doc={server} />
          {(voiceEst.data as { interrupted?: string[] } | null)?.interrupted?.length ? <Notice tone="warning">An earlier recording was interrupted and may already have been charged. Recording again may be charged again.</Notice> : null}
        </Modal>
      )}
      {reviseOpen && (
        <Modal
          open
          onOpenChange={(o) => !o && setReviseOpen(null)}
          title={reviseOpen.scope === 'hook' ? 'Rewrite the hook' : reviseOpen.scope === 'script' ? 'Rewrite the whole script' : 'Rewrite this scene'}
          description="The planner rewrites only the words you chose, from the approved facts. Pictures and the recordings of other scenes stay."
          footer={
            <>
              <Button variant="ghost" onClick={() => setReviseOpen(null)}>
                Cancel
              </Button>
              <Button variant="primary" loading={p.busy} disabled={Boolean((reviseEst.data as { problem?: string | null } | null)?.problem)} onClick={() => void revise()}>
                Rewrite
              </Button>
            </>
          }
        >
          <Field label="What should change? (optional)" htmlFor="rev-g">
            <Input id="rev-g" value={guidance} maxLength={400} onChange={(e) => setGuidance(e.target.value)} placeholder="e.g. warmer, shorter, lead with the breakfast" />
          </Field>
          <EstimateBlock state={reviseEst} doc={server} />
        </Modal>
      )}
      {enhanceFor && (
        <Modal
          open
          onOpenChange={(o) => !o && setEnhanceFor(null)}
          title="Extend this picture with AI?"
          footer={
            <>
              <Button variant="ghost" onClick={() => setEnhanceFor(null)}>
                Cancel
              </Button>
              <Button variant="primary" loading={p.busy} disabled={!enhanceEst.data || Boolean(enhanceEst.data.problem)} onClick={() => void enhance()}>
                Extend for {enhanceEst.data?.estimate ? `≈ $${enhanceEst.data.estimate.usd.toFixed(3)}` : '…'}
              </Button>
            </>
          }
        >
          <p className="text-sm text-dim">Your photo is not wide enough to fill a tall frame sharply. AI can extend its background (sky, wall, floor). It is asked to keep every real object, room, sign and logo unchanged, but it can get this wrong.</p>
          {enhanceEst.data && <CostLine estimate={enhanceEst.data.estimate} capUsd={enhanceEst.data.capUsd} committedUsd={enhanceEst.data.committedUsd} />}
          {enhanceEst.data?.problem && <Notice tone="danger">{enhanceEst.data.problem}</Notice>}
          <Notice tone="warning">The result is marked AI-made. It cannot be exported until you look at it and confirm it still shows the real place or product.</Notice>
          {enhanceEst.error && <Notice tone="warning">{errorMessage(enhanceEst.error)}</Notice>}
        </Modal>
      )}
    </div>
  );
}
