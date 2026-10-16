import { toast } from 'sonner';
import { Sparkles } from 'lucide-react';
import {
  LITE_IMAGE_STYLE_LABELS,
  LITE_IMAGE_STYLES,
  LYRIC_LANGUAGES,
  MV_DIRECTION_PRESETS,
  MV_DIRECTIONS,
  applyMvConcept,
  applyMvDirection,
  mvConceptInput,
  type LiteAspect,
  type LiteImageStyle,
  type MvConceptOut,
  type MvDirectionId,
  type MvTreatment,
} from '@az-studio/shared';
import { useAiRun } from '../../lib/ai';
import { BibleEditor } from '../../components/lite/BibleEditor';
import { Badge, Button, cx, Field, Input, Notice, Segmented, Select, Textarea } from '../../components/ui';
import { Section, type MvStageProps } from './common';

const ASPECTS: LiteAspect[] = ['16:9', '9:16', '1:1'];

export function ConceptStage(props: MvStageProps) {
  const { project, spec, update, song, go } = props;
  const ai = useAiRun(project.id);
  const t = spec.concept.treatment;
  const setT = (patch: Partial<MvTreatment>, label = 'treatment') => update((s) => ({ ...s, concept: { ...s.concept, treatment: { ...(s.concept.treatment ?? { title: '', logline: '', concept: '', arc: '', imagery: '', tone: '' }), ...patch } } }), label);

  const writeConcept = async () => {
    if (!song) return toast.error('Choose the song first.');
    const out = await ai.run<MvConceptOut>('mvlite.concept', mvConceptInput(spec, song), 'Music video concept');
    if (!out) return;
    update((s) => applyMvConcept(s, out), 'concept');
    if (out.notes) toast.message('Notes from the director', { description: out.notes.slice(0, 400) });
  };

  return (
    <>
      <Section title="Direction" sub="A starting point for the look, the cutting pace and the lyric style — every value can be changed.">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3" role="radiogroup" aria-label="Direction">
          {MV_DIRECTIONS.map((id) => {
            const x = MV_DIRECTION_PRESETS[id];
            const on = spec.setup.direction === id;
            return (
              <button key={id} type="button" role="radio" aria-checked={on} onClick={() => update((s) => applyMvDirection(s, id as MvDirectionId), 'direction')} className={cx('cursor-pointer rounded-xl border p-3 text-left transition-colors', on ? 'border-accent/60 bg-accent/10' : 'border-line hover:border-line-strong')}>
                <p className="text-sm text-fg">{x.label}</p>
                <p className="mt-0.5 text-xs text-dim">{x.blurb}</p>
                <p className="mt-1 text-[11px] text-faint">
                  {x.barsPerShot.high}–{x.barsPerShot.low} bars per shot · {x.lyricPreset.replace(/_/g, ' ')}
                </p>
              </button>
            );
          })}
        </div>
      </Section>

      <Section
        title="Concept"
        sub="The idea of the video across the song. Written from the song’s structure, energy and lyrics; edit freely."
        action={
          <Button variant="primary" icon={<Sparkles className="size-4" />} loading={ai.busy} disabled={!song} onClick={() => void writeConcept()}>
            {t ? 'Rewrite the concept' : 'Write the concept'}
          </Button>
        }
      >
        {!song && <Notice className="mb-3">Choose the song on the first stage — the concept follows it.</Notice>}
        <Field label="Your idea" hint="Optional: a story, a place, a feeling, who appears. The concept builds on it.">
          <Textarea rows={3} value={spec.concept.idea} onChange={(e) => update((s) => ({ ...s, concept: { ...s.concept, idea: e.target.value } }), 'idea')} />
        </Field>
        {t && (
          <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
            <Field label="Title">
              <Input value={t.title} onChange={(e) => setT({ title: e.target.value })} />
            </Field>
            <Field label="Logline">
              <Input value={t.logline} onChange={(e) => setT({ logline: e.target.value })} />
            </Field>
            <Field label="Concept" className="lg:col-span-2">
              <Textarea rows={3} value={t.concept} onChange={(e) => setT({ concept: e.target.value })} />
            </Field>
            <Field label="Across the song">
              <Textarea rows={4} value={t.arc} onChange={(e) => setT({ arc: e.target.value })} />
            </Field>
            <Field label="Recurring imagery">
              <Textarea rows={4} value={t.imagery} onChange={(e) => setT({ imagery: e.target.value })} />
            </Field>
            <Field label="Tone">
              <Input value={t.tone} onChange={(e) => setT({ tone: e.target.value })} />
            </Field>
          </div>
        )}
      </Section>

      <Section title="Format" sub="Images are generated for the main format; extra formats reframe the same images (keep subjects central).">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          <Field label="Main format">
            <Segmented size="sm" label="Main format" value={spec.setup.aspect} onChange={(v) => update((s) => ({ ...s, setup: { ...s.setup, aspect: v, extraAspects: s.setup.extraAspects.filter((x) => x !== v) } }), 'aspect')} options={ASPECTS.map((a) => ({ value: a, label: a }))} />
          </Field>
          <Field label="Also export">
            <div className="flex gap-2">
              {ASPECTS.filter((a) => a !== spec.setup.aspect).map((a) => {
                const on = spec.setup.extraAspects.includes(a);
                return (
                  <button key={a} type="button" aria-pressed={on} onClick={() => update((s) => ({ ...s, setup: { ...s.setup, extraAspects: on ? s.setup.extraAspects.filter((x) => x !== a) : [...s.setup.extraAspects, a] } }), 'aspect')} className={cx('cursor-pointer rounded-full border px-3 py-1 text-xs', on ? 'border-accent/60 bg-accent/15 text-fg' : 'border-line text-dim')}>
                    {a}
                  </button>
                );
              })}
            </div>
          </Field>
          <Field label="Cuts land on">
            <Segmented size="sm" label="Cuts land on" value={spec.setup.cutOn} onChange={(v) => update((s) => ({ ...s, setup: { ...s.setup, cutOn: v } }), 'cut')} options={[{ value: 'downbeat', label: 'Bar lines' }, { value: 'beat', label: 'Any beat' }]} />
          </Field>
          <Field label="Image style">
            <Select value={spec.setup.imageStyle} onChange={(e) => update((s) => ({ ...s, setup: { ...s.setup, imageStyle: e.target.value as LiteImageStyle } }), 'style')}>
              {LITE_IMAGE_STYLES.map((x) => (
                <option key={x} value={x}>
                  {LITE_IMAGE_STYLE_LABELS[x]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Image size">
            <Segmented size="sm" label="Image size" value={spec.setup.imageSize} onChange={(v) => update((s) => ({ ...s, setup: { ...s.setup, imageSize: v } }), 'size')} options={[{ value: '2K', label: '2K' }, { value: '4K', label: '4K (sharper moves, costs more)' }]} />
          </Field>
          <Field label="Visual plan">
            <Segmented size="sm" label="Visual plan" value={spec.setup.visualPlan} onChange={(v) => update((s) => ({ ...s, setup: { ...s.setup, visualPlan: v } }), 'plan')} options={[{ value: 'rich', label: 'Rich' }, { value: 'economical', label: 'Economical (chorus callbacks)' }]} />
          </Field>
          <Field label="Lyrics language">
            <Select value={spec.setup.language} onChange={(e) => update((s) => ({ ...s, setup: { ...s.setup, language: e.target.value } }), 'lang')}>
              {LYRIC_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Section>

      <Section title="Visual bible" sub="Used in every image prompt. For a performer, add your own photos as likeness references — AZ Studio never depicts real artists from their name.">
        <BibleEditor
          projectId={project.id}
          bible={spec.bible}
          imageStyle={spec.setup.imageStyle}
          collection="mvlite"
          medium="music video"
          onChange={(fn, label) => update((s) => ({ ...s, bible: fn(s.bible) }), label)}
          onRemoveCharacter={(id) => update((s) => ({ ...s, bible: { ...s.bible, characters: s.bible.characters.filter((x) => x.id !== id) }, sections: s.sections.map((sc) => ({ ...sc, shots: sc.shots.map((sh) => ({ ...sh, characterIds: sh.characterIds.filter((x) => x !== id) })) })) }), 'char')}
        />
        <div className="mt-4 flex items-center gap-2">
          {spec.bible.characters.some((c) => !c.refAssetIds.length) && <Badge tone="warning">Characters without a likeness reference may look different from shot to shot</Badge>}
          <span className="flex-1" />
          <Button size="sm" variant="secondary" disabled={!song} onClick={() => go('shots')}>
            Plan the shots →
          </Button>
        </div>
      </Section>
      {ai.dialog}
    </>
  );
}
