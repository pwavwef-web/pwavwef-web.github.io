import { useMemo, useState } from 'react';
import { collection, orderBy, query, where } from 'firebase/firestore';
import { Palette, Sparkles } from 'lucide-react';
import { estimateImage, sumEstimates, type AssetDoc, type ProjectDoc } from '@az-studio/shared';
import { db } from '../../lib/firebase';
import { useQuery, type WithId } from '../../lib/data';
import { useBoot, useUid } from '../../lib/session';
import { EstimateText, useJobSubmitter } from '../../components/jobs';
import { AssetThumb } from '../../components/media';
import { StyleBibleEditor } from '../../components/style-bible';
import { Button, Card, EmptyState, Field, Select, Slider, Textarea } from '../../components/ui';

export function LookbookTab({ project }: { project: WithId<ProjectDoc> }) {
  const boot = useBoot();
  const uid = useUid();
  const [theme, setTheme] = useState('');
  const [count, setCount] = useState(4);
  const [aspect, setAspect] = useState('21:9');
  const { submit, busy, dialog } = useJobSubmitter();
  const frames = useQuery<AssetDoc>(() => (uid ? query(collection(db, 'assets'), where('ownerUid', '==', uid), where('projectId', '==', project.id), where('collections', 'array-contains', 'lookbook'), orderBy('createdAt', 'desc')) : null), [uid, project.id]);
  const size = boot?.settings.defaultImageSize ?? '2K';
  const estimate = useMemo(() => (boot ? sumEstimates(Array(count).fill(estimateImage({ imageSize: size, referenceImages: 0, promptChars: 900, outputs: 1 }, boot.pricing)), boot.pricing) : null), [boot, count, size]);
  const t = project.treatment;
  const generate = async () => {
    const base = [theme || 'Key moments that define the film’s visual language', t?.logline && `Film: ${t.logline}`, t?.visualStyle && `Look: ${t.visualStyle}`, t?.palette?.length && `Palette: ${t.palette.join(', ')}`].filter(Boolean).join('. ');
    const angles = ['a wide establishing image', 'an intimate character close-up', 'a moment of tension or conflict', 'a texture and colour study', 'a night exterior', 'a light-and-shadow study', 'the emotional climax', 'the final image'];
    await submit(
      Array.from({ length: count }, (_, i) => ({
        type: 'image.generate' as const,
        projectId: project.id,
        prompt: `${base}. Frame ${i + 1}: ${angles[i % angles.length]}.`,
        purpose: 'lookbook' as const,
        aspectRatio: aspect,
        imageSize: size,
        referenceAssetIds: [],
        grounding: false,
        applyStyleBible: true,
        characterIds: [],
        collections: ['lookbook'],
        target: { kind: 'lookbook' as const, id: project.id },
        title: `Lookbook ${i + 1}`,
      })),
      { label: `Lookbook · ${count} frames`, alwaysConfirm: count > 1 },
    );
  };
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="space-y-5">
        <Card className="flex flex-wrap items-end gap-4 p-5">
          <Field label="Lookbook direction" className="min-w-64 flex-1">
            <Textarea rows={2} value={theme} onChange={(e) => setTheme(e.target.value)} placeholder="e.g. Harmattan haze over Tamale, brass instruments glinting, dusk light" />
          </Field>
          <Field label="Frame" className="w-28">
            <Select value={aspect} onChange={(e) => setAspect(e.target.value)}>
              {(boot?.capabilities.image.aspectRatios ?? []).map((a) => (
                <option key={a}>{a}</option>
              ))}
            </Select>
          </Field>
          <Field label={`Frames: ${count}`} className="w-40">
            <Slider label="Frames" min={1} max={8} step={1} value={count} onChange={setCount} />
          </Field>
          <div className="flex items-center gap-3">
            <EstimateText estimate={estimate} />
            <Button variant="primary" loading={busy} onClick={() => void generate()} icon={<Sparkles className="size-4" />}>
              Generate lookbook
            </Button>
          </div>
        </Card>
        {frames.data.length === 0 ? (
          <EmptyState icon={<Palette className="size-5" />} title="No lookbook frames yet" body="Generate frames that define palette, lensing, lighting and texture — they become the film’s visual contract." />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {frames.data.map((a) => (
              <AssetThumb key={a.id} asset={a} aspect="aspect-[21/9]" />
            ))}
          </div>
        )}
      </div>
      <StyleBibleEditor project={project} />
      {dialog}
    </div>
  );
}
