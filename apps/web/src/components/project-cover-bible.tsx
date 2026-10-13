import { toast } from 'sonner';
import { ImagePlus, RefreshCw } from 'lucide-react';
import type { CharacterDoc, JobDoc, ProjectDoc } from '@az-studio/shared';
import { useDoc, type WithId } from '../lib/data';
import { useSub } from '../lib/studio';
import { useMediaUrls } from '../lib/media';
import { useJobSubmitter } from './jobs';
import { Button, Card, Notice } from './ui';

/** Covers belong beside the likeness references, after the character identities are established. */
export function ProjectCoverBible({ project }: { project: WithId<ProjectDoc> }) {
  const characters = useSub<CharacterDoc>(project.id, 'characters', 'name');
  const job = useDoc<JobDoc>(project.coverJobId ? `jobs/${project.coverJobId}` : null);
  const media = useMediaUrls(project.coverAssetId ?? null);
  const { submit, busy, dialog } = useJobSubmitter();
  const reference = (c: CharacterDoc) => (c.bible?.approvedAt ? c.bible.approvedRefIds[0] : null) || c.primaryRefAssetId || c.bible?.refs.front;
  const missing = characters.data.filter(c => !reference(c) || (c.realPerson && !c.consentConfirmed));
  const ready = !characters.loading && characters.data.length > 0 && !missing.length;
  const generating = job.data && !['completed', 'failed', 'cancelled'].includes(job.data.status);
  const generate = async () => {
    const ids = await submit([{type: 'image.generate', projectId: project.id, bibleCover: true, purpose: 'thumbnail', prompt: 'Create the project cover from the Bible character references.', aspectRatio: '16:9', imageSize: '1K', referenceAssetIds: [], grounding: false, applyStyleBible: false, characterIds: [], collections: ['project-covers'], target: {kind: 'project', id: project.id}}], {label: `Project cover · ${project.title}`});
    if (ids?.length) toast.success('Project cover queued', {description: 'The cover will use the Bible likenesses and appear on the project when ready.'});
  };
  const src = media?.thumb ?? media?.poster ?? media?.file;
  return (
    <Card className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center">
      {src && <img src={src} alt={`${project.title} project cover`} className="aspect-video w-full rounded-xl object-cover sm:w-48" />}
      <div className="min-w-0 flex-1 space-y-2">
        <p className="eyebrow">Project cover</p>
        <p className="text-sm text-dim">A cover is generated automatically once every character has a likeness reference. It uses those exact faces and the treatment.</p>
        {!ready && <p className="text-xs text-faint">{characters.data.length ? `Finish the likeness references for ${missing.map(c => c.name).join(', ')} first.` : 'Add characters and generate their likeness references first.'}</p>}
        {generating && <p role="status" className="text-xs text-accent-2">{job.data?.stage || 'Generating project cover…'}</p>}
        {job.data?.status === 'failed' && <Notice tone="warning">{job.data.error?.message || 'The cover could not finish. Regenerate it when ready.'}</Notice>}
      </div>
      <Button loading={busy || Boolean(generating)} disabled={!ready || Boolean(generating)} onClick={() => void generate()} icon={project.coverAssetId ? <RefreshCw className="size-4" /> : <ImagePlus className="size-4" />}>
        {project.coverAssetId ? 'Regenerate cover' : 'Generate cover'}
      </Button>
      {dialog}
    </Card>
  );
}
