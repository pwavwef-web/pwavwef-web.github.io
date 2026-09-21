import { useState } from 'react';
import { toast } from 'sonner';
import { Cpu, LogOut, Save, ShieldCheck } from 'lucide-react';
import { formatUsd, type StudioSettings } from '@az-studio/shared';
import { api, errorMessage } from '../lib/api';
import { useSession } from '../lib/session';
import { Badge, Button, Card, Field, Input, SectionHeader, Select, Skeleton } from '../components/ui';

export default function Settings() {
  const { boot, user, setSettings, signOut } = useSession();
  const [draft, setDraft] = useState<StudioSettings | null>(boot?.settings ?? null);
  const [saving, setSaving] = useState(false);
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
    { role: 'Video generation & conversational editing', cap: caps.video.displayName, id: caps.video.modelId, stage: caps.video.launchStage },
    { role: 'Images & image editing', cap: caps.image.displayName, id: caps.image.modelId, stage: caps.image.launchStage },
    { role: 'Screenplay, planning & song analysis', cap: caps.reasoning.displayName, id: caps.reasoning.modelId, stage: caps.reasoning.launchStage },
  ];

  return (
    <div className="space-y-8">
      <SectionHeader eyebrow="Studio" title={<span className="text-5xl">Settings</span>} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="space-y-5 p-6">
          <div>
            <p className="eyebrow">Cost controls</p>
            <p className="mt-1 text-sm text-dim">Enforced server-side on every submission (projected spend includes jobs still running).</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Daily limit (USD)" hint={`Today so far ≈ ${formatUsd(boot.spend.today.costUsd)}`}>
              <Input type="number" min={0} step={1} value={draft.dailyLimitUsd} onChange={(e) => set('dailyLimitUsd', num(e.target.value))} />
            </Field>
            <Field label="Monthly limit (USD)" hint={`This month ≈ ${formatUsd(boot.spend.month.costUsd)}`}>
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
        <div className="space-y-6">
          <Card className="space-y-4 p-6">
            <p className="eyebrow flex items-center gap-1.5">
              <Cpu className="size-3.5" /> Model registry (server-side)
            </p>
            <ul className="space-y-3">
              {models.map((m) => (
                <li key={m.id} className="rounded-xl border border-line p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm text-fg">{m.cap}</p>
                    <Badge tone={m.stage === 'ga' ? 'success' : 'warning'}>{m.stage === 'ga' ? 'GA' : 'Preview'}</Badge>
                  </div>
                  <p className="timecode mt-1 text-xs text-accent-2">{m.id}</p>
                  <p className="mt-0.5 text-xs text-faint">{m.role}</p>
                </li>
              ))}
            </ul>
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
              Signed in as <span className="text-fg">{user?.email}</span>. Only the configured owner can read or write studio data; App Check protects the API.
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
