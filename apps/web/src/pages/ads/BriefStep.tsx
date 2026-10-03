import { toast } from 'sonner';
import { ArrowRight, AudioLines, FileText, Wand2 } from 'lucide-react';
import { AD_DURATION, type AdBrief } from '@az-studio/shared';
import { useAiRun } from '../../lib/ai';
import { Button, Card, Field, Input, Notice, Segmented, Slider, Textarea } from '../../components/ui';
import type { StepProps } from './AdStudio';

const FIELDS: { key: keyof AdBrief; label: string; hint?: string; rows?: number; placeholder?: string }[] = [
  { key: 'brand', label: 'Brand', placeholder: 'Indigen World' },
  { key: 'product', label: 'Product or service', placeholder: 'A place to learn, hear and share indigenous languages', rows: 2 },
  { key: 'audience', label: 'Audience', placeholder: 'Kasem speakers and learners, families in the diaspora', rows: 2 },
  { key: 'objective', label: 'Objective', placeholder: 'Introduce the platform and invite people to take part', rows: 2 },
  { key: 'keyMessage', label: 'Key message', placeholder: 'Make more room for our languages in everyday life', rows: 2 },
  { key: 'tone', label: 'Tone', placeholder: 'Warm, contemporary, grounded, human' },
  { key: 'callToAction', label: 'Call to action', placeholder: 'Discover Indigen World' },
  { key: 'destinationUrl', label: 'Destination URL', placeholder: 'https://indigenworld.com' },
];

export function BriefStep({ project, ad, update, go }: StepProps) {
  const ai = useAiRun(project.id);
  const set = <K extends keyof AdBrief>(k: K, v: AdBrief[K]) => update((a) => ({ ...a, brief: { ...a.brief, [k]: v } }));
  const writeScript = async () => {
    const out = await ai.run<{ lines: string[]; tagline: string; notes: string }>('ad.script', { brief: ad.brief, durationSec: ad.brief.durationSec, assets: ad.assets.map((a) => ({ role: a.role, label: a.label })) }, 'Advert script');
    if (!out?.lines?.length) return;
    update((a) => ({ ...a, brief: { ...a.brief, tagline: a.brief.tagline || out.tagline || '' }, audio: { ...a.audio, referenceScript: out.lines.join('\n') } }));
    toast.success('Script written', { description: out.notes ? out.notes.slice(0, 200) : 'Review it under Audio & assets, then record, upload or generate the voice-over.' });
  };
  return (
    <div className="space-y-5">
      <Card className="space-y-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="eyebrow">How this advert starts</p>
          <Segmented
            label="Advert mode"
            value={ad.mode}
            onChange={(mode) => update({ mode })}
            options={[
              { value: 'audio_first', label: <span className="inline-flex items-center gap-1.5"><AudioLines className="size-3.5" /> Audio-first</span> },
              { value: 'brief_first', label: <span className="inline-flex items-center gap-1.5"><FileText className="size-3.5" /> Brief-first</span> },
            ]}
          />
        </div>
        <p className="text-sm text-dim">
          {ad.mode === 'audio_first'
            ? 'The approved narration or finished soundtrack is the timeline authority: its measured length sets the advert’s length, its word timing sets captions and cuts. It is never re-timed, regenerated or cut.'
            : 'Describe the product and the message; AZ Studio drafts the voice-over script. Record or upload the voice-over (or generate a guide voice-over) under Audio & assets.'}
        </p>
      </Card>
      <Card className="space-y-4 p-5">
        <p className="eyebrow">Brief</p>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {FIELDS.map((f) => (
            <Field key={f.key} label={f.label} hint={f.hint}>
              {f.rows ? <Textarea rows={f.rows} value={String(ad.brief[f.key] ?? '')} placeholder={f.placeholder} onChange={(e) => set(f.key, e.target.value as never)} /> : <Input value={String(ad.brief[f.key] ?? '')} placeholder={f.placeholder} onChange={(e) => set(f.key, e.target.value as never)} />}
            </Field>
          ))}
        </div>
        <Field label={`Desired duration · ${ad.brief.durationSec} s`} hint={ad.mode === 'audio_first' ? 'For audio-first adverts the measured audio decides the length; this is only a target.' : `Between ${AD_DURATION.min} and ${AD_DURATION.max} seconds.`}>
          <Slider label="Desired duration" min={AD_DURATION.min} max={AD_DURATION.max} step={1} value={ad.brief.durationSec} onChange={(v) => set('durationSec', v)} />
        </Field>
      </Card>
      <Card className="space-y-4 p-5">
        <p className="eyebrow">Look and on-screen text</p>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Early on-screen line" hint="Shown within the first seconds, composed in the edit (e.g. “Starting with Kasem”).">
            <Input value={ad.brief.tagline} onChange={(e) => set('tagline', e.target.value)} placeholder="Starting with Kasem" />
          </Field>
          <Field label="Must avoid" hint="Added to every generated scene.">
            <Input value={ad.brief.mustAvoid} onChange={(e) => set('mustAvoid', e.target.value)} placeholder="Generic corporate stock imagery, excessive transitions" />
          </Field>
        </div>
        <Field label="Visual direction" hint="Carried into every generated scene; text and logos are always composed in the edit, never generated.">
          <Textarea rows={3} value={ad.brief.visualDirection} onChange={(e) => set('visualDirection', e.target.value)} placeholder="Warm, contemporary, grounded and human. Natural light, everyday northern Ghana settings…" />
        </Field>
      </Card>
      {ad.mode === 'brief_first' && (
        <Card className="space-y-3 p-5">
          <p className="eyebrow">Voice-over script</p>
          {ad.audio.referenceScript ? <pre className="max-h-56 overflow-auto rounded-xl border border-line bg-black/25 p-3 text-sm whitespace-pre-wrap text-dim">{ad.audio.referenceScript}</pre> : <Notice>No script yet. Write it yourself under Audio & assets, or draft it from this brief.</Notice>}
          <Button variant="subtle" loading={ai.busy} disabled={!ad.brief.keyMessage.trim() && !ad.brief.product.trim()} onClick={() => void writeScript()} icon={<Wand2 className="size-4" />}>
            {ad.audio.referenceScript ? 'Rewrite the script from the brief' : 'Draft the script from the brief'}
          </Button>
        </Card>
      )}
      <div className="flex justify-end">
        <Button variant="primary" icon={<ArrowRight className="size-4" />} onClick={() => go('assets')}>
          Audio & assets
        </Button>
      </div>
      {ai.dialog}
    </div>
  );
}
