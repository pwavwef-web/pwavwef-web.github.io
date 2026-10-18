import { useState } from 'react';
import { toast } from 'sonner';
import { Copy } from 'lucide-react';
import { EMBED_HEIGHT_PX, PLAYER_THEMES, PLAYER_THEME_SYNC, PUBLIC_PLAYER_ORIGIN, azStudioEmbedHtml, fmtClock, playerEmbedUrl, playerUrl, type NarratorEditionDoc, type NarratorExportDoc, type PlayerTheme } from '@az-studio/shared';
import { errorMessage } from '../../lib/api';
import { nar, type WithId } from '../../lib/narrator';
import { Badge, Button, ConfirmDialog, Field, Input, Notice } from '../../components/ui';

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied.`);
  } catch {
    toast.error('Copy failed — select the text and copy it manually.');
  }
}

/**
 * Publishing through AZ Studio's hosted player: one reviewed export becomes playable at a permanent link.
 * Later edits and exports stay drafts until published; the link and embed never change.
 */
export function PublishPanel({ editionId, title, publication, exports }: { editionId: string; title: string; publication: NarratorEditionDoc['publication']; exports: WithId<NarratorExportDoc>[] }) {
  const ready = exports.filter((x) => x.status === 'ready');
  const [choice, setChoice] = useState('');
  const [confirm, setConfirm] = useState<'publish' | 'unpublish' | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  const [theme, setTheme] = useState<PlayerTheme>('light');
  const [sync, setSync] = useState(false);
  const selected = ready.find((x) => x.id === choice) ?? ready[0] ?? null;
  const live = publication?.status === 'published';
  const publicId = publication?.publicId ?? null;
  const link = publicId ? playerUrl(publicId) : '';
  const embed = publicId ? azStudioEmbedHtml(publicId, title, { theme }) : '';
  const localPreview = publicId ? playerEmbedUrl(publicId, { origin: window.location.origin, theme }) : '';
  const newer = live && ready[0] && ready[0].id !== publication?.exportId ? ready[0] : null;

  const run = async (op: 'publish' | 'unpublish') => {
    setBusy(true);
    try {
      if (op === 'publish' && selected) {
        const r = await nar<{ revision: number; unchanged: boolean }>('publish', { editionId, exportId: selected.id, reviewed: true });
        toast.success(r.unchanged ? 'That export is already the published version.' : `Published — revision ${r.revision}. The link and embed stay the same.`);
      } else if (op === 'unpublish') {
        await nar('unpublish', { editionId });
        toast.success('Withdrawn. The player now says the audio is no longer available.');
      }
      setConfirm(null);
      setReviewed(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="pub-h" className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 id="pub-h" className="eyebrow">
          Publish
        </h2>
        {live ? <Badge tone="success">Live · revision {publication!.revision}</Badge> : publication?.status === 'unpublished' ? <Badge tone="warning">Withdrawn</Badge> : <Badge>Not published</Badge>}
      </div>
      <p className="text-[13px] text-dim">
        {live
          ? `The public player serves export v${publication!.exportVersion}${publication!.publishedAt ? `, published ${new Date(publication!.publishedAt).toLocaleString()}` : ''}. Edits and new exports stay drafts until you publish them.`
          : 'Publishing makes one reviewed export playable at a permanent AZ Studio link. Drafts, takes, the WAV master, your recordings and your voice stay private.'}
      </p>
      {newer && (
        <Notice tone="accent">
          Export v{newer.version} is newer than the published v{publication!.exportVersion}. Listen to it, then publish it to replace the public version at the same link.
        </Notice>
      )}
      {ready.length ? (
        <div className="flex flex-wrap items-center gap-2">
          <select className="field w-auto py-1.5 text-sm" value={selected?.id ?? ''} onChange={(e) => setChoice(e.target.value)} aria-label="Export to publish">
            {ready.map((x) => (
              <option key={x.id} value={x.id}>
                Export v{x.version} · {fmtClock(x.durationSec ?? 0)}
                {x.id === publication?.exportId && live ? ' (published)' : ''}
              </option>
            ))}
          </select>
          <Button size="sm" variant="primary" disabled={!selected || busy} onClick={() => setConfirm('publish')}>
            {live ? 'Publish update' : 'Publish audio'}
          </Button>
          {live && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm('unpublish')}>
              Unpublish
            </Button>
          )}
        </div>
      ) : (
        <p className="text-xs text-faint">Export the edition and listen to it before publishing.</p>
      )}
      {publicId && live && (
        <div className="space-y-2.5">
          <Field label="Listening link" htmlFor="pub-link">
            <div className="flex gap-1.5">
              <Input id="pub-link" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
              <Button size="sm" variant="secondary" icon={<Copy className="size-3.5" />} onClick={() => void copy(link, 'Listening link')}>
                Copy listening link
              </Button>
            </div>
          </Field>
          <Field label="Player theme" htmlFor="pub-theme">
            <select id="pub-theme" className="field w-auto py-1.5 text-sm" value={theme} onChange={(e) => setTheme(e.target.value as PlayerTheme)}>
              {PLAYER_THEMES.map((t) => (
                <option key={t} value={t}>
                  {t === 'light' ? 'Light — The Pwavwe Papers (default)' : t === 'dark' ? 'Dark — navy' : 'Auto — follow the reader’s system setting'}
                </option>
              ))}
            </select>
          </Field>
          <p className="text-xs text-faint">An iframe does not inherit the blog’s own light/dark button, so the embed asks for one theme. “Auto” follows the reader’s device, not the blog.</p>
          <Field label="Blogger embed — paste in the post’s HTML view, under the title" htmlFor="pub-embed">
            <textarea id="pub-embed" readOnly value={embed} rows={8} className="field font-mono text-[11.5px]" onFocus={(e) => e.currentTarget.select()} />
          </Field>
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="secondary" icon={<Copy className="size-3.5" />} onClick={() => void copy(embed, 'Blogger embed')}>
              Copy Blogger embed
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPreview(!preview)} aria-expanded={preview}>
              {preview ? 'Hide preview' : 'Preview embed'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSync(!sync)} aria-expanded={sync}>
              {sync ? 'Hide theme sync' : 'Blogger theme sync (optional)'}
            </Button>
          </div>
          {preview && (
            <div className="space-y-1.5">
              <iframe src={localPreview} title={`Preview of the public player for ${title}`} className="block w-full rounded-xl border-0" style={{ height: EMBED_HEIGHT_PX }} loading="lazy" />
              <p className="text-xs text-faint">
                Preview inside AZ Studio{localPreview.startsWith(PUBLIC_PLAYER_ORIGIN) ? '' : ' (served by this local server — the copied code points to the live studio domain)'}. It is not proof that Blogger embedding works: check the published post after pasting.
              </p>
            </div>
          )}
          {sync && (
            <div className="space-y-1.5">
              <p className="text-xs text-dim">
                Optional and separate from the post: paste this once in the Blogger <strong>theme</strong> (Theme → Edit HTML, before <code>&lt;/body&gt;</code>). It keeps embedded players on the blog’s own light/dark setting and sizes each iframe to its player. Posts work without it.
              </p>
              <textarea readOnly value={PLAYER_THEME_SYNC} rows={8} className="field font-mono text-[11.5px]" onFocus={(e) => e.currentTarget.select()} />
              <Button size="sm" variant="secondary" icon={<Copy className="size-3.5" />} onClick={() => void copy(PLAYER_THEME_SYNC, 'Theme sync snippet')}>
                Copy theme sync snippet
              </Button>
            </div>
          )}
        </div>
      )}
      <ConfirmDialog
        open={confirm === 'publish'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={live ? 'Publish this update?' : 'Publish this audio?'}
        confirmLabel={live ? 'Publish update' : 'Publish audio'}
        loading={busy}
        confirmDisabled={!reviewed}
        onConfirm={() => void run('publish')}
        body={
          <div className="space-y-2">
            <p>
              Export v{selected?.version} becomes playable by anyone with the link{live ? ', replacing the current version at the same URL' : ''}. Public: title, author, publication date, article link, section titles, a waveform and a compressed MP3 listening copy.
            </p>
            <p>Not public: the WAV master, the script, takes, transcript, your recordings and your voice.</p>
          </div>
        }
      >
        <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm text-dim">
          <input type="checkbox" className="mt-1 accent-[#4c8dff]" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} />I have listened to export v{selected?.version} and approve it for publication.
        </label>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === 'unpublish'}
        onOpenChange={(o) => !o && setConfirm(null)}
        danger
        title="Unpublish this audio?"
        confirmLabel="Unpublish"
        loading={busy}
        onConfirm={() => void run('unpublish')}
        body="The player at this link will say the audio is no longer available. AZ Studio stops serving the audio at once; cached page data expires within about a minute. Copies listeners already downloaded cannot be recalled. You can publish again later at the same link."
      />
    </section>
  );
}
