import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { CircleAlert, Download, Save } from 'lucide-react';
import { layoutPoster, POSTER_FORMAT_IDS, POSTER_FORMATS, posterFiles, posterInputHash, posterReadiness, type PosterFormatId, type PosterLayout } from '@az-studio/shared';
import { errorMessage } from '../../lib/api';
import { linkAdCall } from '../../lib/linkad';
import { openDownload, uploadFile } from '../../lib/media';
import { drawPoster, posterPng, usePosterFonts, usePosterImages, type PosterImages } from '../../lib/poster-canvas';
import { canvasMeasure } from '../../lib/text-canvas';
import { Badge, Button, cx, Notice } from '../../components/ui';
import { Panel } from '../linkad/common';
import type { StepProps } from '../linkad/LinkAdWorkspace';

/** One format drawn at full size and shown scaled: the same pixels the PNG export writes. */
function PosterCanvas({ layout, images, className }: { layout: PosterLayout; images: PosterImages; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (ctx) drawPoster(ctx, layout, images);
  }, [layout, images]);
  return <canvas ref={ref} width={layout.width} height={layout.height} className={cx('h-auto w-full rounded-xl border border-line', className)} aria-label={`Poster preview ${layout.format}`} />;
}

/**
 * Motion Poster Ad, step 2: the poster in each chosen format, laid out from the facts with the brand's colours, fonts
 * and logo and drawn in the browser with the real fonts. Saving checks the facts (stale kit entries, unconfirmed
 * prices, unsupported claims, figures against the approved facts), exports each format as a PNG of exactly its size
 * and uploads it through the ordinary asset path; the server records it against the hash of what it was drawn from.
 */
export function PosterStep(p: StepProps & { goFacts: () => void }) {
  const { editor, project } = p;
  const doc = editor.doc;
  const poster = doc.poster;
  const files = posterFiles(doc);
  const fonts = usePosterFonts(poster);
  const pics = usePosterImages([...files.photos, ...(files.logo ? [files.logo] : [])]);
  const [saving, setSaving] = useState<PosterFormatId | 'all' | null>(null);
  const readiness = useMemo(() => posterReadiness(doc), [doc]);
  const layouts = useMemo(() => {
    if (!poster) return [];
    void fonts.version; // re-measure once the fonts are loaded
    return poster.formats.map((format) => layoutPoster({ poster, brand: doc.ad.brand, format, photoAssetIds: files.photos, logoAssetId: files.logo, measure: canvasMeasure }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poster, doc.ad.brand, files.photos.join(','), files.logo, fonts.version]);
  if (!poster) return <Notice tone="warning">This ad has no poster.</Notice>;

  const blocking = readiness.filter((i) => i.severity === 'error');
  const toggleFormat = (f: PosterFormatId) =>
    editor.update((d) => {
      if (!d.poster) return d;
      const has = d.poster.formats.includes(f);
      const formats = has ? d.poster.formats.filter((x) => x !== f) : POSTER_FORMAT_IDS.filter((x) => x === f || d.poster!.formats.includes(x));
      return formats.length ? { ...d, poster: { ...d.poster, formats } } : d;
    });

  const save = async (only?: PosterFormatId) => {
    setSaving(only ?? 'all');
    try {
      await editor.flush();
      for (const layout of layouts.filter((l) => !only || l.format === only)) {
        const errors = layout.issues.filter((i) => i.severity === 'error');
        if (errors.length) throw new Error(`${layout.format}: ${errors.map((e) => e.message).join(' ')}`);
        if (pics.error) throw new Error(`A photo could not be loaded, so the poster would be incomplete: ${pics.error}`);
        const hash = posterInputHash(doc, layout.format);
        const file = await posterPng(layout, pics.images, project.title);
        const assetId = await uploadFile(file, { kind: 'image', projectId: project.id, title: `${project.title} · poster ${layout.format}`.slice(0, 160), collections: ['poster', `poster:${layout.format}`] });
        await linkAdCall({ op: 'savePoster', projectId: project.id, format: layout.format, assetId, hash });
      }
      toast.success(only ? `Poster ${only} saved` : 'Posters saved', { description: 'Download them below, or use them in the motion ad.' });
    } catch (e) {
      toast.error('Could not save the poster', { description: errorMessage(e) });
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="space-y-6">
      <Panel
        title="Poster"
        sub="Drawn from the facts with the brand's colours, fonts and logo. The preview is the export: the saved PNG is these pixels."
        action={
          <div className="flex flex-wrap gap-2">
            <Button onClick={p.goFacts}>Edit the facts</Button>
            <Button variant="primary" icon={<Save className="size-4" />} loading={saving === 'all'} disabled={Boolean(saving) || blocking.length > 0 || pics.loading} onClick={() => void save()}>
              Save {poster.formats.length > 1 ? 'all formats' : 'the poster'}
            </Button>
          </div>
        }
      >
        <div className="flex flex-wrap gap-2">
          {POSTER_FORMAT_IDS.map((f) => (
            <label key={f} className={cx('inline-flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-xs', poster.formats.includes(f) ? 'border-accent/60 bg-accent/10 text-fg' : 'border-line text-dim')}>
              <input type="checkbox" checked={poster.formats.includes(f)} onChange={() => toggleFormat(f)} /> {POSTER_FORMATS[f].label}
            </label>
          ))}
        </div>
        {fonts.missing.length > 0 && <Notice tone="warning">This browser does not have {fonts.missing.join(', ')}, so the poster would be drawn with a fallback font. Choose Inter or EB Garamond in the brand kit, or upload the font file there.</Notice>}
        {pics.error && <Notice tone="danger">A photo could not be loaded: {pics.error}</Notice>}
        {blocking.length > 0 && (
          <Notice tone="danger">
            <p className="font-medium">Fix these before saving:</p>
            <ul className="mt-1 space-y-0.5 text-xs">
              {blocking.slice(0, 8).map((i, k) => (
                <li key={k}>{i.message}</li>
              ))}
            </ul>
          </Notice>
        )}
      </Panel>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
        {layouts.map((layout) => {
          const saved = poster.exports[layout.format];
          const current = saved && saved.hash === posterInputHash(doc, layout.format);
          return (
            <section key={layout.format} className="card space-y-3 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium text-fg">{POSTER_FORMATS[layout.format].label}</p>
                {saved ? <Badge tone={current ? 'success' : 'warning'}>{current ? 'Saved' : 'Out of date'}</Badge> : <Badge>Not saved</Badge>}
              </div>
              <PosterCanvas layout={layout} images={pics.images} className="mx-auto max-w-[360px]" />
              {layout.issues.length > 0 && (
                <ul className="space-y-1">
                  {layout.issues.map((i, k) => (
                    <li key={k} className="flex gap-1.5 text-xs text-dim">
                      <CircleAlert className={cx('mt-0.5 size-3.5 shrink-0', i.severity === 'error' ? 'text-danger' : 'text-warning')} aria-hidden />
                      {i.message}
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" loading={saving === layout.format} disabled={Boolean(saving) || blocking.length > 0 || pics.loading || layout.issues.some((i) => i.severity === 'error')} onClick={() => void save(layout.format)}>
                  {current ? 'Save again' : 'Save this format'}
                </Button>
                {saved && (
                  <Button size="sm" variant="subtle" icon={<Download className="size-3.5" />} onClick={() => void openDownload(saved.assetId)}>
                    Download PNG
                  </Button>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
