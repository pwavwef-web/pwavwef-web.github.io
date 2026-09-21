import { useMemo } from 'react';
import { useParams } from 'react-router';
import { Printer } from 'lucide-react';
import { formatTimecode, type ProjectDoc, type SceneDoc, type ShotDoc } from '@az-studio/shared';
import { useDoc, type WithId } from '../../lib/data';
import { useMediaUrls } from '../../lib/media';
import { useSub } from '../../lib/studio';
import { Button, Spinner } from '../../components/ui';

function Frame({ shot }: { shot: WithId<ShotDoc> }) {
  const urls = useMediaUrls(shot.refs.storyboardAssetId ?? shot.refs.firstFrameAssetId);
  const src = urls?.file ?? urls?.thumb;
  const d = shot.directions;
  return (
    <figure className="break-inside-avoid">
      <div className="aspect-video w-full overflow-hidden border border-black/70 bg-neutral-100">{src ? <img src={src} alt="" className="size-full object-cover" /> : <div className="grid size-full place-items-center text-xs text-neutral-400">No frame</div>}</div>
      <figcaption className="mt-1.5 space-y-0.5 text-[10pt] leading-snug text-black">
        <p className="font-bold">
          {shot.number} · {shot.title} <span className="font-normal text-neutral-500">({shot.durationSec}s{shot.timing ? ` @ ${formatTimecode(shot.timing.start, 0)}` : ''})</span>
        </p>
        <p>{shot.description || d.action}</p>
        {(d.framing || d.cameraMovement || d.lens) && <p className="text-neutral-600">{[d.framing, d.lens, d.cameraMovement].filter(Boolean).join(' · ')}</p>}
        {d.lighting && <p className="text-neutral-600">Light: {d.lighting}</p>}
        {d.dialogue.length > 0 && <p className="italic">{d.dialogue.map((l) => `${l.character}: “${l.line}”`).join(' ')}</p>}
        {d.ambientSound && <p className="text-neutral-600">Sound: {d.ambientSound}</p>}
      </figcaption>
    </figure>
  );
}

export default function PrintStoryboard() {
  const { projectId } = useParams();
  const project = useDoc<ProjectDoc>(projectId ? `projects/${projectId}` : null);
  const scenes = useSub<SceneDoc>(projectId, 'scenes', 'order');
  const shots = useSub<ShotDoc>(projectId, 'shots', 'order');
  const groups = useMemo(() => {
    const byScene = new Map<string, WithId<ShotDoc>[]>();
    for (const s of shots.data) byScene.set(s.sceneId ?? '', [...(byScene.get(s.sceneId ?? '') ?? []), s]);
    const ordered = [...scenes.data].sort((a, b) => a.order - b.order).map((sc) => ({ title: `${sc.number ? `${sc.number}. ` : ''}${sc.heading}`, shots: byScene.get(sc.id) ?? [] }));
    const loose = byScene.get('') ?? [];
    return [...ordered.filter((g) => g.shots.length), ...(loose.length ? [{ title: 'Shots', shots: loose }] : [])];
  }, [scenes.data, shots.data]);
  if (project.loading || shots.loading) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner />
      </div>
    );
  }
  return (
    <div className="min-h-dvh bg-white text-black">
      <style>{`@page { size: A4 landscape; margin: 12mm; }`}</style>
      <div className="no-print sticky top-0 z-10 flex items-center justify-between border-b bg-white/95 px-6 py-3 backdrop-blur">
        <p className="text-sm">{project.data?.title} — storyboard</p>
        <Button variant="primary" onClick={() => window.print()} icon={<Printer className="size-4" />}>
          Print / Save as PDF
        </Button>
      </div>
      <div className="px-8 py-6 print:p-0">
        <h1 className="text-[20pt] font-bold">{project.data?.title}</h1>
        <p className="mb-6 text-[10pt] text-neutral-600">{project.data?.logline}</p>
        {groups.map((g) => (
          <section key={g.title} className="mb-8">
            <h2 className="mb-3 border-b border-black pb-1 font-mono text-[11pt] font-bold uppercase">{g.title}</h2>
            <div className="grid grid-cols-3 gap-5">
              {g.shots.map((s) => (
                <Frame key={s.id} shot={s} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
