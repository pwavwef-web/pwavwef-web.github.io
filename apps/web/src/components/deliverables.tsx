import { useEffect, useState } from 'react';
import { collection, query } from 'firebase/firestore';
import { toast } from 'sonner';
import { Download, PackageCheck, RefreshCw } from 'lucide-react';
import { PACK_PRESET_LABELS, PACK_PRESETS, type JobRequest, type PackDoc, type PackPreset, type ProjectDoc, type TimelineDoc } from '@az-studio/shared';
import { db } from '../lib/firebase';
import { useQuery } from '../lib/data';
import { api, errorMessage } from '../lib/api';
import { useJobSubmitter } from './jobs';
import { Badge, Button, Card, Field, Input, Select, Skeleton, Toggle } from './ui';

const STATUS: Record<PackDoc['status'], { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' }> = {
  rendering: { label: 'Rendering', tone: 'neutral' },
  waiting_checks: { label: 'Export checks', tone: 'neutral' },
  blocked: { label: 'Check blocked', tone: 'warning' },
  assembling: { label: 'Packing', tone: 'neutral' },
  ready: { label: 'Ready', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
};

/** Songs and approved soundtracks keep their mastered level; everything else is normalised like any final render. */
const PRESERVE_TYPES = new Set(['short_ad', 'link_ad', 'mv_lite', 'music_video']);

/** One-click deliverables pack: every format from one edit, with poster, thumbnails, captions and a read-me, each file verified. */
export function DeliverablesCard({ projects }: { projects: (ProjectDoc & { id: string })[] }) {
  const [projectId, setProjectId] = useState('');
  const timelines = useQuery<TimelineDoc>(() => (projectId ? query(collection(db, 'projects', projectId, 'timelines')) : null), [projectId]);
  const [timelineId, setTimelineId] = useState('');
  const [presets, setPresets] = useState<PackPreset[]>(['vertical_9x16', 'portrait_4x5', 'square_1x1', 'youtube_16x9']);
  const [posterAt, setPosterAt] = useState('');
  const [packs, setPacks] = useState<PackDoc[] | null>(null);
  const [busy, setBusy] = useState(false);
  const { submit, dialog } = useJobSubmitter();
  const project = projects.find((p) => p.id === projectId);

  const reload = async () => {
    try {
      setPacks((await api<{ packs: PackDoc[] }, 'deliverables'>('deliverables', { op: 'list' })).packs);
    } catch (e) {
      toast.error('Could not load packs', { description: errorMessage(e) });
    }
  };
  useEffect(() => {
    void reload();
  }, []);
  useEffect(() => {
    if (!timelines.data.some((t) => t.id === timelineId)) setTimelineId(timelines.data[0]?.id ?? '');
  }, [timelines.data, timelineId]);

  const start = async () => {
    if (!project || !timelineId || !presets.length) return;
    setBusy(true);
    try {
      const r = await api<{ pack: PackDoc; jobs: JobRequest[] }, 'deliverables'>('deliverables', { op: 'create', projectId, timelineId, presets, audioMaster: PRESERVE_TYPES.has(String(project.type)) ? 'preserve' : 'normalize', ...(posterAt !== '' ? { posterAtSec: Math.max(0, Number(posterAt)) } : {}) });
      const ids = await submit(r.jobs, { label: `${project.title} · deliverables pack`, alwaysConfirm: true });
      if (ids) toast.success('Pack started', { description: 'Each format renders and passes its export check, then the pack is built.' });
      await reload();
    } catch (e) {
      toast.error('Could not start the pack', { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const download = async (id: string) => {
    try {
      const { url } = await api<{ url: string }, 'deliverables'>('deliverables', { op: 'download', packId: id });
      window.location.assign(url);
    } catch (e) {
      toast.error('Could not download', { description: errorMessage(e) });
    }
  };
  const advance = async (id: string) => {
    try {
      await api('deliverables', { op: 'advance', packId: id });
      await reload();
    } catch (e) {
      toast.error('Could not refresh the pack', { description: errorMessage(e) });
    }
  };

  return (
    <Card className="space-y-4 p-6">
      {dialog}
      <div>
        <p className="eyebrow flex items-center gap-1.5">
          <PackageCheck className="size-3.5" /> Deliverables pack
        </p>
        <p className="mt-1 text-sm text-dim">Every format from one edit, plus a poster, thumbnails, captions and a read-me. Each video is a final render with its export check; the pack then verifies frame count, length, sound, loudness and peak of every file.</p>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Field label="Project">
          <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">Choose a project…</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Edit (timeline)">
          <Select value={timelineId} disabled={!projectId} onChange={(e) => setTimelineId(e.target.value)}>
            {timelines.data.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} · {Math.round(t.durationSec)} s
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Poster at (seconds, optional)">
          <Input type="number" min={0} step={0.5} value={posterAt} onChange={(e) => setPosterAt(e.target.value)} />
        </Field>
      </div>
      <div className="flex flex-wrap gap-4">
        {PACK_PRESETS.map((p) => (
          <Toggle key={p} label={PACK_PRESET_LABELS[p]} checked={presets.includes(p)} onChange={(on: boolean) => setPresets(on ? [...presets, p] : presets.filter((x) => x !== p))} />
        ))}
      </div>
      <Button variant="primary" loading={busy} disabled={!timelineId || !presets.length} icon={<PackageCheck className="size-4" />} onClick={() => void start()}>
        Render the pack
      </Button>
      {!packs ? (
        <Skeleton className="h-16" />
      ) : (
        packs.length > 0 && (
          <ul className="divide-y divide-line rounded-xl border border-line">
            {packs.map((p) => (
              <li key={p.id} className="space-y-1.5 px-3.5 py-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-fg">
                    {p.title} <span className="text-xs text-faint">· {p.presets.map((x) => PACK_PRESET_LABELS[x]).join(', ')}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <Badge tone={STATUS[p.status].tone}>{STATUS[p.status].label}</Badge>
                    {p.status === 'ready' ? (
                      <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />} onClick={() => void download(p.id)}>
                        Download ({Math.max(1, Math.round((p.zip?.bytes ?? 0) / 1e6))} MB)
                      </Button>
                    ) : (
                      !['failed', 'assembling'].includes(p.status) && (
                        <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} onClick={() => void advance(p.id)}>
                          Check now
                        </Button>
                      )
                    )}
                  </span>
                </div>
                <p className="text-xs text-dim">{p.message}</p>
                {p.files
                  .filter((f) => f.issues.length)
                  .map((f) => (
                    <p key={f.name} className="text-xs text-warning">
                      {f.name}: {f.issues.join(' ')}
                    </p>
                  ))}
              </li>
            ))}
          </ul>
        )
      )}
    </Card>
  );
}
