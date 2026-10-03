import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Cpu, KeyRound, LogOut, MonitorPlay, RefreshCw, RotateCcw, Save, ShieldCheck } from 'lucide-react';
import { DEFAULT_RETRY_POLICY, formatUsd, RETRY_POLICY_LIMITS, resolveRetryPolicy, type ModelAvailability, type RetryPolicy, type StudioSettings } from '@az-studio/shared';
import { modelStatus } from '../lib/production';
import { api, errorMessage } from '../lib/api';
import { useSession } from '../lib/session';
import { PRESENTER_EVENT, presenterEnabled, setPresenterEnabled } from '../lib/presenter';
import { Badge, Button, Card, Field, Input, Kbd, SectionHeader, Select, Skeleton, Toggle } from '../components/ui';

export default function Settings() {
  const { boot, user, setSettings, signOut } = useSession();
  const [draft, setDraft] = useState<StudioSettings | null>(boot?.settings ? { ...boot.settings, retryPolicy: resolveRetryPolicy(boot.settings.retryPolicy), autoPromptRewrite: boot.settings.autoPromptRewrite ?? true } : null);
  const [saving, setSaving] = useState(false);
  const [availability, setAvailability] = useState<ModelAvailability[] | null>(null);
  const [checking, setChecking] = useState(false);
  const check = async (refresh: boolean) => {
    setChecking(true);
    try {
      setAvailability((await modelStatus(refresh)).models);
    } catch (e) {
      toast.error('Could not check models', { description: errorMessage(e) });
    } finally {
      setChecking(false);
    }
  };
  useEffect(() => {
    void check(false);
  }, []);
  if (!boot || !draft) return <Skeleton className="h-96" />;
  const caps = boot.capabilities;
  const set = <K extends keyof StudioSettings>(k: K, v: StudioSettings[K]) => setDraft({ ...draft, [k]: v });
  const num = (v: string) => (v === '' ? 0 : Number(v));
  const save = async () => {
    setSaving(true);
    try {
      const r = await api<{ settings: StudioSettings }, 'updateSettings'>('updateSettings', draft);
      setSettings(r.settings);
      toast.success('Settings saved');
    } catch (e) {
      toast.error('Could not save', { description: errorMessage(e) });
    } finally {
      setSaving(false);
    }
  };
  const models = [
    { key: 'video', role: 'Video generation, conversational editing & scene repairs', cap: caps.video.displayName, id: caps.video.modelId, stage: caps.video.launchStage },
    { key: 'image', role: 'Images & image editing', cap: caps.image.displayName, id: caps.image.modelId, stage: caps.image.launchStage },
    { key: 'reasoning', role: 'Screenplay, planning, lyrics, cue sheets & scene inspection', cap: caps.reasoning.displayName, id: caps.reasoning.modelId, stage: caps.reasoning.launchStage },
    { key: 'transcription', role: 'Word-timed dialogue checks & lyric sync', cap: caps.transcription.displayName, id: caps.transcription.modelId, stage: caps.transcription.launchStage },
    { key: 'speech', role: 'Dialogue guide audio (line lengths)', cap: caps.speech.displayName, id: caps.speech.modelId, stage: caps.speech.launchStage },
    { key: 'music', role: 'Songs with lyrics & film score', cap: caps.music.displayName, id: caps.music.modelId, stage: caps.music.launchStage },
  ];

  return (
    <div className="space-y-8">
      <SectionHeader eyebrow="Studio" title={<span className="text-5xl">Settings</span>} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card className="space-y-5 p-6">
          <div>
            <p className="eyebrow">Cost controls</p>
            <p className="mt-1 text-sm text-dim">Enforced server-side on every submission (projected spend includes jobs still running).</p>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Daily limit (USD)" hint={<span data-private>Today so far ≈ {formatUsd(boot.spend.today.costUsd)}</span>}>
              <Input type="number" min={0} step={1} value={draft.dailyLimitUsd} onChange={(e) => set('dailyLimitUsd', num(e.target.value))} />
            </Field>
            <Field label="Monthly limit (USD)" hint={<span data-private>This month ≈ {formatUsd(boot.spend.month.costUsd)}</span>}>
              <Input type="number" min={0} step={5} value={draft.monthlyLimitUsd} onChange={(e) => set('monthlyLimitUsd', num(e.target.value))} />
            </Field>
            <Field label="Confirm batches above (USD)" hint="Batches with two or more videos always ask first.">
              <Input type="number" min={0} step={0.5} value={draft.confirmAboveUsd} onChange={(e) => set('confirmAboveUsd', num(e.target.value))} />
            </Field>
            <Field label="Max concurrent generations" hint="Extra jobs wait in the queue.">
              <Input type="number" min={1} max={8} value={draft.maxConcurrentGenerations} onChange={(e) => set('maxConcurrentGenerations', Math.round(num(e.target.value)))} />
            </Field>
            <Field label="Max jobs per batch">
              <Input type="number" min={1} max={100} value={draft.maxBatchSize} onChange={(e) => set('maxBatchSize', Math.round(num(e.target.value)))} />
            </Field>
            <Field label="Default video resolution">
              <Select value={draft.defaultVideoResolution} onChange={(e) => set('defaultVideoResolution', e.target.value)}>
                {caps.video.resolutions.map((r) => (
                  <option key={r} value={r}>
                    {r.toUpperCase()}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Default image size">
              <Select value={draft.defaultImageSize} onChange={(e) => set('defaultImageSize', e.target.value)}>
                {caps.image.imageSizes.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Button variant="primary" loading={saving} onClick={() => void save()} icon={<Save className="size-4" />}>
            Save settings
          </Button>
        </Card>
        <RetryCard draft={draft} onChange={(retryPolicy, autoPromptRewrite) => setDraft({ ...draft, retryPolicy, autoPromptRewrite })} onSave={() => void save()} saving={saving} />
        <div className="space-y-6">
          <PresenterCard />
          <Card className="space-y-4 p-6">
            <p className="eyebrow flex items-center gap-1.5">
              <Cpu className="size-3.5" /> Model registry (server-side)
            </p>
            <ul className="space-y-3">
              {models.map((m) => {
                const a = availability?.find((x) => x.role === m.key);
                return (
                  <li key={m.key} className="rounded-xl border border-line p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm text-fg">{m.cap}</p>
                      <div className="flex gap-1.5">
                        {a && <Badge tone={a.status === 'available' ? 'success' : a.status === 'unavailable' ? 'danger' : 'neutral'}>{a.status === 'available' ? 'Available' : a.status === 'unavailable' ? 'Not available' : 'Unknown'}</Badge>}
                        <Badge tone={m.stage === 'ga' ? 'success' : 'warning'}>{m.stage === 'ga' ? 'GA' : 'Preview'}</Badge>
                      </div>
                    </div>
                    <p className="timecode mt-1 text-xs text-accent-2">{m.id}</p>
                    <p className="mt-0.5 text-xs text-faint">{m.role}</p>
                    {a && a.status !== 'available' && <p className="mt-1 text-xs text-[#ff9b9b]">{a.detail}</p>}
                  </li>
                );
              })}
            </ul>
            <Button size="sm" variant="ghost" loading={checking} icon={<RefreshCw className="size-3.5" />} onClick={() => void check(true)}>
              Check availability now
            </Button>
            <p className="text-xs text-faint">
              Vertex AI location <span className="timecode">{caps.vertexLocation}</span> · functions in <span className="timecode">{caps.region}</span>
              {caps.reasoning.fallbackModelId ? ` · text fallback ${caps.reasoning.fallbackModelId} (used only if the preview model is retired)` : ''}.
            </p>
          </Card>
          <Card className="space-y-2 p-6">
            <p className="eyebrow">Pricing source</p>
            <p className="text-sm text-dim">
              Google Vertex AI list prices, version <span className="timecode text-fg">{boot.pricing.version}</span>, retrieved {boot.pricing.retrievedAt}.
            </p>
            <a href={boot.pricing.source} target="_blank" rel="noreferrer" className="text-xs text-accent-2 hover:underline">
              {boot.pricing.source}
            </a>
          </Card>
          <Card className="space-y-3 p-6">
            <p className="eyebrow flex items-center gap-1.5">
              <ShieldCheck className="size-3.5" /> Access
            </p>
            <p className="text-sm text-dim">
              Signed in as <span className="text-fg" data-private>{user?.email}</span>. Only the configured owner can read or write studio data; App Check protects the API.
            </p>
            <Button onClick={() => void signOut()} icon={<LogOut className="size-4" />}>
              Sign out
            </Button>
          </Card>
        </div>
      </div>
    </div>
  );
}

const RETRY_FIELDS: { key: keyof RetryPolicy; label: string; hint: string }[] = [
  { key: 'transientAttempts', label: 'Attempts for temporary failures', hint: 'Including the first request (timeouts, rate limits, 503).' },
  { key: 'baseDelaySec', label: 'First wait (s)', hint: 'Doubles each retry, with jitter; never shorter than Google asks.' },
  { key: 'maxDelaySec', label: 'Longest wait (s)', hint: 'Upper bound between two automatic attempts.' },
  { key: 'maxRetryAfterSec', label: 'Stop if Google asks to wait longer than (s)', hint: 'Then the job stops and you retry later.' },
  { key: 'pollFailures', label: 'Failed status checks before pausing', hint: 'An accepted job is never resubmitted; it can be resumed.' },
  { key: 'pollMaxWaitMinutes', label: 'Keep checking an accepted job for (min)', hint: 'Then AZ Studio stops checking (resumable, nothing cancelled).' },
];

function RetryCard({ draft, onChange, onSave, saving }: { draft: StudioSettings; onChange: (p: RetryPolicy, autoPromptRewrite: boolean) => void; onSave: () => void; saving: boolean }) {
  const boot = useSession((s) => s.boot);
  const refresh = useSession((s) => s.refresh);
  const p = resolveRetryPolicy(draft.retryPolicy);
  const set = (k: keyof RetryPolicy, v: number) => onChange({ ...p, [k]: v }, draft.autoPromptRewrite);
  const blocks = (boot?.providerBlocks ?? []).filter((b) => b.until > Date.now());
  const clear = async () => {
    try {
      await api('providerHealth', { clear: ['*'] });
      await refresh();
      toast.success('Automatic generation resumed');
    } catch (e) {
      toast.error('Could not resume', { description: errorMessage(e) });
    }
  };
  return (
    <Card className="space-y-5 p-6 lg:col-start-1">
      <div>
        <p className="eyebrow">Generation retries</p>
        <p className="mt-1 text-sm text-dim">How AZ Studio recovers when a Google request fails. Limits are never nested: one job sends at most {p.transientAttempts + p.promptRewrites + p.configRepairs} requests.</p>
      </div>
      {blocks.length > 0 && (
        <div className="rounded-xl border border-violet/30 bg-violet/[0.06] p-3 text-xs text-dim">
          <p className="flex items-center gap-1.5 text-fg">
            <KeyRound className="size-3.5" /> Automatic generation is paused
          </p>
          {blocks.map((b) => (
            <p key={b.key} className="mt-1">
              {b.message} {b.action ? `— ${b.action}` : ''} (until {new Date(b.until).toLocaleString()})
            </p>
          ))}
          <Button size="sm" variant="secondary" className="mt-2" onClick={() => void clear()}>
            It’s fixed — resume
          </Button>
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {RETRY_FIELDS.map((f) => (
          <Field key={f.key} label={f.label} hint={f.hint}>
            <Input type="number" min={RETRY_POLICY_LIMITS[f.key].min} max={RETRY_POLICY_LIMITS[f.key].max} value={p[f.key]} onChange={(e) => set(f.key, Number(e.target.value))} />
          </Field>
        ))}
      </div>
      <Toggle checked={draft.autoPromptRewrite && p.promptRewrites > 0} onChange={(v) => onChange({ ...p, promptRewrites: v ? 1 : 0 }, v)} label="One automatic rewrite of a blocked prompt" description="Removes accidental ambiguity and keeps the creative intent; never coded language, never weaker restrictions. Both versions stay in the job history; a second block waits for you." />
      <Toggle checked={p.configRepairs > 0} onChange={(v) => set('configRepairs', v ? 1 : 0)} label="One repaired resubmission of an invalid configuration" description="Only for values established by the model registry or a verified Google rule; an unchanged invalid request is never resent." />
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" loading={saving} onClick={onSave} icon={<Save className="size-4" />}>
          Save settings
        </Button>
        <Button variant="ghost" icon={<RotateCcw className="size-4" />} onClick={() => onChange({ ...DEFAULT_RETRY_POLICY }, true)}>
          Recommended values
        </Button>
      </div>
    </Card>
  );
}

function PresenterCard() {
  const [on, setOn] = useState(presenterEnabled);
  useEffect(() => {
    const sync = () => setOn(presenterEnabled());
    window.addEventListener(PRESENTER_EVENT, sync);
    return () => window.removeEventListener(PRESENTER_EVENT, sync);
  }, []);
  return (
    <Card className="space-y-4 p-6">
      <p className="eyebrow flex items-center gap-1.5">
        <MonitorPlay className="size-3.5" /> Presenter mode
      </p>
      <Toggle checked={on} onChange={setPresenterEnabled} label="Record tutorials and demos" description="Shows a smooth cursor with click highlights, and blurs your email, recorded spend and any project, media or job created before you switched it on. Saved on this device only." />
      <ul className="space-y-1.5 text-xs text-dim">
        <li>
          <Kbd>Alt</Kbd> + <Kbd>Shift</Kbd> + <Kbd>Z</Kbd> zoom toward the cursor · <Kbd>Alt</Kbd> + <Kbd>Shift</Kbd> + <Kbd>X</Kbd> or <Kbd>Esc</Kbd> zoom out
        </li>
        <li>
          <Kbd>Alt</Kbd> + <Kbd>Shift</Kbd> + <Kbd>F</Kbd> full screen · <Kbd>Alt</Kbd> + <Kbd>Shift</Kbd> + <Kbd>P</Kbd> presenter mode on or off
        </li>
      </ul>
    </Card>
  );
}
