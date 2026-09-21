import { useMemo, useState } from 'react';
import { collection, orderBy, query, where } from 'firebase/firestore';
import { Captions, Plus, Type } from 'lucide-react';
import type { AssetDoc } from '@az-studio/shared';
import { db } from '../../lib/firebase';
import { useQuery } from '../../lib/data';
import { useUid } from '../../lib/session';
import { acceptFor, AssetThumb, UploadZone } from '../../components/media';
import { Button, Input, Segmented, Skeleton } from '../../components/ui';
import { ASSET_MIME, type DroppedAsset } from './Tracks';

export function MediaBin({ projectId, onAdd, onAddText }: { projectId: string; onAdd: (a: DroppedAsset) => void; onAddText: (kind: 'caption' | 'title') => void }) {
  const uid = useUid();
  const [kind, setKind] = useState<'video' | 'image' | 'audio'>('video');
  const [scope, setScope] = useState<'project' | 'all'>('project');
  const [search, setSearch] = useState('');
  const live = useQuery<AssetDoc>(
    () => (uid ? (scope === 'project' ? query(collection(db, 'assets'), where('ownerUid', '==', uid), where('projectId', '==', projectId), where('kind', '==', kind), orderBy('createdAt', 'desc')) : query(collection(db, 'assets'), where('ownerUid', '==', uid), where('kind', '==', kind), orderBy('createdAt', 'desc'))) : null),
    [uid, projectId, kind, scope],
  );
  const items = useMemo(() => live.data.filter((a) => a.status === 'ready' && (!search || a.title.toLowerCase().includes(search.toLowerCase()))), [live.data, search]);
  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b border-line p-3">
        <Segmented label="Media kind" size="sm" value={kind} onChange={setKind} options={[{ value: 'video', label: 'Video' }, { value: 'image', label: 'Images' }, { value: 'audio', label: 'Audio' }]} />
        <div className="flex gap-2">
          <Segmented label="Scope" size="sm" value={scope} onChange={setScope} options={[{ value: 'project', label: 'Project' }, { value: 'all', label: 'All' }]} />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search" className="!py-1 text-xs" aria-label="Search media" />
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" icon={<Captions className="size-3.5" />} onClick={() => onAddText('caption')}>
            Caption
          </Button>
          <Button size="sm" variant="ghost" icon={<Type className="size-3.5" />} onClick={() => onAddText('title')}>
            Title card
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        <UploadZone compact accept={acceptFor([kind])} kind={kind} projectId={projectId} label={`Upload ${kind}`} />
        {live.loading ? (
          <Skeleton className="aspect-video" />
        ) : items.length === 0 ? (
          <p className="py-6 text-center text-xs text-faint">No {kind} here yet.</p>
        ) : (
          items.map((a) => {
            const payload: DroppedAsset = { assetId: a.id, kind: a.kind as DroppedAsset['kind'], durationSec: a.durationSec ?? null, title: a.title };
            return (
              <div key={a.id} draggable onDragStart={(e) => e.dataTransfer.setData(ASSET_MIME, JSON.stringify(payload))} className="group relative">
                {a.kind === 'audio' ? (
                  <div className="rounded-xl border border-line bg-violet/10 px-3 py-2.5">
                    <p className="truncate text-xs text-fg">{a.title}</p>
                    <p className="text-[10px] text-faint">{a.durationSec ? `${a.durationSec.toFixed(1)}s` : ''}</p>
                  </div>
                ) : (
                  <AssetThumb asset={a} hoverPlay={false} />
                )}
                <button type="button" onClick={() => onAdd(payload)} aria-label={`Add ${a.title} at playhead`} className="absolute top-1.5 right-1.5 z-20 grid size-7 cursor-pointer place-items-center rounded-lg bg-black/70 text-fg opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100">
                  <Plus className="size-4" />
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
