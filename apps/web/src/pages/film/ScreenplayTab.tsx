import { useEffect, useMemo, useRef, useState } from 'react';
import { collection, orderBy, query } from 'firebase/firestore';
import { toast } from 'sonner';
import { BookOpenText, Gauge, History, Plus, RotateCcw, Save, Scissors, Sparkles, Wand2 } from 'lucide-react';
import { estimateRuntimeMinutes, parseFountain, relativeTime, replaceRange, toMillis, type CharacterDoc, type FountainElement, type LocationDoc, type ProjectDoc, type ScriptDoc, type ScriptVersion } from '@az-studio/shared';
import { db } from '../../lib/firebase';
import { useAiRun } from '../../lib/ai';
import { useDebounced, useQuery, type WithId } from '../../lib/data';
import { addDocs, createScript, newCharacter, newLocation, saveScript, snapshotScript, useSub } from '../../lib/studio';
import { Badge, Button, Card, cx, EmptyState, Field, Input, Modal, Segmented, Select, Skeleton, Textarea } from '../../components/ui';

export function FountainPreview({ elements, className }: { elements: FountainElement[]; className?: string }) {
  return (
    <div className={cx('mx-auto max-w-[640px] font-mono text-[13px] leading-[1.55] text-[#dfe6f3]', className)}>
      {elements.map((el, i) => {
        switch (el.type) {
          case 'scene_heading':
            return (
              <p key={i} className="mt-6 mb-2 font-bold tracking-wide uppercase">
                {el.sceneNumber ? <span className="mr-3 text-faint">{el.sceneNumber}</span> : null}
                {el.text}
              </p>
            );
          case 'character':
            return (
              <p key={i} className="mt-4 ml-[38%] uppercase">
                {el.text}
              </p>
            );
          case 'parenthetical':
            return (
              <p key={i} className="ml-[30%] text-dim">
                {el.text}
              </p>
            );
          case 'dialogue':
            return (
              <p key={i} className="mr-[16%] ml-[22%]">
                {el.text}
              </p>
            );
          case 'transition':
            return (
              <p key={i} className="mt-4 text-right uppercase">
                {el.text}
              </p>
            );
          case 'centered':
            return (
              <p key={i} className="mt-4 text-center">
                {el.text}
              </p>
            );
          case 'section':
            return (
              <p key={i} className="mt-6 text-xs tracking-[0.2em] text-accent-2 uppercase">
                {el.text}
              </p>
            );
          case 'synopsis':
            return (
              <p key={i} className="text-xs text-faint italic">
                {el.text}
              </p>
            );
          case 'note':
            return (
              <p key={i} className="text-xs text-warning">
                [[{el.text}]]
              </p>
            );
          case 'lyric':
            return (
              <p key={i} className="ml-[22%] italic">
                ♪ {el.text}
              </p>
            );
          case 'page_break':
            return <hr key={i} className="my-6 border-line" />;
          default:
            return (
              <p key={i} className="mt-3">
                {el.text}
              </p>
            );
        }
      })}
    </div>
  );
}

interface StructureReport {
  summary: string;
  estimatedRuntimeMinutes: number;
  acts: { name: string; startScene: number; endScene: number; summary: string }[];
  beats: { name: string; scene: number; description: string }[];
  pacing: { sceneIndex: number; heading: string; assessment: 'slow' | 'balanced' | 'fast'; note: string }[];
  strengths: string[];
  issues: string[];
  suggestions: string[];
}

function StructureView({ report }: { report: StructureReport }) {
  return (
    <div className="space-y-5 text-sm">
      <p className="text-dim">{report.summary}</p>
      <div className="grid gap-4 md:grid-cols-3">
        {report.acts.map((a) => (
          <Card key={a.name} className="p-4">
            <p className="eyebrow">
              {a.name} · scenes {a.startScene}–{a.endScene}
            </p>
            <p className="mt-2 text-dim">{a.summary}</p>
          </Card>
        ))}
      </div>
      <div>
        <p className="eyebrow mb-2">Beats</p>
        <ul className="space-y-1.5">
          {report.beats.map((b, i) => (
            <li key={i}>
              <span className="text-accent-2">{b.name}</span> <span className="text-faint">· scene {b.scene}</span> <span className="text-dim">— {b.description}</span>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <p className="eyebrow mb-2">Pacing</p>
        <ul className="space-y-1">
          {report.pacing.map((p, i) => (
            <li key={i} className="flex gap-2">
              <Badge tone={p.assessment === 'balanced' ? 'success' : 'warning'}>{p.assessment}</Badge>
              <span className="text-dim">
                {p.sceneIndex}. {p.heading} — {p.note}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {(['strengths', 'issues', 'suggestions'] as const).map((k) => (
          <div key={k}>
            <p className="eyebrow mb-2">{k}</p>
            <ul className="list-disc space-y-1 pl-4 text-dim">
              {report[k].map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Extracts characters or locations from the latest screenplay into the bibles. */
export function useScreenplayExtract(project: WithId<ProjectDoc> | null) {
  const ai = useAiRun(project?.id ?? null);
  const scripts = useSub<ScriptDoc>(project?.id, 'scripts', 'updatedAt', 'desc');
  const characters = useSub<CharacterDoc>(project?.id, 'characters', 'name');
  const locations = useSub<LocationDoc>(project?.id, 'locations', 'name');
  const run = async (what: 'characters' | 'locations') => {
    if (!project) return;
    const fountain = scripts.data[0]?.content ?? '';
    const treatment = project.treatment?.body ?? '';
    if (!fountain.trim() && !treatment.trim()) {
      toast.error('Write a treatment or screenplay first.');
      return;
    }
    if (what === 'characters') {
      const names = parseFountain(fountain).characters;
      const out = await ai.run<{ characters: { name: string; role: string; description: string; appearance: string; wardrobe: string; personality: string; voice: string }[] }>('film.characters', { fountain, treatment, ...(names.length ? { names } : {}) }, 'Character bible');
      const known = new Set(characters.data.map((c) => c.name.toLowerCase()));
      const fresh = (out?.characters ?? []).filter((c) => !known.has(c.name.toLowerCase()));
      if (fresh.length) await addDocs(project.id, 'characters', fresh.map((c) => newCharacter(c)));
      if (out) toast.success(`${fresh.length} new characters added`);
    } else {
      const out = await ai.run<{ locations: { name: string; description: string; timeOfDay: string; palette: string; atmosphere: string }[] }>('film.locations', { fountain, treatment }, 'Location bible');
      const known = new Set(locations.data.map((l) => l.name.toLowerCase()));
      const fresh = (out?.locations ?? []).filter((l) => !known.has(l.name.toLowerCase()));
      if (fresh.length) await addDocs(project.id, 'locations', fresh.map((l) => newLocation(l)));
      if (out) toast.success(`${fresh.length} new locations added`);
    }
  };
  return { run, busy: ai.busy, dialog: ai.dialog };
}

export function ScreenplayTab({ project }: { project: WithId<ProjectDoc> }) {
  const scripts = useSub<ScriptDoc>(project.id, 'scripts', 'createdAt', 'asc');
  const characters = useSub<CharacterDoc>(project.id, 'characters', 'name');
  const [scriptId, setScriptId] = useState<string | null>(null);
  const script = scripts.data.find((s) => s.id === scriptId) ?? scripts.data[0] ?? null;
  const [content, setContent] = useState<string | null>(null);
  const [status, setStatus] = useState<'saved' | 'saving' | 'dirty'>('saved');
  const [view, setView] = useState<'split' | 'write' | 'read'>('split');
  const [proposal, setProposal] = useState<{ kind: 'draft' | 'continue' | 'rewrite'; text: string; range?: [number, number] } | null>(null);
  const [instruction, setInstruction] = useState('');
  const [versionNote, setVersionNote] = useState('');
  const [report, setReport] = useState<StructureReport | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const ai = useAiRun(project.id);
  const versions = useQuery<ScriptVersion>(() => (script ? query(collection(db, 'projects', project.id, 'scripts', script.id, 'versions'), orderBy('createdAt', 'desc')) : null), [project.id, script?.id]);

  useEffect(() => {
    if (script && content === null) setContent(script.content);
  }, [script, content]);
  useEffect(() => {
    setContent(null);
  }, [script?.id]);

  const text = content ?? '';
  const doc = useMemo(() => parseFountain(text), [text]);
  const debounced = useDebounced(text, 1500);
  useEffect(() => {
    if (!script || content === null || debounced === script.content) return;
    setStatus('saving');
    saveScript(project.id, script.id, debounced, parseFountain(debounced).pageCount)
      .then(() => setStatus('saved'))
      .catch((e) => {
        setStatus('dirty');
        toast.error('Autosave failed', { description: String(e) });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const edit = (v: string) => {
    setContent(v);
    setStatus('dirty');
  };

  if (scripts.loading) return <Skeleton className="h-96" />;
  if (!script) {
    return (
      <EmptyState
        icon={<BookOpenText className="size-5" />}
        title="No screenplay yet"
        body="Start a blank Fountain screenplay or let the assistant draft one from your treatment."
        action={<Button variant="primary" onClick={() => void createScript(project.id, project.title || 'Draft 1', `Title: ${project.title}\nAuthor: \n\nFADE IN:\n\n`)}>Start screenplay</Button>}
      />
    );
  }

  const snapshot = async (note: string) => {
    await snapshotScript(project.id, script.id, script.version, text, note || `Version ${script.version}`);
    setVersionNote('');
    toast.success(`Saved version ${script.version}`);
  };
  const draft = async () => {
    const treatment = [project.treatment?.logline, project.treatment?.synopsis, project.treatment?.body].filter(Boolean).join('\n\n');
    const out = await ai.run<{ fountain: string; notes: string }>('film.screenplay_draft', { title: project.title, treatment: treatment || project.idea || project.logline, characters: characters.data.map((c) => ({ name: c.name, role: c.role, description: c.description })), targetPages: 12, scope: text.trim().length > 200 ? 'sequence' : 'full', ...(text.trim().length > 200 ? { existingContent: text } : {}) }, 'Screenplay draft');
    if (out?.fountain) setProposal({ kind: 'draft', text: out.fountain });
  };
  const cont = async () => {
    const pos = textRef.current?.selectionStart ?? text.length;
    const out = await ai.run<{ fountain: string }>('film.screenplay_continue', { contentBefore: text.slice(0, pos), instruction, treatment: project.treatment?.body ?? '' }, 'Continue scene');
    if (out?.fountain) setProposal({ kind: 'continue', text: out.fountain, range: [pos, pos] });
  };
  const rewrite = async () => {
    const el = textRef.current;
    if (!el || el.selectionStart === el.selectionEnd) {
      toast.error('Select the passage to rewrite in the editor first.');
      return;
    }
    const [s, e] = [el.selectionStart, el.selectionEnd];
    const out = await ai.run<{ fountain: string; rationale: string }>('film.screenplay_rewrite', { selection: text.slice(s, e), instruction: instruction || 'Tighten and sharpen this passage.', context: text.slice(Math.max(0, s - 3000), Math.min(text.length, e + 3000)) }, 'Rewrite selection');
    if (out?.fountain) setProposal({ kind: 'rewrite', text: out.fountain, range: [s, e] });
  };
  const analyse = async () => {
    const out = await ai.run<StructureReport>('film.structure', { fountain: text, genre: project.genre, targetRuntime: undefined }, 'Structure & pacing');
    if (out) setReport(out);
  };
  const accept = async (mode: 'replace' | 'insert' | 'append') => {
    if (!proposal) return;
    if (mode === 'replace' && proposal.kind === 'draft') await snapshot('Before AI draft');
    let next = text;
    if (mode === 'replace' && proposal.kind === 'draft') next = proposal.text;
    else if (mode === 'append') next = `${text.trimEnd()}\n\n${proposal.text.trim()}\n`;
    else if (proposal.range) next = replaceRange(text, proposal.range[0], proposal.range[1], proposal.kind === 'continue' ? `\n\n${proposal.text.trim()}\n\n` : proposal.text);
    edit(next);
    setProposal(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={script.id} onChange={(e) => setScriptId(e.target.value)} className="!w-52" aria-label="Screenplay">
          {scripts.data.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </Select>
        <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => void createScript(project.id, `Draft ${scripts.data.length + 1}`, text).then(setScriptId)}>
          Duplicate as new draft
        </Button>
        <Segmented label="Layout" size="sm" value={view} onChange={setView} options={[{ value: 'write', label: 'Write' }, { value: 'split', label: 'Split' }, { value: 'read', label: 'Read' }]} />
        <div className="ml-auto flex flex-wrap items-center gap-2 text-xs text-faint">
          <Badge tone={status === 'saved' ? 'success' : status === 'saving' ? 'accent' : 'warning'}>{status === 'saved' ? 'Saved' : status === 'saving' ? 'Saving…' : 'Unsaved'}</Badge>
          <span>{doc.pageCount} pages</span>·<span>≈ {estimateRuntimeMinutes(doc)} min</span>·<span>{doc.scenes.length} scenes</span>·<span>{doc.characters.length} speaking characters</span>
        </div>
      </div>

      <Card className="flex flex-wrap items-end gap-3 p-4">
        <Field label="Direction for the assistant (continue / rewrite)" className="min-w-64 flex-1">
          <Input value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="e.g. Raise the stakes; Kofi reveals he sold the drum" />
        </Field>
        <Button loading={ai.busy} onClick={() => void draft()} icon={<Wand2 className="size-4" />}>
          {text.trim().length > 200 ? 'Draft next sequence' : 'Draft from treatment'}
        </Button>
        <Button loading={ai.busy} onClick={() => void cont()} icon={<Sparkles className="size-4" />}>
          Continue at cursor
        </Button>
        <Button loading={ai.busy} onClick={() => void rewrite()} icon={<Scissors className="size-4" />}>
          Rewrite selection
        </Button>
        <Button loading={ai.busy} onClick={() => void analyse()} icon={<Gauge className="size-4" />}>
          Structure & pacing
        </Button>
        <Button variant="ghost" onClick={() => setHistoryOpen(true)} icon={<History className="size-4" />}>
          Versions ({versions.data.length})
        </Button>
      </Card>

      {proposal && (
        <Card className="space-y-3 border-violet/40 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-fg">Assistant {proposal.kind === 'draft' ? 'draft' : proposal.kind === 'continue' ? 'continuation' : 'rewrite'} — review before applying</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="ghost" onClick={() => setProposal(null)}>
                Discard
              </Button>
              {proposal.kind === 'draft' ? (
                <>
                  <Button size="sm" onClick={() => void accept('append')}>
                    Append
                  </Button>
                  <Button size="sm" variant="primary" onClick={() => void accept('replace')}>
                    Replace (snapshot first)
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="primary" onClick={() => void accept('insert')}>
                  {proposal.kind === 'rewrite' ? 'Replace selection' : 'Insert at cursor'}
                </Button>
              )}
            </div>
          </div>
          <div className="max-h-96 overflow-y-auto rounded-xl bg-black/30 p-4">
            <FountainPreview elements={parseFountain(proposal.text).elements} />
          </div>
        </Card>
      )}

      <div className={cx('grid gap-4', view === 'split' && 'lg:grid-cols-2')}>
        {view !== 'read' && (
          <Textarea ref={textRef} value={text} onChange={(e) => edit(e.target.value)} spellCheck className="min-h-[70vh] font-mono text-[13.5px] leading-[1.6]" aria-label="Screenplay (Fountain)" />
        )}
        {view !== 'write' && (
          <Card className="max-h-[80vh] overflow-y-auto bg-[#0a0f18] px-6 py-8">
            {doc.elements.length ? <FountainPreview elements={doc.elements} /> : <p className="text-center text-sm text-faint">The formatted screenplay appears here.</p>}
          </Card>
        )}
      </div>

      {report && (
        <Modal open onOpenChange={(o) => !o && setReport(null)} title="Structure & pacing" size="xl" description={`Estimated runtime ≈ ${report.estimatedRuntimeMinutes} min`}>
          <StructureView report={report} />
        </Modal>
      )}
      <Modal open={historyOpen} onOpenChange={setHistoryOpen} title="Version history" size="lg">
        <div className="mb-4 flex gap-2">
          <Input value={versionNote} onChange={(e) => setVersionNote(e.target.value)} placeholder="Note for this version (optional)" aria-label="Version note" />
          <Button variant="primary" icon={<Save className="size-4" />} onClick={() => void snapshot(versionNote)}>
            Save version {script.version}
          </Button>
        </div>
        {versions.data.length === 0 ? (
          <p className="text-sm text-faint">No saved versions yet.</p>
        ) : (
          <ul className="space-y-2">
            {versions.data.map((v) => (
              <li key={v.id} className="flex items-center justify-between gap-3 rounded-xl border border-line px-3.5 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm text-fg">
                    v{v.version} · {v.note}
                  </p>
                  <p className="text-xs text-faint">
                    {relativeTime(toMillis(v.createdAt))} · {parseFountain(v.content).pageCount} pages
                  </p>
                </div>
                <Button
                  size="sm"
                  icon={<RotateCcw className="size-3.5" />}
                  onClick={() => {
                    void snapshot('Before restore').then(() => {
                      edit(v.content);
                      setHistoryOpen(false);
                      toast.success(`Restored v${v.version}`);
                    });
                  }}
                >
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Modal>
      {ai.dialog}
    </div>
  );
}
