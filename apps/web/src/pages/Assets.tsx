import { useMemo, useState } from 'react';
import { collection, doc, limit, orderBy, query, updateDoc, where } from 'firebase/firestore';
import { toast } from 'sonner';
import { Download, Layers, Star, Trash2 } from 'lucide-react';
import { type AssetDoc, type AssetKind } from '@az-studio/shared';
import { api, errorMessage } from '../lib/api';
import { db } from '../lib/firebase';
import { useQuery } from '../lib/data';
import { downloadUrl, useMediaUrls } from '../lib/media';
import { useUid } from '../lib/session';
import { useProjects } from '../lib/studio';
import { acceptFor, AssetMeta, AssetThumb, ImageView, UploadZone, VideoPlayer, type Asset } from '../components/media';
import { Button, ConfirmDialog, EmptyState, ErrorState, Field, Input, Modal, SectionHeader, Segmented, Select, Skeleton } from '../components/ui';

function AssetDetail({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const projects = useProjects({ status: 'active' });
  const [title, setTitle] = useState(asset.title);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const patch = async (p: Partial<AssetDoc>) => {
    try {
      await updateDoc(doc(db, 'assets', asset.id), p);
    } catch (e) {
      toast.error('Update failed', { description: errorMessage(e) });
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await api('deleteAsset', { assetId: asset.id });
      toast.success('Deleted');
      onClose();
    } catch (e) {
      toast.error('Could not delete', { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const download = async () => {
    const url = await downloadUrl(asset.id);
    if (url) window.open(url, '_blank', 'noopener');
  };
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={asset.title}
      size="xl"
      footer={
        <>
          <Button variant="danger" className="mr-auto" icon={<Trash2 className="size-4" />} onClick={() => setConfirm(true)}>
            Delete
          </Button>
          <Button icon={<Star className={asset.favorite ? 'size-4 fill-warning text-warning' : 'size-4'} />} onClick={() => void patch({ favorite: !asset.favorite })}>
            {asset.favorite ? 'Unfavourite' : 'Favourite'}
          </Button>
          <Button variant="primary" icon={<Download className="size-4" />} onClick={() => void download()} disabled={asset.status !== 'ready'}>
            Download original
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div>
          {asset.kind === 'video' ? (
            <VideoPlayer assetId={asset.id} />
          ) : asset.kind === 'image' ? (
            <ImageView assetId={asset.id} className="max-h-[60vh]" />
          ) : asset.kind === 'audio' ? (
            <AudioPlayer assetId={asset.id} />
          ) : (
            <p className="text-sm text-dim">Document — download to view.</p>
          )}
          {asset.generation?.prompt && (
            <div className="mt-4">
              <p className="eyebrow mb-1.5">Prompt</p>
              <pre className="max-h-48 overflow-auto rounded-xl border border-line bg-black/25 p-3 font-sans text-xs whitespace-pre-wrap text-dim">{asset.generation.prompt}</pre>
            </div>
          )}
        </div>
        <div className="space-y-4">
          <Field label="Title">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => title.trim() && title !== asset.title && void patch({ title: title.trim() })} />
          </Field>
          <Field label="Project">
            <Select value={asset.projectId ?? ''} onChange={(e) => void patch({ projectId: e.target.value || null })}>
              <option value="">No project</option>
              {projects.data.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </Select>
          </Field>
          <AssetMeta asset={asset} />
        </div>
      </div>
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Delete this file?" danger confirmLabel="Delete permanently" loading={busy} onConfirm={() => void remove()} body="The original and its thumbnails are removed from the private bucket. Timelines or shots that use it will show it as missing." />
    </Modal>
  );
}

function AudioPlayer({ assetId }: { assetId: string }) {
  const urls = useMediaUrls(assetId);
  return urls?.file ? <audio src={urls.file} controls className="w-full" /> : <Skeleton className="h-12" />;
}

export default function Assets() {
  const uid = useUid();
  const projects = useProjects();
  const [kind, setKind] = useState<AssetKind | 'all'>('all');
  const [source, setSource] = useState<'all' | 'upload' | 'generated' | 'render' | 'derived'>('all');
  const [fav, setFav] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [search, setSearch] = useState('');
  const [max, setMax] = useState(120);
  const [open, setOpen] = useState<Asset | null>(null);

  const live = useQuery<AssetDoc>(() => {
    if (!uid) return null;
    const parts = [where('ownerUid', '==', uid)];
    if (kind !== 'all') parts.push(where('kind', '==', kind));
    if (fav) parts.push(where('favorite', '==', true));
    if (projectId) parts.push(where('projectId', '==', projectId));
    return query(collection(db, 'assets'), ...parts, orderBy('createdAt', 'desc'), limit(max));
  }, [uid, kind, fav, projectId, max]);

  const items = useMemo(() => {
    const q = search.trim().toLowerCase();
    return live.data.filter((a) => (source === 'all' || a.source === source) && (!q || `${a.title} ${a.fileName} ${a.tags.join(' ')}`.toLowerCase().includes(q)));
  }, [live.data, source, search]);
  const current = open ? live.data.find((a) => a.id === open.id) ?? open : null;

  return (
    <div className="space-y-8">
      <SectionHeader eyebrow="Library" title={<span className="text-5xl">Assets</span>} sub="Every upload, generation and render — stored privately, served through short-lived signed links." />
      <UploadZone accept={acceptFor(['image', 'video', 'audio', 'document'])} projectId={projectId || null} label="Drop images, video, songs or lyric files" hint="Files are verified server-side before they appear." />
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label="Kind"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'all', label: 'All' },
            { value: 'image', label: 'Images' },
            { value: 'video', label: 'Video' },
            { value: 'audio', label: 'Audio' },
            { value: 'document', label: 'Documents' },
          ]}
        />
        <Segmented
          label="Source"
          size="sm"
          value={source}
          onChange={setSource}
          options={[
            { value: 'all', label: 'Any source' },
            { value: 'generated', label: 'Generated' },
            { value: 'upload', label: 'Uploaded' },
            { value: 'render', label: 'Renders' },
            { value: 'derived', label: 'Trims & frames' },
          ]}
        />
        <Button size="sm" variant={fav ? 'subtle' : 'ghost'} onClick={() => setFav((v) => !v)} icon={<Star className={fav ? 'size-3.5 fill-warning text-warning' : 'size-3.5'} />}>
          Favourites
        </Button>
        <Select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="!w-56" aria-label="Project">
          <option value="">All projects</option>
          {projects.data.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </Select>
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search titles and tags" className="ml-auto !w-64" aria-label="Search assets" />
      </div>
      {live.error ? (
        <ErrorState error={live.error} />
      ) : live.loading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {Array.from({ length: 10 }, (_, i) => (
            <Skeleton key={i} className="aspect-video" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState icon={<Layers className="size-5" />} title="Nothing matches" body="Upload media or generate something in a studio." />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
            {items.map((a) => (
              <AssetThumb key={a.id} asset={a} onClick={() => setOpen(a)} />
            ))}
          </div>
          {live.data.length >= max && (
            <div className="text-center">
              <Button onClick={() => setMax((m) => m + 120)}>Load more</Button>
            </div>
          )}
        </>
      )}
      {current && <AssetDetail asset={current} onClose={() => setOpen(null)} />}
    </div>
  );
}
