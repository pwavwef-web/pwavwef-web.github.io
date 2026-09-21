import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Plus, Sparkles } from 'lucide-react';
import { parseFountain, type ProjectDoc, type SceneDoc, type ScriptDoc, type ShotDoc } from '@az-studio/shared';
import { useAiRun } from '../../lib/ai';
import type { WithId } from '../../lib/data';
import { useBoot } from '../../lib/session';
import { addShots, newShot, useSub } from '../../lib/studio';
import { ShotQueue, useShotContext } from '../../components/shots';
import { Button, Card, Field, Select } from '../../components/ui';

/** Screenplay text between a scene heading and the next one. */
function sceneText(fountain: string, sceneIndex: number): string {
  const doc = parseFountain(fountain);
  const lines = fountain.replace(/\r\n?/g, '\n').split('\n');
  const start = doc.scenes[sceneIndex]?.line;
  if (start === undefined) return '';
  const end = doc.scenes[sceneIndex + 1]?.line ?? lines.length;
  return lines.slice(start, end).join('\n').slice(0, 20000);
}

export function FilmShotsTab({ project }: { project: WithId<ProjectDoc> }) {
  const boot = useBoot();
  const ctx = useShotContext(project);
  const scenes = useSub<SceneDoc>(project.id, 'scenes', 'order');
  const shots = useSub<ShotDoc>(project.id, 'shots', 'order');
  const scripts = useSub<ScriptDoc>(project.id, 'scripts', 'updatedAt', 'desc');
  const [sceneId, setSceneId] = useState<string>('');
  const [maxShots, setMaxShots] = useState(8);
  const ai = useAiRun(project.id);
  const scene = scenes.data.find((s) => s.id === sceneId) ?? null;
  const visible = useMemo(() => (sceneId ? shots.data.filter((s) => s.sceneId === sceneId) : shots.data), [shots.data, sceneId]);
  const aspect: ShotDoc['aspectRatio'] = project.format.aspectRatio === '9:16' ? '9:16' : '16:9';

  const plan = async () => {
    if (!scene) return;
    const sceneIndex = [...scenes.data].sort((a, b) => a.order - b.order).findIndex((s) => s.id === scene.id);
    const text = sceneText(scripts.data[0]?.content ?? '', sceneIndex);
    const chars = ctx.characters.filter((c) => scene.characterIds.includes(c.id));
    const loc = ctx.locations.find((l) => l.id === scene.locationId) ?? ctx.locations.find((l) => l.name.toUpperCase() === scene.locationName.toUpperCase());
    const out = await ai.run<{ shots: { title: string; description: string; framing: string; cameraMovement: string; lens: string; lighting: string; mood: string; performance: string; action: string; ambientSound: string; dialogue: { character: string; line: string }[]; durationSec: number; characterNames: string[]; transition: string }[] }>(
      'film.shotlist',
      { scene: { heading: scene.heading, summary: scene.summary, text, mood: scene.mood, audioPlan: scene.audioPlan }, characters: chars.map((c) => ({ name: c.name, description: c.appearance })), location: loc ? { name: loc.name, description: loc.description } : null, styleBible: project.styleBible ?? {}, aspectRatio: aspect, maxShots },
      `Shot list · ${scene.heading}`,
    );
    if (!out?.shots?.length) return;
    const existing = shots.data.filter((s) => s.sceneId === scene.id).length;
    const docs = out.shots.map((s, i) =>
      newShot({
        sceneId: scene.id,
        order: scene.order * 1000 + existing + i,
        number: `${scene.number || sceneIndex + 1}${String.fromCharCode(65 + ((existing + i) % 26))}`,
        title: s.title,
        description: s.description,
        durationSec: Math.min(10, Math.max(3, Math.round(s.durationSec || 6))),
        aspectRatio: aspect,
        resolution: boot?.settings.defaultVideoResolution ?? '720p',
        directions: { framing: s.framing, cameraMovement: s.cameraMovement, lens: s.lens, lighting: s.lighting, mood: s.mood, style: '', performance: s.performance, action: s.action, dialogue: s.dialogue ?? [], ambientSound: s.ambientSound, avoid: 'on-screen text or subtitles' },
        refs: {
          characterIds: (s.characterNames ?? []).map((n) => ctx.characters.find((c) => c.name.toUpperCase() === n.toUpperCase())?.id).filter((x): x is string => Boolean(x)),
          locationIds: loc ? [loc.id] : [],
          elementIds: [],
          assetIds: [],
          firstFrameAssetId: null,
          lastFrameAssetId: null,
          storyboardAssetId: null,
        },
      }),
    );
    await addShots(project.id, docs);
    toast.success(`${docs.length} shots added to ${scene.heading}`);
  };

  return (
    <div className="space-y-5">
      <Card className="flex flex-wrap items-end gap-4 p-5">
        <Field label="Scene" className="min-w-64 flex-1">
          <Select value={sceneId} onChange={(e) => setSceneId(e.target.value)}>
            <option value="">All scenes ({shots.data.length} shots)</option>
            {[...scenes.data]
              .sort((a, b) => a.order - b.order)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.number ? `${s.number}. ` : ''}
                  {s.heading} ({shots.data.filter((x) => x.sceneId === s.id).length})
                </option>
              ))}
          </Select>
        </Field>
        <Field label="Max shots" className="w-28">
          <Select value={maxShots} onChange={(e) => setMaxShots(Number(e.target.value))}>
            {[4, 6, 8, 12, 16].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </Select>
        </Field>
        <Button variant="primary" loading={ai.busy} disabled={!scene} onClick={() => void plan()} icon={<Sparkles className="size-4" />}>
          {scene ? 'Generate shot list for scene' : 'Choose a scene to plan'}
        </Button>
        <Button variant="ghost" icon={<Plus className="size-4" />} onClick={() => void addShots(project.id, [newShot({ sceneId: sceneId || null, aspectRatio: aspect, order: (scene?.order ?? 0) * 1000 + visible.length })])}>
          Add shot
        </Button>
      </Card>
      <ShotQueue ctx={ctx} shots={visible} />
      {ai.dialog}
    </div>
  );
}
