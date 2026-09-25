import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { SECTION_LABELS, structureTimeline, VOCAL_OPTIONS, type MusicBrief, type SectionLabel, type StructurePart } from '@az-studio/shared';
import { ChipList } from '../fields';
import { LanguageSelect } from '../lyrics';
import { Button, Card, Field, IconButton, Input, Select, Textarea, Toggle } from '../ui';

const VOCAL_LABEL: Record<(typeof VOCAL_OPTIONS)[number], string> = { none: 'No vocals', lead: 'Lead vocal', duet: 'Duet', group: 'Group', choir: 'Choir', rap: 'Rap', spoken: 'Spoken word' };
const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
let n = 0;
const partId = () => `sp${Date.now().toString(36)}${(n = (n + 1) % 1000).toString(36)}`;

/** Every song setting the brief carries to the music model (all optional except the length). */
export function BriefForm({ brief, onChange, instrumentalMode }: { brief: MusicBrief; onChange: (b: MusicBrief) => void; instrumentalMode: boolean }) {
  const set = (patch: Partial<MusicBrief>) => onChange({ ...brief, ...patch });
  const setPart = (id: string, patch: Partial<StructurePart>) => set({ structure: brief.structure.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
  const plan = structureTimeline(brief);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="Title">
          <Input value={brief.title} onChange={(e) => set({ title: e.target.value.slice(0, 160) })} />
        </Field>
        <Field label="Language">
          <LanguageSelect value={brief.language} onChange={(v) => set({ language: v })} />
        </Field>
      </div>
      <Field label="Concept" hint="What the music is about or for — story, scene, brand, feeling.">
        <Textarea rows={3} value={brief.concept} onChange={(e) => set({ concept: e.target.value.slice(0, 3000) })} />
      </Field>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Field label="Genre">
          <Input value={brief.genre} onChange={(e) => set({ genre: e.target.value.slice(0, 80) })} placeholder="e.g. highlife" />
        </Field>
        <Field label="Subgenre">
          <Input value={brief.subgenre} onChange={(e) => set({ subgenre: e.target.value.slice(0, 80) })} placeholder="e.g. burger highlife" />
        </Field>
        <Field label="Mood">
          <Input value={brief.mood} onChange={(e) => set({ mood: e.target.value.slice(0, 160) })} placeholder="e.g. hopeful, nostalgic" />
        </Field>
        <Field label="Tempo (BPM)">
          <Input type="number" min={30} max={260} value={brief.tempoBpm ?? ''} placeholder="auto" onChange={(e) => set({ tempoBpm: e.target.value ? Math.max(30, Math.min(260, Math.round(Number(e.target.value)))) : null })} />
        </Field>
        <Field label="Key">
          <Input value={brief.key} onChange={(e) => set({ key: e.target.value.slice(0, 24) })} placeholder="e.g. A minor" />
        </Field>
        <Field label="Time signature">
          <Select value={brief.timeSignature} onChange={(e) => set({ timeSignature: e.target.value })}>
            {['4/4', '3/4', '6/8', '12/8', '2/4', '5/4', '7/8'].map((t) => (
              <option key={t}>{t}</option>
            ))}
          </Select>
        </Field>
        <Field label={`Duration (${mmss(brief.durationSec)})`}>
          <Input type="number" min={5} max={600} value={brief.durationSec} onChange={(e) => set({ durationSec: Math.max(5, Math.min(600, Math.round(Number(e.target.value) || 150))) })} />
        </Field>
        <Field label="Explicit content">
          <Select value={brief.explicit} onChange={(e) => set({ explicit: e.target.value as MusicBrief['explicit'] })}>
            <option value="clean">Clean</option>
            <option value="allowed">Allowed</option>
          </Select>
        </Field>
      </div>
      {!instrumentalMode && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-[200px_minmax(0,1fr)]">
          <Field label="Vocals">
            <Select value={brief.vocals} onChange={(e) => set({ vocals: e.target.value as MusicBrief['vocals'] })}>
              {VOCAL_OPTIONS.map((v) => (
                <option key={v} value={v}>
                  {VOCAL_LABEL[v]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Vocal character">
            <Input value={brief.vocalCharacter} onChange={(e) => set({ vocalCharacter: e.target.value.slice(0, 300) })} placeholder="e.g. warm female alto, call-and-response with a choir" />
          </Field>
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="Instrumentation">
          <ChipList value={brief.instrumentation} max={24} onChange={(v) => set({ instrumentation: v })} placeholder="e.g. palm-wine guitar" />
        </Field>
        <Field label="Instruments to avoid">
          <ChipList value={brief.avoidInstruments} max={20} onChange={(v) => set({ avoidInstruments: v })} placeholder="e.g. trap hi-hats" />
        </Field>
        <Field label="Energy progression">
          <Textarea rows={2} value={brief.energy} onChange={(e) => set({ energy: e.target.value.slice(0, 400) })} placeholder="e.g. intimate verses, lift into a big final chorus" />
        </Field>
        <Field label="Cultural direction">
          <Textarea rows={2} value={brief.culturalDirection} onChange={(e) => set({ culturalDirection: e.target.value.slice(0, 600) })} placeholder="e.g. Upper East Ghana, kologo and xylophone rhythms, sung in Kasem" />
        </Field>
      </div>
      <Card className="space-y-3 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="eyebrow">Song structure</p>
          <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} disabled={brief.structure.length >= 30} onClick={() => set({ structure: [...brief.structure, { id: partId(), label: 'verse', name: '', seconds: null, notes: '' }] })}>
            Add part
          </Button>
        </div>
        {brief.structure.length === 0 ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Field label="Intro (s)">
              <Input type="number" min={0} max={120} value={brief.introSec ?? ''} placeholder="auto" onChange={(e) => set({ introSec: e.target.value === '' ? null : Math.max(0, Math.min(120, Number(e.target.value))) })} />
            </Field>
            <Field label="Verses">
              <Input type="number" min={0} max={8} value={brief.verseCount} onChange={(e) => set({ verseCount: Math.max(0, Math.min(8, Math.round(Number(e.target.value) || 0))) })} />
            </Field>
            <Field label="Choruses">
              <Input type="number" min={0} max={8} value={brief.chorusCount} onChange={(e) => set({ chorusCount: Math.max(0, Math.min(8, Math.round(Number(e.target.value) || 0))) })} />
            </Field>
            <div className="flex items-end">
              <Toggle checked={brief.bridge} onChange={(v) => set({ bridge: v })} label="Bridge" />
            </div>
            <div className="flex items-end">
              <Toggle checked={brief.outro} onChange={(v) => set({ outro: v })} label="Outro" />
            </div>
          </div>
        ) : (
          <ul className="space-y-1.5">
            {brief.structure.map((p, i) => (
              <li key={p.id} className="grid grid-cols-[120px_minmax(0,1fr)_90px_minmax(0,1.4fr)_auto] items-center gap-2">
                <Select className="h-8 text-xs" value={p.label} onChange={(e) => setPart(p.id, { label: e.target.value as SectionLabel })} aria-label="Part type">
                  {SECTION_LABELS.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </Select>
                <Input className="h-8 text-xs" value={p.name} placeholder={`${p.label[0]!.toUpperCase()}${p.label.slice(1)}`} onChange={(e) => setPart(p.id, { name: e.target.value.slice(0, 60) })} aria-label="Part name" />
                <Input className="h-8 text-xs" type="number" min={1} max={600} value={p.seconds ?? ''} placeholder="auto s" onChange={(e) => setPart(p.id, { seconds: e.target.value ? Math.max(1, Math.min(600, Number(e.target.value))) : null })} aria-label="Seconds" />
                <Input className="h-8 text-xs" value={p.notes} placeholder="Direction for this part" onChange={(e) => setPart(p.id, { notes: e.target.value.slice(0, 300) })} aria-label="Part notes" />
                <span className="flex">
                  <IconButton size="sm" label="Move up" disabled={i === 0} onClick={() => {
                      const a = [...brief.structure];
                      [a[i - 1], a[i]] = [a[i]!, a[i - 1]!];
                      set({ structure: a });
                    }}>
                    <ArrowUp className="size-3.5" />
                  </IconButton>
                  <IconButton size="sm" label="Move down" disabled={i === brief.structure.length - 1} onClick={() => {
                      const a = [...brief.structure];
                      [a[i + 1], a[i]] = [a[i]!, a[i + 1]!];
                      set({ structure: a });
                    }}>
                    <ArrowDown className="size-3.5" />
                  </IconButton>
                  <IconButton size="sm" label="Remove part" onClick={() => set({ structure: brief.structure.filter((x) => x.id !== p.id) })}>
                    <Trash2 className="size-3.5" />
                  </IconButton>
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[11px] text-faint">
          Sent as timed directions: {plan.map((x) => `${x.label} ${mmss(x.start)}`).join(' · ') || '—'}
        </p>
      </Card>
    </div>
  );
}
