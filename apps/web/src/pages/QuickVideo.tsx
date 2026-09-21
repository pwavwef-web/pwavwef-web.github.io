import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Film, Sparkles, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import { compileShotPrompt, EMPTY_DIRECTIONS, estimateVideo, inferVideoTask, planOmniMedia, sumEstimates, type JobRequest, type OmniMediaRef, type ProjectDoc, type ShotDirections } from '@az-studio/shared';
import type { WithId } from '../lib/data';
import { useBoot } from '../lib/session';
import { useAiRun } from '../lib/ai';
import { ChainList, ChainView, useChains } from '../components/chain';
import { EstimateText, useJobSubmitter } from '../components/jobs';
import { ProjectHeader } from '../components/project-header';
import { AudioNotice, DirectionsEditor, PromptPreview, ReferenceSlots, VideoModelControls, type VideoSettings } from '../components/video-controls';
import { Badge, Button, Card, cx, EmptyState, Field, SectionHeader, Skeleton, Textarea } from '../components/ui';

export default function QuickVideo({ project }: { project?: WithId<ProjectDoc> }) {
  const boot = useBoot();
  const caps = boot?.capabilities.video;
  const projectId = project?.id ?? null;
  const [description, setDescription] = useState('');
  const [directions, setDirections] = useState<ShotDirections>({ ...EMPTY_DIRECTIONS });
  const [showDirections, setShowDirections] = useState(true);
  const [media, setMedia] = useState<OmniMediaRef[]>([]);
  const [override, setOverride] = useState<string | null>(null);
  const [settings, setSettings] = useState<VideoSettings>({ aspectRatio: project?.format.aspectRatio === '9:16' ? '9:16' : '16:9', resolution: boot?.settings.defaultVideoResolution ?? '720p', durationSec: 6, takes: 1 });
  const [selected, setSelected] = useState<string | null>(null);
  const chains = useChains('video', projectId);
  const { submit, busy, dialog } = useJobSubmitter();
  const polish = useAiRun(projectId);

  useEffect(() => {
    if (!selected && chains.data[0]) setSelected(chains.data[0].id);
  }, [chains.data, selected]);

  const planned = useMemo(() => planOmniMedia(media), [media]);
  const compiled = useMemo(
    () =>
      compileShotPrompt(directions, {
        description,
        styleBible: project?.styleBible ?? null,
        others: planned.media.filter((m) => m.role === 'image_ref' || m.role === 'video_ref').map((m) => ({ tag: m.tag, name: m.label ?? 'reference' })),
      }),
    [directions, description, project?.styleBible, planned.media],
  );
  const body = override ?? compiled;
  const task = inferVideoTask(media, false);
  const estimate = useMemo(() => {
    if (!boot || !caps) return null;
    const one = estimateVideo({ resolution: settings.resolution, outputSeconds: settings.durationSec, promptChars: body.length + planned.declaration.length, imageInputs: planned.media.filter((m) => m.kind === 'image').length, videoInputSeconds: 0, task: task ?? 'mixed' }, boot.pricing);
    return settings.takes > 1 ? sumEstimates(Array(settings.takes).fill(one), boot.pricing) : one;
  }, [boot, caps, settings, body, planned, task]);

  if (!boot || !caps) return <Skeleton className="h-96" />;

  const canSubmit = (description.trim() || directions.action.trim() || override?.trim()) && body.trim();
  const generate = async () => {
    const job: JobRequest = {
      type: 'video.generate',
      projectId,
      mode: 'generate',
      prompt: body,
      aspectRatio: settings.aspectRatio,
      resolution: settings.resolution,
      durationSec: settings.durationSec,
      media,
      characterIds: [],
      title: (description || directions.action).slice(0, 80) || 'Quick video',
    };
    const ids = await submit(Array(settings.takes).fill(job), { label: `Quick video · ${settings.takes} take${settings.takes > 1 ? 's' : ''}` });
    if (ids) setSelected(null);
  };

  const polishPrompt = async () => {
    const out = await polish.run<{ prompt: string; notes: string }>('prompt.polish', { prompt: body, kind: 'video' }, 'Polish video prompt');
    if (out?.prompt) {
      setOverride(out.prompt);
      toast.success('Prompt polished', { description: out.notes?.slice(0, 160) });
    }
  };

  return (
    <div className="space-y-8">
      {project ? <ProjectHeader project={project} /> : <SectionHeader eyebrow="Create" title={<span className="text-5xl">Quick Video</span>} sub={`${caps.displayName} · text, frames and references to a finished clip with sound.`} />}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-5">
          <Card className="space-y-5 p-5">
            <Field label="What happens in the shot?" htmlFor="qv-desc">
              <Textarea id="qv-desc" rows={4} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="A drummer in a sunlit Accra courtyard kicks into a highlife rhythm while children dance around him." />
            </Field>
            <button type="button" className="flex w-full cursor-pointer items-center justify-between text-left" onClick={() => setShowDirections((v) => !v)} aria-expanded={showDirections}>
              <span className="eyebrow">Direction · camera, light, performance, sound</span>
              <ChevronDown className={cx('size-4 text-faint transition-transform', showDirections && 'rotate-180')} />
            </button>
            {showDirections && <DirectionsEditor value={directions} onChange={setDirections} />}
          </Card>
          <Card className="space-y-4 p-5">
            <p className="eyebrow">Reference media</p>
            <ReferenceSlots caps={caps} media={media} onChange={setMedia} projectId={projectId} />
          </Card>
          <Card className="space-y-5 p-5">
            <div className="flex items-center justify-between">
              <p className="eyebrow">Output</p>
              <Badge tone="accent">{caps.displayName}</Badge>
            </div>
            <VideoModelControls caps={caps} value={settings} onChange={setSettings} />
            <PromptPreview declaration={planned.declaration} body={body} override={override} onOverride={setOverride} />
            <AudioNotice />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <EstimateText estimate={estimate} />
                {task && <Badge>{task.replace(/_/g, ' ')}</Badge>}
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" loading={polish.busy} disabled={!body.trim()} onClick={() => void polishPrompt()} icon={<Wand2 className="size-4" />}>
                  Polish prompt
                </Button>
                <Button variant="primary" loading={busy} disabled={!canSubmit} onClick={() => void generate()} icon={<Sparkles className="size-4" />}>
                  Generate {settings.takes > 1 ? `${settings.takes} takes` : ''}
                </Button>
              </div>
            </div>
          </Card>
        </div>
        <div className="space-y-5">
          <SectionHeader eyebrow="Results" title="Takes & edit chains" />
          {chains.loading ? (
            <Skeleton className="aspect-video" />
          ) : chains.data.length === 0 ? (
            <EmptyState icon={<Film className="size-5" />} title="No clips yet" body="Generated clips appear here. Each one opens as a conversation you can keep editing." />
          ) : (
            <>
              {selected && <ChainView key={selected} chainId={selected} kind="video" projectId={projectId} />}
              <ChainList chains={chains.data} selected={selected} onSelect={setSelected} />
            </>
          )}
        </div>
      </div>
      {dialog}
      {polish.dialog}
    </div>
  );
}
