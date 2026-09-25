import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Headphones, Plus, Save, SlidersHorizontal, Trash2 } from 'lucide-react';
import { DEFAULT_MIX, defaultMixTrack, MIX_PRESETS, type MixSettings, type MixTrack, type ProjectDoc } from '@az-studio/shared';
import { errorMessage } from '../../lib/api';
import { deleteContinuity, saveContinuity } from '../../lib/continuity';
import type { WithId } from '../../lib/data';
import { useJobSubmitter } from '../jobs';
import { AssetPicker, useAsset } from '../media';
import { Badge, Button, Card, cx, EmptyState, Field, IconButton, Input, Notice, Select, Slider, Toggle } from '../ui';
import { saveMusicProject, type MusicProject, type MusicVersion } from './create';
import { TransportBar, useAudioTransport } from './transport';

export type AudioTrack = WithId<MixTrack & { musicProjectId: string; order: number }>;

const ROLE_LABEL: Record<MixTrack['role'], string> = { music: 'Music', vocal: 'Vocal', dialogue: 'Dialogue', fx: 'Effects' };

function trackBody(t: AudioTrack): Record<string, unknown> {
  const { id: _id, ...rest } = t as AudioTrack & { createdAt?: unknown; updatedAt?: unknown };
  void _id;
  const { createdAt: _c, updatedAt: _u, ...body } = rest as typeof rest & { createdAt?: unknown; updatedAt?: unknown };
  void [_c, _u];
  return body as Record<string, unknown>;
}

function TrackRow({ t, tracks, onChange, onRemove, onAudition }: { t: AudioTrack; tracks: AudioTrack[]; onChange: (patch: Partial<MixTrack>) => void; onRemove: () => void; onAudition: () => void }) {
  const a = useAsset(t.assetId);
  const [open, setOpen] = useState(false);
  return (
    <li className={cx('space-y-2 rounded-lg border p-2.5', t.mute ? 'border-line opacity-60' : t.solo ? 'border-accent/50' : 'border-line')}>
      <div className="flex flex-wrap items-center gap-2">
        <Input className="h-8 w-40 text-xs" value={t.name} onChange={(e) => onChange({ name: e.target.value.slice(0, 80) })} aria-label="Track name" />
        <Select className="h-8 w-28 text-xs" value={t.role} onChange={(e) => onChange({ role: e.target.value as MixTrack['role'] })} aria-label="Role">
          {(Object.keys(ROLE_LABEL) as MixTrack['role'][]).map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </Select>
        <Badge>{t.kind}</Badge>
        <span className="truncate text-[11px] text-faint">{a.data?.title ?? ''}</span>
        <span className="ml-auto flex items-center gap-1">
          <button type="button" className={cx('cursor-pointer rounded px-1.5 py-0.5 text-[11px] font-semibold', t.mute ? 'bg-warning/30 text-warning' : 'bg-white/5 text-dim')} onClick={() => onChange({ mute: !t.mute })} aria-pressed={t.mute}>
            M
          </button>
          <button type="button" className={cx('cursor-pointer rounded px-1.5 py-0.5 text-[11px] font-semibold', t.solo ? 'bg-accent/40 text-fg' : 'bg-white/5 text-dim')} onClick={() => onChange({ solo: !t.solo })} aria-pressed={t.solo}>
            S
          </button>
          <IconButton size="sm" label="Listen to this track" onClick={onAudition}>
            <Headphones className="size-3.5" />
          </IconButton>
          <IconButton size="sm" label="More settings" onClick={() => setOpen((o) => !o)}>
            <SlidersHorizontal className="size-3.5" />
          </IconButton>
          <IconButton size="sm" label="Remove track" onClick={onRemove}>
            <Trash2 className="size-3.5" />
          </IconButton>
        </span>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Slider label={`Volume ${t.volumeDb > 0 ? '+' : ''}${t.volumeDb.toFixed(1)} dB`} min={-60} max={12} step={0.5} value={t.volumeDb} onChange={(v) => onChange({ volumeDb: v })} />
        <Slider label={`Pan ${t.pan === 0 ? 'centre' : t.pan < 0 ? `${Math.round(-t.pan * 100)}% L` : `${Math.round(t.pan * 100)}% R`}`} min={-1} max={1} step={0.05} value={t.pan} onChange={(v) => onChange({ pan: v })} />
      </div>
      {open && (
        <div className="space-y-3 border-t border-line pt-2">
          <div className="grid grid-cols-3 gap-2">
            <Field label="Start offset (s)">
              <Input type="number" min={0} max={3600} step={0.01} value={t.offsetSec} onChange={(e) => onChange({ offsetSec: Math.max(0, Math.min(3600, Number(e.target.value) || 0)) })} />
            </Field>
            <Field label="Fade in (s)">
              <Input type="number" min={0} max={60} step={0.1} value={t.fadeIn} onChange={(e) => onChange({ fadeIn: Math.max(0, Math.min(60, Number(e.target.value) || 0)) })} />
            </Field>
            <Field label="Fade out (s)">
              <Input type="number" min={0} max={60} step={0.1} value={t.fadeOut} onChange={(e) => onChange({ fadeOut: Math.max(0, Math.min(60, Number(e.target.value) || 0)) })} />
            </Field>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Slider label={`Low ${t.eq.lowDb > 0 ? '+' : ''}${t.eq.lowDb} dB`} min={-15} max={15} step={0.5} value={t.eq.lowDb} onChange={(v) => onChange({ eq: { ...t.eq, lowDb: v } })} />
            <Slider label={`Mid ${t.eq.midDb > 0 ? '+' : ''}${t.eq.midDb} dB`} min={-15} max={15} step={0.5} value={t.eq.midDb} onChange={(v) => onChange({ eq: { ...t.eq, midDb: v } })} />
            <Slider label={`High ${t.eq.highDb > 0 ? '+' : ''}${t.eq.highDb} dB`} min={-15} max={15} step={0.5} value={t.eq.highDb} onChange={(v) => onChange({ eq: { ...t.eq, highDb: v } })} />
          </div>
          <Toggle checked={t.compressor.enabled} onChange={(v) => onChange({ compressor: { ...t.compressor, enabled: v } })} label="Compression" />
          {t.compressor.enabled && (
            <div className="grid grid-cols-2 gap-2">
              <Slider label={`Threshold ${t.compressor.thresholdDb} dB`} min={-60} max={0} step={1} value={t.compressor.thresholdDb} onChange={(v) => onChange({ compressor: { ...t.compressor, thresholdDb: v } })} />
              <Slider label={`Ratio ${t.compressor.ratio.toFixed(1)}:1`} min={1} max={20} step={0.5} value={t.compressor.ratio} onChange={(v) => onChange({ compressor: { ...t.compressor, ratio: v } })} />
            </div>
          )}
          <Toggle checked={t.noiseReduction} onChange={(v) => onChange({ noiseReduction: v })} label="Noise reduction" description="For voice recordings with background hiss or room noise." />
          <Toggle checked={t.duck.enabled} onChange={(v) => onChange({ duck: { ...t.duck, enabled: v, keyTrackId: t.duck.keyTrackId ?? tracks.find((x) => x.id !== t.id && (x.role === 'dialogue' || x.role === 'vocal'))?.id ?? null } })} label="Duck under another track" description="Lowers this track automatically while the key track (dialogue or vocal) is sounding." />
          {t.duck.enabled && (
            <div className="grid grid-cols-2 gap-2">
              <Select value={t.duck.keyTrackId ?? ''} onChange={(e) => onChange({ duck: { ...t.duck, keyTrackId: e.target.value || null } })} aria-label="Key track">
                <option value="">Choose the key track…</option>
                {tracks.filter((x) => x.id !== t.id).map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </Select>
              <Slider label={`Duck ${t.duck.amountDb} dB`} min={0} max={30} step={1} value={t.duck.amountDb} onChange={(v) => onChange({ duck: { ...t.duck, amountDb: v } })} />
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Mix: tracks from versions, stems, recordings and the library with volume, pan, mute/solo, offset,
 * fades, three-band EQ, compression, noise reduction and ducking; master limiter and loudness target
 * with safe presets. The mixdown is rendered with FFmpeg and measured (integrated LUFS, true peak).
 */
export function MixerPanel({ project, mp, versions, tracks }: { project: WithId<ProjectDoc>; mp: MusicProject; versions: MusicVersion[]; tracks: AudioTrack[] }) {
  const [draft, setDraft] = useState<AudioTrack[]>(tracks);
  const [changed, setChanged] = useState<Set<string>>(new Set());
  const [mix, setMix] = useState<MixSettings>({ ...DEFAULT_MIX, ...mp.mix });
  const [mixDirty, setMixDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const [audition, setAudition] = useState<string | null>(null);
  const { submit, busy: submitting, dialog } = useJobSubmitter();
  const t = useAudioTransport(audition);
  useEffect(() => {
    // New tracks (stems finishing, additions) arrive live; unsaved edits of existing tracks are kept.
    setDraft((cur) => tracks.map((x) => (changed.has(x.id) ? cur.find((y) => y.id === x.id) ?? x : x)));
  }, [tracks, changed]);
  const mixdowns = useMemo(() => versions.filter((v) => v.source === 'mixdown'), [versions]);
  const latest = mixdowns[0] ?? null;
  const change = (id: string, patch: Partial<MixTrack>) => {
    setDraft((d) => d.map((x) => (x.id === id ? { ...x, ...patch } : x)));
    setChanged((c) => new Set(c).add(id));
  };
  const addTrack = async (assetId: string, name: string, kind: MixTrack['kind'], role: MixTrack['role']) => {
    setBusy('add');
    try {
      const base = defaultMixTrack('new', name.slice(0, 80) || 'Track', assetId, kind, role);
      const { id: _id, ...fields } = base;
      void _id;
      await saveContinuity(project.id, 'audioTracks', { ...fields, musicProjectId: mp.id, order: draft.length });
    } catch (e) {
      toast.error('Could not add the track', { description: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };
  const saveAll = async (): Promise<boolean> => {
    setBusy('save');
    try {
      for (const tr of draft.filter((x) => changed.has(x.id))) await saveContinuity(project.id, 'audioTracks', trackBody(tr), tr.id);
      if (mixDirty) await saveMusicProject(project.id, mp, { mix });
      setChanged(new Set());
      setMixDirty(false);
      return true;
    } catch (e) {
      toast.error('Could not save the mix', { description: errorMessage(e) });
      return false;
    } finally {
      setBusy(null);
    }
  };
  const applyPreset = (key: string) => {
    const p = MIX_PRESETS[key];
    if (!p) return;
    setDraft((d) => d.map((x) => ({ ...x, ...p.apply(x) })));
    setChanged(new Set(draft.map((x) => x.id)));
    setMix((m) => ({ ...m, ...p.settings, preset: key }));
    setMixDirty(true);
  };
  const render = async () => {
    if ((changed.size || mixDirty) && !(await saveAll())) return;
    const ids = await submit([{ type: 'music.mix', projectId: project.id, musicProjectId: mp.id, label: 'Mixdown' }], { label: 'Mixdown' });
    if (ids) toast.success('Rendering the mixdown', { description: 'It becomes a new version with measured loudness and true peak.' });
  };
  const remove = async (id: string) => {
    try {
      await deleteContinuity(project.id, 'audioTracks', id);
    } catch (e) {
      toast.error('Could not remove the track', { description: errorMessage(e) });
    }
  };
  const peakHot = latest?.loudness?.truePeakDb !== null && latest?.loudness?.truePeakDb !== undefined && latest.loudness.truePeakDb > -1;
  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center gap-2 p-3">
        <Select className="h-9 w-56" value="" onChange={(e) => {
            const v = versions.find((x) => x.id === e.target.value);
            if (v) void addTrack(v.assetId, `v${v.index} ${v.label}`, 'version', 'music');
          }} aria-label="Add a version as a track">
          <option value="">+ Version as a track…</option>
          {versions.map((v) => (
            <option key={v.id} value={v.id}>
              v{v.index} · {v.label}
            </option>
          ))}
        </Select>
        <Button size="sm" variant="ghost" loading={busy === 'add'} icon={<Plus className="size-3.5" />} onClick={() => setPicker(true)}>
          From the library
        </Button>
        <Select className="h-9 w-48" value={mix.preset} onChange={(e) => applyPreset(e.target.value)} aria-label="Mix preset">
          {Object.entries(MIX_PRESETS).map(([k, p]) => (
            <option key={k} value={k}>
              Preset: {p.label}
            </option>
          ))}
        </Select>
        <span className="ml-auto flex items-center gap-2">
          {(changed.size > 0 || mixDirty) && <Badge tone="warning">Unsaved</Badge>}
          <Button size="sm" variant="ghost" loading={busy === 'save'} disabled={!changed.size && !mixDirty} icon={<Save className="size-3.5" />} onClick={() => void saveAll().then((ok) => ok && toast.success('Mix saved'))}>
            Save mix
          </Button>
          <Button size="sm" variant="primary" loading={submitting} disabled={!draft.length} onClick={() => void render()}>
            Render mixdown
          </Button>
        </span>
      </Card>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-2">
          {draft.length === 0 ? (
            <EmptyState icon={<SlidersHorizontal className="size-5" />} title="No tracks yet" body="Add a version, separated stems (Versions → Separate stems), a recording or audio from the library." />
          ) : (
            <ul className="space-y-2">
              {draft.map((tr) => (
                <TrackRow key={tr.id} t={tr} tracks={draft} onChange={(p) => change(tr.id, p)} onRemove={() => void remove(tr.id)} onAudition={() => setAudition(tr.assetId)} />
              ))}
            </ul>
          )}
          {audition && <TransportBar t={t} duration={0} label="Track preview (unprocessed)" />}
        </div>
        <div className="space-y-3">
          <Card className="space-y-3 p-3">
            <p className="eyebrow">Master</p>
            <Toggle checked={mix.limiter} onChange={(v) => {
                setMix((m) => ({ ...m, limiter: v }));
                setMixDirty(true);
              }} label="Limiter" description="Keeps peaks below full scale." />
            <Field label="Loudness target">
              <Select value={mix.targetLufs === null ? '' : String(mix.targetLufs)} onChange={(e) => {
                  setMix((m) => ({ ...m, targetLufs: e.target.value === '' ? null : Number(e.target.value) }));
                  setMixDirty(true);
                }}>
                <option value="">No normalisation</option>
                <option value="-14">−14 LUFS (streaming)</option>
                <option value="-16">−16 LUFS (podcasts, dialogue)</option>
                <option value="-23">−23 LUFS (broadcast)</option>
              </Select>
            </Field>
          </Card>
          <Card className="space-y-2 p-3">
            <p className="eyebrow">Loudness (measured on the last mixdown)</p>
            {latest?.loudness ? (
              <>
                <p className="text-2xl text-fg">
                  {latest.loudness.integratedLufs?.toFixed(1) ?? '—'} <span className="text-sm text-dim">LUFS</span>
                </p>
                <p className={cx('text-xs', peakHot ? 'text-warning' : 'text-dim')}>True peak {latest.loudness.truePeakDb?.toFixed(1) ?? '—'} dBTP{peakHot ? ' — above −1 dBTP: enable the limiter or lower the loudest track' : ''}</p>
                <p className="text-[11px] text-faint">v{latest.index} · {latest.method}</p>
              </>
            ) : (
              <p className="text-xs text-faint">Render a mixdown to measure integrated loudness and true peak (EBU R128). The mixdown is the export preview — it is exactly the file you export.</p>
            )}
          </Card>
          {peakHot && <Notice tone="warning">Peak warning: the last mixdown clips above −1 dBTP.</Notice>}
        </div>
      </div>
      <AssetPicker open={picker} onOpenChange={setPicker} kinds={['audio']} projectId={project.id} onPick={(a) => {
          if (a[0]) void addTrack(a[0].id, a[0].title, 'upload', 'music');
          setPicker(false);
        }} title="Audio to add to the mix" />
      {dialog}
    </div>
  );
}
