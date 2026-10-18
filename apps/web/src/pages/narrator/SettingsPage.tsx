import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AudioLines, CircleAlert, CircleCheck, RefreshCw, Search, Trash2 } from 'lucide-react';
import { DELIVERY_PRESETS, DELIVERY_PRESET_IDS, NOISE_REDUCTION_LABELS, NOISE_REDUCTION_LEVELS, PAUSE_LIMITS, ROUTE_LABELS, loudnessTarget, type NarratorPauses, type NarratorRoute, type NarratorSettings } from '@az-studio/shared';
import { errorMessage } from '../../lib/api';
import { nar, newRequestId, type CloudTest } from '../../lib/narrator';
import { Badge, Button, ConfirmDialog, Field, Input, Notice, Segmented, Select, Skeleton, Textarea, Toggle } from '../../components/ui';
import { useNarrator } from './NarratorShell';

const PAUSE_LABELS: Record<keyof NarratorPauses, string> = {
  afterOpeningSec: 'After the opening',
  afterHeadingSec: 'After a heading',
  betweenParagraphsSec: 'Between paragraphs',
  betweenSectionsSec: 'Between sections',
  beforeClosingSec: 'Before the closing',
};

interface Reconcile {
  remote: number;
  recovered: string[];
  unlinked: { providerVoiceId: string; route?: NarratorRoute; displayName: string | null; createTime: string | null }[];
  problems?: { route: NarratorRoute; message: string }[];
}

export default function SettingsPage() {
  const { status, statusError, reloadStatus, setStatus } = useNarrator();
  const [draft, setDraft] = useState<NarratorSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [rec, setRec] = useState<Reconcile | null>(null);
  const [orphan, setOrphan] = useState<{ id: string; route: NarratorRoute } | null>(null);
  const [testing, setTesting] = useState(false);
  const [testAudio, setTestAudio] = useState<string | null>(null);
  useEffect(() => {
    if (status && !draft) setDraft(status.settings);
  }, [status, draft]);

  if (statusError) return <Notice tone="danger">Settings could not be loaded: {errorMessage(statusError)}</Notice>;
  if (!status || !draft) return <Skeleton className="h-96" />;
  const p = status.provider;
  const dirty = JSON.stringify(draft) !== JSON.stringify(status.settings);
  const set = (patch: Partial<NarratorSettings>) => setDraft({ ...draft, ...patch });
  const target = loudnessTarget(draft);

  const save = async () => {
    setSaving(true);
    try {
      const r = await nar<{ settings: NarratorSettings }>('profileSave', { settings: draft });
      setStatus({ ...status, settings: r.settings });
      setDraft(r.settings);
      toast.success('Settings saved.');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const test: CloudTest | null = status.routes?.cloudTest ?? null;
  const cloudOk = Boolean(test?.ok);
  const allowance = status.routes?.allowance ?? [];

  const cloudTest = async () => {
    setTesting(true);
    try {
      const r = await nar<CloudTest & { url: string | null }>('cloudCheck', { requestId: newRequestId('cloud') });
      setStatus({ ...status, routes: { allowance, cloudTest: r } });
      setTestAudio(r.url);
      if (r.ok) toast.success('Google Cloud narration works. You can now choose it as the speech service.');
      else toast.error(r.message ?? 'The Cloud narration test failed.');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setTesting(false);
    }
  };

  const reconcile = async () => {
    setChecking(true);
    try {
      const r = await nar<Reconcile>('voiceReconcile');
      setRec(r);
      if (r.recovered.length) toast.success('A voice whose creation was interrupted was found at Google and linked.');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setChecking(false);
    }
  };

  const deleteOrphan = async () => {
    if (!orphan) return;
    try {
      await nar('providerVoiceDelete', { providerVoiceId: orphan.id, route: orphan.route, confirm: true });
      toast.success('Deleted at Google.');
      setRec(rec ? { ...rec, unlinked: rec.unlinked.filter((u) => u.providerVoiceId !== orphan.id) } : rec);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setOrphan(null);
    }
  };

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-10">
        <section className="space-y-5" aria-labelledby="gen">
          <h2 id="gen" className="display text-[28px] text-fg">
            Narration
          </h2>
          <Field label="Speech service" hint="Where new voices are created and spoken. Existing voices keep the service they were made on; switching an edition to a voice on another service re-narrates the whole edition.">
            <Segmented
              label="Speech service"
              value={draft.route}
              onChange={(v) => set({ route: v })}
              options={[
                { value: 'developer', label: ROUTE_LABELS.developer },
                { value: 'vertex', label: ROUTE_LABELS.vertex, disabled: !cloudOk && status.settings.route !== 'vertex', title: cloudOk ? undefined : 'Run the Cloud narration test first' },
              ]}
            />
          </Field>
          <div className="space-y-2 rounded-2xl border border-line px-5 py-4 text-[13px] text-dim">
            {allowance.map((a) => (
              <p key={a.modelId}>
                Developer API · {a.modelId}: <span className="text-fg">{a.remaining === 0 ? `used up (${a.limit} per day)` : `${a.used} of ${a.limit}`}</span> requests today (resets {new Date(a.resetAt).toLocaleString()}). Each passage part is one request.
              </p>
            ))}
            <p>
              Google Cloud uses the functions’ service account (no API key) and pay-as-you-go quota with no fixed daily cap. Voices do not move between the two services: a Cloud voice needs a new consent recording of the Google Cloud sentence (your reference recording can be reused while it is kept).
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button size="sm" variant="secondary" icon={<AudioLines className="size-3.5" />} loading={testing} onClick={() => void cloudTest()}>
                Run Cloud narration test
              </Button>
              {test && (
                <Badge tone={test.ok ? 'success' : 'danger'} icon={test.ok ? <CircleCheck className="size-3" /> : <CircleAlert className="size-3" />}>
                  {test.ok ? `Passed ${new Date(test.at).toLocaleString()} · ${test.durationSec?.toFixed(1)} s of speech` : 'Failed'}
                </Badge>
              )}
            </div>
            {test && !test.ok && test.message && <p className="text-[#ff9b9b]">{test.message}</p>}
            {testAudio && <audio controls src={testAudio} className="w-full max-w-md" />}
            <p className="text-faint">Two short sentences in a prebuilt voice, each with its own delivery style (well under one cent). The Developer API stays in use until this passes.</p>
          </div>
          <Field label="Voice model" hint="Both models support voice replication. A voice is used with the model it was created with; this choice applies to new voices.">
            <Select value={draft.modelId ?? status.model.id} onChange={(e) => set({ modelId: e.target.value })} className="max-w-sm">
              {status.model.allowed.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName} ({m.id})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Generation budget (USD)" hint="The most a single generation request (full edition, section or test) may be estimated to cost. Studio-wide daily and monthly limits still apply.">
            <Input type="number" min={0.05} max={50} step={0.05} value={draft.generationBudgetUsd} onChange={(e) => set({ generationBudgetUsd: Math.max(0.05, Number(e.target.value) || 0.05) })} className="max-w-40" />
          </Field>
          <Field label="Default delivery">
            <Segmented label="Default delivery" value={draft.defaultPreset} onChange={(v) => set({ defaultPreset: v })} options={DELIVERY_PRESET_IDS.map((id) => ({ value: id, label: DELIVERY_PRESETS[id].label }))} />
          </Field>
          <Field label="Default opening" hint="[Article title] is replaced with the title. An opening already in the article is used instead.">
            <Textarea rows={2} value={draft.openingTemplate} onChange={(e) => set({ openingTemplate: e.target.value })} />
          </Field>
          <Toggle checked={draft.includeClosing} onChange={(v) => set({ includeClosing: v })} label="Add the closing to new editions" />
          <Field label="Default closing">
            <Textarea rows={2} value={draft.closingText} onChange={(e) => set({ closingText: e.target.value })} />
          </Field>
        </section>

        <details className="group rounded-2xl border border-line px-5 py-4">
          <summary className="cursor-pointer text-sm font-medium text-dim group-open:text-fg">Audio and pauses</summary>
          <div className="mt-5 space-y-5">
            <Field label="Channels">
              <Segmented label="Channels" value={String(draft.channels)} onChange={(v) => set({ channels: v === '2' ? 2 : 1 })} options={[{ value: '1', label: 'Mono' }, { value: '2', label: 'Stereo (dual mono)' }]} />
            </Field>
            <Field
              label="Background noise reduction"
              hint={
                draft.noiseReduction === 'off'
                  ? 'Your voice’s takes are kept exactly as Google returned them.'
                  : `A replicated voice copies the room it was recorded in, and export loudness makes that hiss and rumble audible. ${draft.noiseReduction === 'strong' ? 'Strong also softens the gaps between phrases.' : 'Standard removes low rumble and steady hiss without touching the voice.'} Applied to new takes, to older takes when you export, and to your recordings when a voice is created. Google voices are never processed.`
              }
            >
              <Segmented label="Background noise reduction" value={draft.noiseReduction} onChange={(v) => set({ noiseReduction: v })} options={NOISE_REDUCTION_LEVELS.map((l) => ({ value: l, label: NOISE_REDUCTION_LABELS[l] }))} />
            </Field>
            <Field label="Loudness target" hint={`Exports are normalised to ${target.integratedLufs} LUFS with a ${target.truePeakDbtp} dBTP true-peak ceiling, then measured.`}>
              <Segmented label="Loudness target" value={draft.loudness} onChange={(v) => set({ loudness: v })} options={[{ value: 'podcast', label: 'Spoken word (−16 stereo / −19 mono)' }, { value: 'streaming', label: 'Louder streaming (−14 / −17)' }]} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              {(Object.keys(PAUSE_LABELS) as (keyof NarratorPauses)[]).map((k) => (
                <Field key={k} label={`${PAUSE_LABELS[k]} (s)`}>
                  <Input type="number" min={PAUSE_LIMITS.min} max={PAUSE_LIMITS.max} step={0.05} value={draft.pauses[k]} onChange={(e) => set({ pauses: { ...draft.pauses, [k]: Math.min(PAUSE_LIMITS.max, Math.max(PAUSE_LIMITS.min, Number(e.target.value) || PAUSE_LIMITS.min)) } })} />
                </Field>
              ))}
            </div>
          </div>
        </details>

        <Button variant="primary" disabled={!dirty} loading={saving} onClick={() => void save()}>
          Save settings
        </Button>
      </div>

      <aside className="space-y-6 text-[13px] leading-relaxed text-dim lg:border-l lg:border-line lg:pl-6">
        <section className="space-y-3" aria-labelledby="provider">
          <div className="flex items-center justify-between gap-2">
            <h2 id="provider" className="eyebrow">
              Provider
            </h2>
            <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} onClick={() => void reloadStatus(true)}>
              Check now
            </Button>
          </div>
          <p className="text-fg">Gemini Developer API · voice replication</p>
          {p.configured ? (
            <Badge tone={p.voicesApi.available ? 'success' : 'danger'} icon={p.voicesApi.available ? <CircleCheck className="size-3" /> : <CircleAlert className="size-3" />}>
              {p.voicesApi.available ? 'Voices API reachable' : 'Voices API not reachable'}
            </Badge>
          ) : (
            <Badge tone="warning">Not configured</Badge>
          )}
          {p.message && <p className="text-warning">{p.message}</p>}
          <ul className="space-y-1">
            {p.models.map((m) => (
              <li key={m.id}>
                <span className={m.available ? 'text-success' : 'text-[#ff9b9b]'}>{m.available ? '●' : '○'}</span> {m.displayName}
                {m.inputTokenLimit ? <span className="text-faint"> · {m.inputTokenLimit.toLocaleString()} in / {m.outputTokenLimit?.toLocaleString()} out tokens</span> : null}
                {m.message && <span className="block text-faint">{m.message}</span>}
              </li>
            ))}
          </ul>
          {p.cloud && (
            <div className="space-y-1 border-t border-line pt-3">
              <p className="text-fg">Google Cloud (Vertex AI) · service account</p>
              <Badge tone={p.cloud.voicesApi.available ? 'success' : 'warning'} icon={p.cloud.voicesApi.available ? <CircleCheck className="size-3" /> : <CircleAlert className="size-3" />}>
                {p.cloud.voicesApi.available ? `Voices API reachable · ${p.cloud.voicesApi.replicatedVoices ?? 0} replicated` : 'Voices API not confirmed'}
              </Badge>
              {p.cloud.message && <p className="text-warning">{p.cloud.message}</p>}
              <ul className="space-y-1">
                {p.cloud.models.map((m) => (
                  <li key={m.id}>
                    <span className={m.available ? 'text-success' : 'text-[#ff9b9b]'}>{m.available ? '●' : '○'}</span> {m.displayName}
                    {m.message && <span className="block text-faint">{m.message}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-faint">Checked {new Date(p.checkedAt).toLocaleString()}. The key and credentials stay on the server.</p>
        </section>
        <section className="space-y-2">
          <h2 className="eyebrow">Prices used for estimates</h2>
          <p>
            {status.rates.modelId}: ${status.rates.inputPerM.toFixed(2)} per 1M text tokens in, ${status.rates.outputPerM.toFixed(2)} per 1M audio tokens out ({status.rates.audioTokensPerSecond} tokens = 1 s of audio) — {status.rates.validNote}
          </p>
          <p>{status.voiceCreationCost}</p>
          <p className="text-faint">
            <a className="hover:underline" href={status.rates.source} target="_blank" rel="noreferrer">
              Source
            </a>
            , retrieved {status.rates.retrievedAt}.
          </p>
        </section>
        <section className="space-y-2">
          <h2 className="eyebrow">Voices stored at Google</h2>
          <p>Finds voices in the project that no profile here uses — for example after an interrupted creation.</p>
          <Button size="sm" variant="secondary" icon={<Search className="size-3.5" />} loading={checking} disabled={!p.configured} onClick={() => void reconcile()}>
            Check Google for voices
          </Button>
          {rec && (
            <div className="space-y-2">
              <p>
                {rec.remote} replicated voice{rec.remote === 1 ? '' : 's'} at Google · {rec.unlinked.length} not linked here.
              </p>
              {rec.unlinked.map((u) => (
                <div key={u.providerVoiceId} className="flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-2">
                  <span className="min-w-0 truncate">
                    {u.displayName ?? 'Unnamed'} <span className="text-faint">· {ROUTE_LABELS[u.route ?? 'developer']}</span> {u.createTime ? <span className="text-faint">· {new Date(u.createTime).toLocaleString()}</span> : null}
                  </span>
                  <Button size="sm" variant="ghost" aria-label="Delete at Google" onClick={() => setOrphan({ id: u.providerVoiceId, route: u.route ?? 'developer' })}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </section>
        <section className="space-y-2">
          <h2 className="eyebrow">Privacy and retention</h2>
          <p>Recordings, takes and exports are private to your account and played through links that expire after 15 minutes.</p>
          <p>Consent recordings are deleted as soon as Google accepts them; reference recordings {status.retention.referenceAfterCreateDays} days after the voice is created; unused recordings after {status.retention.unusedRecordingDays} days.</p>
        </section>
      </aside>
      <ConfirmDialog open={Boolean(orphan)} onOpenChange={(o) => !o && setOrphan(null)} danger title="Delete this voice at Google?" confirmLabel="Delete at Google" onConfirm={() => void deleteOrphan()} body="It is not linked to any profile here. Deleting it removes the stored voice from the Google project; nothing in AZ Studio changes." />
    </div>
  );
}
