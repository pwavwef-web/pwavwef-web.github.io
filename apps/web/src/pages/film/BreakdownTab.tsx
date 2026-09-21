import { useState } from 'react';
import { writeBatch, doc } from 'firebase/firestore';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, ChevronDown, ListChecks, Plus, Sparkles, Trash2 } from 'lucide-react';
import { formatDuration, parseFountain, type CharacterDoc, type LocationDoc, type ProjectDoc, type SceneDoc, type ScriptDoc, type SequenceDoc } from '@az-studio/shared';
import { db } from '../../lib/firebase';
import { useAiRun } from '../../lib/ai';
import type { WithId } from '../../lib/data';
import { addDocs, deleteSubDoc, newScene, subDoc, updateSubDoc, useSub } from '../../lib/studio';
import { Badge, Button, Card, cx, EmptyState, Field, IconButton, Input, Select, Textarea } from '../../components/ui';

type Scene = WithId<SceneDoc>;

function SceneRow({ project, scene, index, count, sequences, characters, onMove }: { project: WithId<ProjectDoc>; scene: Scene; index: number; count: number; sequences: WithId<SequenceDoc>[]; characters: WithId<CharacterDoc>[]; onMove: (dir: -1 | 1) => void }) {
  const [open, setOpen] = useState(false);
  const set = (patch: Partial<SceneDoc>) => void updateSubDoc(project.id, 'scenes', scene.id, patch);
  const names = scene.characterIds.map((id) => characters.find((c) => c.id === id)?.name).filter(Boolean);
  return (
    <li className="card overflow-hidden">
      <div className="flex items-center gap-2 p-3">
        <div className="flex flex-col">
          <IconButton label="Move up" size="sm" disabled={index === 0} onClick={() => onMove(-1)}>
            <ArrowUp className="size-3.5" />
          </IconButton>
          <IconButton label="Move down" size="sm" disabled={index === count - 1} onClick={() => onMove(1)}>
            <ArrowDown className="size-3.5" />
          </IconButton>
        </div>
        <button type="button" onClick={() => setOpen((v) => !v)} className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left" aria-expanded={open}>
          <span className="timecode w-8 shrink-0 text-xs text-faint">{scene.number || index + 1}</span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-mono text-[13px] font-semibold tracking-wide text-fg uppercase">{scene.heading || 'Untitled scene'}</p>
            <p className="mt-0.5 line-clamp-1 text-xs text-dim">{scene.summary || 'No summary'}</p>
          </div>
          <div className="hidden shrink-0 items-center gap-2 sm:flex">
            {names.length > 0 && <span className="max-w-48 truncate text-xs text-faint">{names.join(', ')}</span>}
            <Badge>{formatDuration(scene.estimatedDurationSec)}</Badge>
            <Badge tone={scene.status === 'assembled' ? 'success' : scene.status === 'draft' ? 'neutral' : 'accent'}>{scene.status}</Badge>
          </div>
          <ChevronDown className={cx('size-4 shrink-0 text-faint transition-transform', open && 'rotate-180')} />
        </button>
      </div>
      {open && (
        <div className="grid gap-3 border-t border-line p-4 md:grid-cols-2">
          <Field label="Heading">
            <Input value={scene.heading} onChange={(e) => set({ heading: e.target.value.toUpperCase() })} className="font-mono" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Sequence">
              <Select value={scene.sequenceId ?? ''} onChange={(e) => set({ sequenceId: e.target.value || null })}>
                <option value="">—</option>
                {sequences.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Status">
              <Select value={scene.status} onChange={(e) => set({ status: e.target.value as SceneDoc['status'] })}>
                {['draft', 'boarded', 'generating', 'assembled'].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Summary" className="md:col-span-2">
            <Textarea rows={2} value={scene.summary} onChange={(e) => set({ summary: e.target.value })} />
          </Field>
          <Field label="Characters">
            <div className="flex flex-wrap gap-1.5">
              {characters.map((c) => {
                const on = scene.characterIds.includes(c.id);
                return (
                  <button key={c.id} type="button" aria-pressed={on} onClick={() => set({ characterIds: on ? scene.characterIds.filter((x) => x !== c.id) : [...scene.characterIds, c.id] })} className={cx('cursor-pointer rounded-full border px-2.5 py-1 text-xs', on ? 'border-accent/60 bg-accent/15 text-fg' : 'border-line text-dim')}>
                    {c.name}
                  </button>
                );
              })}
            </div>
          </Field>
          <Field label="Mood">
            <Input value={scene.mood} onChange={(e) => set({ mood: e.target.value })} />
          </Field>
          <Field label="Props">
            <Input value={scene.props.join(', ')} onChange={(e) => set({ props: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
          </Field>
          <Field label="Costumes">
            <Input value={scene.costumes.join(', ')} onChange={(e) => set({ costumes: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
          </Field>
          <Field label="Dialogue plan">
            <Textarea rows={2} value={scene.dialoguePlan} onChange={(e) => set({ dialoguePlan: e.target.value })} />
          </Field>
          <Field label="Audio plan (music, ambience, effects)">
            <Textarea rows={2} value={scene.audioPlan} onChange={(e) => set({ audioPlan: e.target.value })} />
          </Field>
          <Field label="Estimated duration (s)">
            <Input type="number" min={1} value={scene.estimatedDurationSec} onChange={(e) => set({ estimatedDurationSec: Number(e.target.value) || 1 })} />
          </Field>
          <Field label="Notes">
            <Input value={scene.notes} onChange={(e) => set({ notes: e.target.value })} />
          </Field>
          <div className="md:col-span-2">
            <Button size="sm" variant="danger" icon={<Trash2 className="size-3.5" />} onClick={() => void deleteSubDoc(project.id, 'scenes', scene.id)}>
              Delete scene
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

export function BreakdownTab({ project }: { project: WithId<ProjectDoc> }) {
  const scenes = useSub<SceneDoc>(project.id, 'scenes', 'order');
  const sequences = useSub<SequenceDoc>(project.id, 'sequences', 'order');
  const scripts = useSub<ScriptDoc>(project.id, 'scripts', 'updatedAt', 'desc');
  const characters = useSub<CharacterDoc>(project.id, 'characters', 'name');
  const locations = useSub<LocationDoc>(project.id, 'locations', 'name');
  const ai = useAiRun(project.id);
  const [busy, setBusy] = useState(false);
  const fountain = scripts.data[0]?.content ?? '';

  const matchChars = (names: string[]) => names.map((n) => characters.data.find((c) => c.name.toUpperCase() === n.toUpperCase())?.id).filter((x): x is string => Boolean(x));
  const parse = async () => {
    const parsed = parseFountain(fountain);
    if (!parsed.scenes.length) return toast.error('No scene headings found in the screenplay.');
    setBusy(true);
    try {
      const existing = new Set(scenes.data.map((s) => `${s.order}|${s.heading}`));
      const fresh = parsed.scenes
        .map((s, i) =>
          newScene({
            order: i,
            number: s.number ?? String(i + 1),
            heading: s.heading,
            intExt: s.intExt,
            locationName: s.location,
            locationId: locations.data.find((l) => l.name.toUpperCase() === s.location.toUpperCase())?.id ?? null,
            timeOfDay: s.timeOfDay,
            summary: s.synopsis,
            characterIds: matchChars(s.characters),
            estimatedDurationSec: Math.max(10, Math.round(s.pages * 60)),
          }),
        )
        .filter((s) => !existing.has(`${s.order}|${s.heading}`));
      await addDocs(project.id, 'scenes', fresh);
      toast.success(`${fresh.length} scenes added from the screenplay`);
    } finally {
      setBusy(false);
    }
  };
  const aiBreakdown = async () => {
    const out = await ai.run<{ sequences: { title: string; summary: string; sceneIndexes: number[] }[]; scenes: { index: number; heading: string; summary: string; characters: string[]; props: string[]; costumes: string[]; mood: string; dialoguePlan: string; audioPlan: string; estimatedDurationSec: number }[] }>(
      'film.breakdown',
      { fountain, knownCharacters: characters.data.map((c) => c.name), knownLocations: locations.data.map((l) => l.name) },
      'Scene breakdown',
    );
    if (!out) return;
    const seqIds = await addDocs(project.id, 'sequences', out.sequences.map((s, i) => ({ title: s.title, summary: s.summary, order: i })));
    const sorted = [...scenes.data].sort((a, b) => a.order - b.order);
    const batch = writeBatch(db);
    const toCreate: ReturnType<typeof newScene>[] = [];
    for (const s of out.scenes) {
      const seqIdx = out.sequences.findIndex((q) => q.sceneIndexes.includes(s.index));
      const patch = { summary: s.summary, props: s.props, costumes: s.costumes, mood: s.mood, dialoguePlan: s.dialoguePlan, audioPlan: s.audioPlan, estimatedDurationSec: Math.round(s.estimatedDurationSec), characterIds: matchChars(s.characters), sequenceId: seqIdx >= 0 ? seqIds[seqIdx] ?? null : null };
      const target = sorted[s.index - 1];
      if (target) batch.update(subDoc(project.id, 'scenes', target.id), patch);
      else toCreate.push(newScene({ ...patch, order: s.index - 1, number: String(s.index), heading: s.heading }));
    }
    await batch.commit();
    if (toCreate.length) await addDocs(project.id, 'scenes', toCreate);
    toast.success(`Breakdown applied: ${out.sequences.length} sequences, ${out.scenes.length} scenes`);
  };
  const move = async (i: number, dir: -1 | 1) => {
    const list = [...scenes.data].sort((a, b) => a.order - b.order);
    const a = list[i];
    const b = list[i + dir];
    if (!a || !b) return;
    const batch = writeBatch(db);
    batch.update(doc(db, 'projects', project.id, 'scenes', a.id), { order: b.order });
    batch.update(doc(db, 'projects', project.id, 'scenes', b.id), { order: a.order === b.order ? a.order + dir : a.order });
    await batch.commit();
  };

  const bySeq = new Map<string | null, Scene[]>();
  for (const s of scenes.data) bySeq.set(s.sequenceId, [...(bySeq.get(s.sequenceId) ?? []), s]);
  const total = scenes.data.reduce((t, s) => t + s.estimatedDurationSec, 0);
  const ordered = [...scenes.data].sort((a, b) => a.order - b.order);

  return (
    <div className="space-y-5">
      <Card className="flex flex-wrap items-center gap-3 p-4">
        <Button loading={busy} disabled={!fountain.trim()} onClick={() => void parse()} icon={<ListChecks className="size-4" />}>
          Parse scenes from screenplay
        </Button>
        <Button variant="subtle" loading={ai.busy} disabled={!fountain.trim()} onClick={() => void aiBreakdown()} icon={<Sparkles className="size-4" />}>
          AI breakdown (props, costumes, audio)
        </Button>
        <Button variant="ghost" icon={<Plus className="size-4" />} onClick={() => void addDocs(project.id, 'scenes', [newScene({ order: scenes.data.length, heading: 'INT. NEW SCENE - DAY' })])}>
          Add scene
        </Button>
        <span className="ml-auto text-xs text-faint">
          {scenes.data.length} scenes · {sequences.data.length} sequences · ≈ {formatDuration(total)}
        </span>
      </Card>
      {scenes.data.length === 0 ? (
        <EmptyState icon={<ListChecks className="size-5" />} title="No scenes yet" body="Parse the screenplay to create the scene list, then enrich it with the AI breakdown." />
      ) : sequences.data.length ? (
        [...sequences.data, { id: '', title: 'Unassigned', summary: '', order: 1e9 } as WithId<SequenceDoc>]
          .filter((q) => (bySeq.get(q.id || null) ?? []).length)
          .map((q) => (
            <section key={q.id || 'none'} className="space-y-2">
              <div>
                <p className="display text-2xl text-fg">{q.title}</p>
                {q.summary && <p className="text-xs text-dim">{q.summary}</p>}
              </div>
              <ul className="space-y-2">
                {(bySeq.get(q.id || null) ?? [])
                  .sort((a, b) => a.order - b.order)
                  .map((s) => {
                    const i = ordered.findIndex((x) => x.id === s.id);
                    return <SceneRow key={s.id} project={project} scene={s} index={i} count={ordered.length} sequences={sequences.data} characters={characters.data} onMove={(d) => void move(i, d)} />;
                  })}
              </ul>
            </section>
          ))
      ) : (
        <ul className="space-y-2">
          {ordered.map((s, i) => (
            <SceneRow key={s.id} project={project} scene={s} index={i} count={ordered.length} sequences={sequences.data} characters={characters.data} onMove={(d) => void move(i, d)} />
          ))}
        </ul>
      )}
      {ai.dialog}
    </div>
  );
}
