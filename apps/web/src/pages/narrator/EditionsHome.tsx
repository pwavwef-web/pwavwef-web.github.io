import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ArrowRight, AudioLines, CircleAlert, Download, Link2, Mic, Plus } from 'lucide-react';
import { NARRATOR, relativeTime, toMillis, type ExtractedArticle } from '@az-studio/shared';
import { errorMessage } from '../../lib/api';
import { nar, useEditions, useVoices } from '../../lib/narrator';
import { Badge, Button, cx, EmptyState, Field, Input, Modal, Notice, Segmented, Skeleton, Textarea } from '../../components/ui';

function VoiceLine() {
  const voices = useVoices();
  const usable = voices.data.filter((v) => v.status !== 'deleted');
  const approved = usable.find((v) => v.status === 'active' && v.approval.state === 'approved');
  const active = usable.find((v) => v.status === 'active');
  if (voices.loading) return <Skeleton className="h-6 w-72" />;
  if (approved)
    return (
      <p className="flex items-center gap-2 text-sm text-dim">
        <span className="size-2 rounded-full bg-success" aria-hidden /> Narrating as <span className="text-fg">{approved.displayName}</span> · approved
      </p>
    );
  return (
    <Notice tone={active ? 'warning' : 'accent'} icon={<Mic className="size-4" />}>
      {active ? 'Your voice is ready for an audition. Listen to a test and approve it before narrating editions.' : 'Start by creating your voice: record a short reference and the consent statement.'}{' '}
      <Link to="/narrator/voice" className="font-medium text-accent-2 underline-offset-2 hover:underline">
        Go to My Voice
      </Link>
    </Notice>
  );
}

export function NewEditionDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate();
  const [mode, setMode] = useState<'paste' | 'url'>('paste');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [date, setDate] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [opening, setOpening] = useState('');
  const [url, setUrl] = useState('');
  const [fetched, setFetched] = useState<(ExtractedArticle & { url: string }) | null>(null);
  const [busy, setBusy] = useState<'fetch' | 'create' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchUrl = async () => {
    setBusy('fetch');
    setError(null);
    setFetched(null);
    try {
      const r = await nar<ExtractedArticle & { url: string }>('importUrl', { url: url.trim() });
      setFetched(r);
      setTitle(r.title);
      setBody(r.body);
      setDate(r.publishedDate ?? '');
      setSourceUrl(r.url);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    setBusy('create');
    setError(null);
    try {
      const r = await nar<{ editionId: string; notes: string[] }>('editionCreate', {
        title: title.trim(),
        body,
        origin: mode === 'url' && fetched ? 'url' : opening.trim() ? 'package' : 'paste',
        sourceUrl: sourceUrl.trim() || null,
        publishedDate: date || null,
        existingOpening: opening.trim() || null,
        notes: fetched?.notes ?? [],
      });
      onOpenChange(false);
      navigate(`/narrator/e/${r.editionId}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const canCreate = title.trim().length > 0 && body.trim().length > 0 && (mode === 'paste' || Boolean(fetched));
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="Create audio edition"
      description="Paste the article, or import it from The Pwavwe Papers. The original text is kept separately from the narration script."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy === 'create'} disabled={!canCreate || busy !== null} onClick={() => void create()}>
            Create edition
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Segmented
          label="Source"
          value={mode}
          onChange={(m) => {
            setMode(m);
            setError(null);
          }}
          options={[
            { value: 'paste', label: 'Paste the article' },
            { value: 'url', label: 'Import from blogs.pwavwe.com' },
          ]}
        />
        {mode === 'url' && (
          <div className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <Field label="Article address" className="flex-1">
                <Input type="url" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://blogs.pwavwe.com/2026/10/…" onKeyDown={(e) => e.key === 'Enter' && url.trim() && void fetchUrl()} />
              </Field>
              <Button icon={<Link2 className="size-4" />} loading={busy === 'fetch'} disabled={!url.trim() || busy !== null} onClick={() => void fetchUrl()}>
                Fetch article
              </Button>
            </div>
            {fetched && (
              <Notice tone={fetched.confidence === 'high' ? 'success' : 'warning'} icon={fetched.confidence === 'high' ? undefined : <CircleAlert className="size-4" />}>
                <p>
                  {fetched.confidence === 'high' ? 'Article body found' : 'Please review this extraction'} · {fetched.words.toLocaleString()} words{fetched.container ? ` from ${fetched.container}` : ''}. Navigation, comments, scripts, image captions and share links were left out.
                </p>
                {fetched.notes.map((n) => (
                  <p key={n} className="mt-1">
                    {n}
                  </p>
                ))}
              </Notice>
            )}
          </div>
        )}
        {(mode === 'paste' || fetched) && (
          <>
            <Field label="Title">
              <Input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="The article’s title" />
            </Field>
            <Field label="Article" hint="Separate paragraphs with a blank line. Mark headings with ## (Markdown). Nothing is summarised or rewritten — cleanup is offered later as reviewable changes.">
              <Textarea rows={mode === 'url' ? 10 : 12} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Paste the full article here…" className="font-[450]" />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Publication date" hint="Optional — never guessed.">
                <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </Field>
              <Field label="Article URL" hint="Optional — used in the SoundCloud description.">
                <Input type="url" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="https://blogs.pwavwe.com/…" />
              </Field>
            </div>
            <details className="group rounded-xl border border-line px-4 py-3">
              <summary className="cursor-pointer text-sm text-dim group-open:text-fg">Already have an audio-edition opening?</summary>
              <Field label="Opening from the article package" hint="Used instead of the default opening, so the edition never gets two introductions." className="mt-3">
                <Textarea rows={3} value={opening} onChange={(e) => setOpening(e.target.value)} />
              </Field>
            </details>
          </>
        )}
        {error && (
          <p className="text-sm text-[#ff9b9b]" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

export default function EditionsHome() {
  const editions = useEditions();
  const [open, setOpen] = useState(false);
  const list = editions.data.filter((e) => !e.deleted);
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <VoiceLine />
        <Button variant="primary" size="lg" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>
          Create audio edition
        </Button>
      </div>
      <section aria-labelledby="recent-editions" className="space-y-3">
        <h2 id="recent-editions" className="eyebrow">
          Recent editions
        </h2>
        {editions.loading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-[72px]" />
            ))}
          </div>
        ) : editions.error ? (
          <Notice tone="danger">Editions could not be loaded: {editions.error.message}</Notice>
        ) : !list.length ? (
          <EmptyState icon={<AudioLines className="size-5" />} title="No audio editions yet" body={`Turn a paper from ${NARRATOR.publication} into an audio edition read in your own voice.`} action={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>Create audio edition</Button>} />
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line">
            {list.map((e) => (
              <li key={e.id}>
                <Link to={`/narrator/e/${e.id}`} className="group flex items-center gap-4 px-5 py-4 transition-colors hover:bg-white/[0.03]">
                  <div className="min-w-0 flex-1">
                    <p className="display truncate text-[22px] leading-tight text-fg">{e.title}</p>
                    <p className="mt-0.5 text-xs text-faint">
                      {e.publishedDate ? `Published ${e.publishedDate} · ` : ''}Updated {relativeTime(toMillis(e.updatedAt))}
                    </p>
                  </div>
                  <div className="hidden flex-wrap justify-end gap-1.5 sm:flex">
                    {e.lastExportId && (
                      <Badge tone="success" icon={<Download className="size-3" />}>
                        Exported
                      </Badge>
                    )}
                    {e.soundcloud?.link && <Badge tone="accent">On SoundCloud</Badge>}
                    {!e.voiceId && <Badge tone="warning">No voice</Badge>}
                  </div>
                  <ArrowRight className={cx('size-4 shrink-0 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-fg')} aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      <NewEditionDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}
