import { useState } from 'react';
import { useNavigate } from 'react-router';
import { doc, getDoc } from 'firebase/firestore';
import { toast } from 'sonner';
import { assemblePicture, emptyTimeline, makeClip, type AssemblyItem, type ProjectDoc, type SceneDoc, type ShotDoc, type TakeDoc } from '@az-studio/shared';
import { db } from '../../lib/firebase';
import { errorMessage } from '../../lib/api';
import type { WithId } from '../../lib/data';
import { useUid } from '../../lib/session';
import { createTimeline, updateSubDoc, useSub } from '../../lib/studio';
import { EditAndExport } from '../../components/assembly';
import { Card, Toggle } from '../../components/ui';

export function AssemblyTab({ project }: { project: WithId<ProjectDoc> }) {
  const uid = useUid();
  const navigate = useNavigate();
  const scenes = useSub<SceneDoc>(project.id, 'scenes', 'order');
  const shots = useSub<ShotDoc>(project.id, 'shots', 'order');
  const [dissolve, setDissolve] = useState(true);
  const [title, setTitle] = useState(true);
  const [busy, setBusy] = useState(false);
  const approved = shots.data.filter((s) => s.approvedTakeId || s.selectedTakeId);

  const assemble = async () => {
    setBusy(true);
    try {
      const sceneOrder = new Map(scenes.data.map((s) => [s.id, s.order]));
      const ordered = [...approved].sort((a, b) => (sceneOrder.get(a.sceneId ?? '') ?? 1e9) - (sceneOrder.get(b.sceneId ?? '') ?? 1e9) || a.order - b.order);
      let state = emptyTimeline(project.format.aspectRatio, project.format.fps);
      if (title) {
        const ov = state.tracks.find((t) => t.kind === 'overlay')!;
        state = { ...state, clips: [makeClip({ trackId: ov.id, kind: 'title', start: 0, duration: 4, text: project.title, fadeIn: 0.8, fadeOut: 0.8, label: 'Main title', style: { font: 'EB Garamond', sizePct: 9, color: '#FFFFFF', background: '#05070B', bold: false, italic: false, uppercase: false, outline: 0, shadow: false } })] };
      }
      const items: AssemblyItem[] = [];
      let lastScene: string | null | undefined;
      const sceneStarts = new Set<number>();
      for (const s of ordered) {
        const takeId = s.approvedTakeId ?? s.selectedTakeId!;
        const take = (await getDoc(doc(db, 'projects', project.id, 'shots', s.id, 'takes', takeId))).data() as TakeDoc | undefined;
        if (!take?.assetId) continue;
        const asset = (await getDoc(doc(db, 'assets', take.assetId))).data() as { durationSec?: number } | undefined;
        if (lastScene !== undefined && s.sceneId !== lastScene) sceneStarts.add(items.length);
        lastScene = s.sceneId;
        items.push({ assetId: take.assetId, kind: 'video', durationSec: asset?.durationSec ?? s.durationSec, sourceDuration: asset?.durationSec ?? s.durationSec, label: `${s.number} ${s.title}`.trim(), shotId: s.id, takeId, at: items.length === 0 && title ? 4 : null });
      }
      if (!items.length) throw new Error('Approve or select takes for at least one shot.');
      state = assemblePicture(state, items);
      if (dissolve) {
        const video = state.clips.filter((c) => c.kind === 'video').sort((a, b) => a.start - b.start);
        state = { ...state, clips: state.clips.map((c) => (sceneStarts.has(video.findIndex((v) => v.id === c.id)) ? { ...c, transitionIn: { type: 'dissolve' as const, duration: 0.8 } } : c)) };
      }
      const id = await createTimeline(uid, project.id, `${project.title} — assembly ${new Date().toLocaleDateString()}`, state, project.format.aspectRatio);
      await Promise.all(scenes.data.filter((sc) => ordered.some((s) => s.sceneId === sc.id)).map((sc) => updateSubDoc(project.id, 'scenes', sc.id, { status: 'assembled' })));
      navigate(`/projects/${project.id}/timeline/${id}`);
    } catch (e) {
      toast.error('Could not assemble', { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <Card className="flex flex-wrap items-center gap-6 p-5">
        <Toggle checked={title} onChange={setTitle} label="Main title card" />
        <Toggle checked={dissolve} onChange={setDissolve} label="Dissolve between scenes" />
      </Card>
      <EditAndExport project={project} onAssemble={() => void assemble()} assembling={busy} assembleLabel={`Assemble ${approved.length} approved shots`} assembleHint="Shots are laid out in scene order, then shot order. Use the editor for trims, audio, captions and transitions." />
    </div>
  );
}
