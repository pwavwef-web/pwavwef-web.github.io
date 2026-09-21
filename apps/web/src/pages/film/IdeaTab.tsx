import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Wand2 } from 'lucide-react';
import type { ProjectDoc, Treatment } from '@az-studio/shared';
import { useAiRun } from '../../lib/ai';
import { useDebounced, type WithId } from '../../lib/data';
import { addDocs, newCharacter, newLocation, updateProject } from '../../lib/studio';
import { Badge, Button, Card, Field, Input, Textarea } from '../../components/ui';

export function IdeaTab({ project }: { project: WithId<ProjectDoc> }) {
  const ai = useAiRun(project.id);
  const [idea, setIdea] = useState(project.idea ?? '');
  const [genre, setGenre] = useState(project.genre ?? '');
  const [tone, setTone] = useState(project.treatment?.tone ?? '');
  const [runtime, setRuntime] = useState(10);
  const [notes, setNotes] = useState('');
  const [t, setT] = useState<Treatment>(project.treatment ?? {});
  const deb = useDebounced({ idea, genre, t }, 1200);
  useEffect(() => {
    const changed = deb.idea !== (project.idea ?? '') || deb.genre !== (project.genre ?? '') || JSON.stringify(deb.t) !== JSON.stringify(project.treatment ?? {});
    if (changed) void updateProject(project.id, { idea: deb.idea, genre: deb.genre, treatment: deb.t, ...(deb.t.logline ? { logline: deb.t.logline } : {}) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deb]);

  const develop = async () => {
    const out = await ai.run<Treatment & { characters?: { name: string; role: string; description: string }[]; settings?: { name: string; description: string }[] }>(
      'film.treatment',
      { idea, genre, tone, runtimeMinutes: runtime, logline: project.logline, notes },
      'Develop treatment',
    );
    if (!out) return;
    const next: Treatment = { title: out.title, logline: out.logline, synopsis: out.synopsis, body: out.body, themes: out.themes, tone: out.tone, visualStyle: out.visualStyle, palette: out.palette };
    setT(next);
    await updateProject(project.id, { treatment: next, logline: out.logline ?? project.logline ?? '', styleBible: { ...(project.styleBible ?? {}), visualStyle: project.styleBible?.visualStyle || out.visualStyle, palette: project.styleBible?.palette || (out.palette ?? []).join(', ') } });
    if (out.characters?.length) await addDocs(project.id, 'characters', out.characters.map((c) => newCharacter({ name: c.name, role: c.role, description: c.description })));
    if (out.settings?.length) await addDocs(project.id, 'locations', out.settings.map((l) => newLocation({ name: l.name, description: l.description })));
    toast.success('Treatment developed', { description: `${out.characters?.length ?? 0} characters and ${out.settings?.length ?? 0} locations added to the bibles.` });
  };

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
      <Card className="space-y-4 p-5">
        <p className="eyebrow">The idea</p>
        <Field label="Premise">
          <Textarea rows={5} value={idea} onChange={(e) => setIdea(e.target.value)} placeholder="What is the story? Who wants what, what stands in the way, why now?" />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Genre">
            <Input value={genre} onChange={(e) => setGenre(e.target.value)} placeholder="Drama, thriller, afrofuturist fable…" />
          </Field>
          <Field label="Tone">
            <Input value={tone} onChange={(e) => setTone(e.target.value)} placeholder="Tender, defiant, luminous" />
          </Field>
          <Field label="Target runtime (minutes)">
            <Input type="number" min={1} max={240} value={runtime} onChange={(e) => setRuntime(Number(e.target.value) || 1)} />
          </Field>
        </div>
        <Field label="Notes for the writer">
          <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Must-have scenes, cultural details, references" />
        </Field>
        <Button variant="primary" loading={ai.busy} disabled={!idea.trim()} onClick={() => void develop()} icon={<Wand2 className="size-4" />}>
          {t.body ? 'Redevelop treatment' : 'Develop treatment'}
        </Button>
      </Card>
      <Card className="space-y-4 p-5">
        <div className="flex items-center justify-between">
          <p className="eyebrow">Treatment</p>
          {t.themes?.length ? (
            <div className="flex flex-wrap gap-1">
              {t.themes.slice(0, 4).map((x) => (
                <Badge key={x}>{x}</Badge>
              ))}
            </div>
          ) : null}
        </div>
        <Field label="Title">
          <Input value={t.title ?? ''} onChange={(e) => setT({ ...t, title: e.target.value })} />
        </Field>
        <Field label="Logline">
          <Textarea rows={2} value={t.logline ?? ''} onChange={(e) => setT({ ...t, logline: e.target.value })} />
        </Field>
        <Field label="Synopsis">
          <Textarea rows={4} value={t.synopsis ?? ''} onChange={(e) => setT({ ...t, synopsis: e.target.value })} />
        </Field>
        <Field label="Treatment">
          <Textarea rows={14} value={t.body ?? ''} onChange={(e) => setT({ ...t, body: e.target.value })} className="font-[family-name:var(--font-display)] text-[17px] leading-relaxed" />
        </Field>
        <Field label="Visual style">
          <Textarea rows={2} value={t.visualStyle ?? ''} onChange={(e) => setT({ ...t, visualStyle: e.target.value })} />
        </Field>
      </Card>
      {ai.dialog}
    </div>
  );
}
