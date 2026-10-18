import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { Check, CircleAlert, FileAudio, Plus, RefreshCw, ShieldCheck, Sparkles, Trash2 } from 'lucide-react';
import {
  AUDITION_SCRIPT,
  CONSENT_STATEMENTS,
  DELIVERY_PRESETS,
  DELIVERY_PRESET_IDS,
  NARRATOR,
  REFERENCE_SCRIPT,
  ROUTE_LABELS,
  consentStatementFor,
  routeOfVoice,
  RETENTION,
  countWords,
  estimateSpeechSec,
  hasBlockingIssue,
  providerTextFor,
  relativeTime,
  toMillis,
  type ConsentLocale,
  type DeliveryPreset,
  type NarratorTestDoc,
  type NarratorVoiceDoc,
  type PronunciationEntry,
  type VoiceAssessment,
} from '@az-studio/shared';
import { errorMessage } from '../../lib/api';
import { nar, newRequestId, useJob, useNarratorMedia, useRecordings, useTests, useVoices, type WithId } from '../../lib/narrator';
import { Badge, Button, ConfirmDialog, cx, Field, Input, Notice, ProgressBar, Segmented, Select, Skeleton, Textarea } from '../../components/ui';
import { ClipPlayer } from '../../components/narrator/audio';
import { Recorder } from '../../components/narrator/Recorder';
import { useNarrator } from './NarratorShell';

const STEPS = ['Record', 'Consent', 'Create voice', 'Test', 'Approve'] as const;
type Step = 0 | 1 | 2 | 3 | 4;

function Stepper({ step, reachable, onStep }: { step: Step; reachable: (s: Step) => boolean; onStep: (s: Step) => void }) {
  return (
    <ol className="grid grid-cols-5 gap-1.5" aria-label="Voice setup steps">
      {STEPS.map((label, i) => {
        const s = i as Step;
        const done = i < step;
        return (
          <li key={label}>
            <button type="button" disabled={!reachable(s)} onClick={() => onStep(s)} aria-current={s === step ? 'step' : undefined} className={cx('w-full cursor-pointer border-t-2 pt-2 text-left text-xs font-medium transition-colors disabled:cursor-not-allowed', s === step ? 'border-accent text-fg' : done ? 'border-accent/50 text-dim hover:text-fg' : 'border-line text-faint')}>
              <span className="timecode mr-1 text-faint">{i + 1}</span>
              <span className="hidden sm:inline">{label}</span>
              <span className="sr-only sm:hidden">{label}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function Panel({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="space-y-5">
        <h2 className="display text-[32px] leading-tight text-fg">{title}</h2>
        {children}
      </div>
      {aside && <aside className="space-y-3 text-[13px] leading-relaxed text-dim lg:border-l lg:border-line lg:pl-6">{aside}</aside>}
    </section>
  );
}

function TestRow({ voiceId, test }: { voiceId: string; test: WithId<NarratorTestDoc> }) {
  const src = useNarratorMedia(test.status === 'ready' ? { kind: 'test', id: test.id, voiceId } : null);
  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-faint">
        <Badge tone={test.status === 'ready' ? 'success' : test.status === 'failed' ? 'danger' : 'neutral'}>{test.status === 'generating' ? 'Generating…' : test.status}</Badge>
        <span>{DELIVERY_PRESETS[test.preset].label}</span>
        <span>· {relativeTime(toMillis(test.createdAt))}</span>
        {test.pronunciations.length > 0 && <span>· spellings: {test.pronunciations.map((p) => `${p.term} → ${p.spokenAs}`).join(', ')}</span>}
      </div>
      {test.status === 'ready' && <ClipPlayer src={src} peaks={test.peaks} label="voice test" />}
      {test.error && <p className="text-[13px] text-[#ff9b9b]">{test.error.message}</p>}
    </li>
  );
}

function LocalSample() {
  const [file, setFile] = useState<{ url: string; name: string } | null>(null);
  useEffect(
    () => () => {
      if (file?.url) URL.revokeObjectURL(file.url);
    },
    [file],
  );
  return (
    <div className="space-y-2">
      <p className="text-sm text-fg">Compare with an ElevenLabs sample (optional)</p>
      <p className="text-xs text-faint">Plays from this device only — the file is not uploaded and no ElevenLabs account is needed.</p>
      {file ? <ClipPlayer src={file.url} label={`comparison sample ${file.name}`} /> : null}
      <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-xs text-dim hover:border-line-strong hover:text-fg">
        <FileAudio className="size-3.5" aria-hidden /> {file ? 'Choose another file' : 'Choose an audio file'}
        <input type="file" accept="audio/*" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) setFile({ url: URL.createObjectURL(f), name: f.name }); e.target.value = ''; }} />
      </label>
    </div>
  );
}

const CRITERIA: { key: keyof Omit<VoiceAssessment, 'notes'>; label: string; hint: string }[] = [
  { key: 'naturalness', label: 'Naturalness', hint: 'Does it sound like a person talking?' },
  { key: 'resemblance', label: 'Resemblance', hint: 'Does it sound like you?' },
  { key: 'accent', label: 'Accent', hint: 'Is your accent kept?' },
  { key: 'pronunciation', label: 'Pronunciation', hint: 'Names and words said right?' },
  { key: 'pacing', label: 'Pacing', hint: 'Comfortable speed and pauses?' },
];

function Rating({ label, hint, value, onChange }: { label: string; hint: string; value: number | null; onChange: (v: number | null) => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 py-2">
      <div>
        <p className="text-sm text-fg">{label}</p>
        <p className="text-xs text-faint">{hint}</p>
      </div>
      <div role="radiogroup" aria-label={label} className="flex gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" role="radio" aria-checked={value === n} aria-label={`${label} ${n} of 5`} onClick={() => onChange(value === n ? null : n)} className={cx('size-8 cursor-pointer rounded-lg border text-xs transition-colors', value !== null && n <= value ? 'border-accent/50 bg-accent/20 text-fg' : 'border-line text-dim hover:border-line-strong')}>
            {n}
          </button>
        ))}
      </div>
    </div>
  );
}

function VoiceStatus({ voice, onRecordBetter }: { voice: WithId<NarratorVoiceDoc>; onRecordBetter: () => void }) {
  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState(false);
  const [confirm, setConfirm] = useState('');
  const refresh = async () => {
    setBusy(true);
    try {
      const r = await nar<{ status: string; exists: boolean }>('voiceRefresh', { voiceId: voice.id });
      toast.success(r.exists ? 'Google still has this voice.' : 'Google no longer has this voice.');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      const r = await nar<{ atProvider: string; recordingsDeleted: number; testsDeleted: number; editionsKept: number }>('voiceDelete', { voiceId: voice.id, confirmName: confirm });
      toast.success(`Voice deleted${r.atProvider === 'deleted' ? ' at Google' : ''}. ${r.recordingsDeleted} recording(s) and ${r.testsDeleted} test(s) removed; ${r.editionsKept} edition(s) and their audio kept.`);
      setDel(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const expired = voice.status === 'expired' || voice.status === 'missing_at_provider';
  return (
    <div className="space-y-3 rounded-2xl border border-line p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="display text-2xl text-fg">{voice.displayName}</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <Badge tone={voice.status === 'active' ? 'success' : expired || voice.status === 'failed' ? 'danger' : 'warning'}>{voice.status === 'active' ? 'Active at Google' : voice.status.replace(/_/g, ' ')}</Badge>
            <Badge tone={voice.consent.state === 'verified' ? 'success' : voice.consent.state === 'rejected' ? 'danger' : 'neutral'} icon={<ShieldCheck className="size-3" />}>
              Consent {voice.consent.state}
            </Badge>
            <Badge tone={voice.approval.state === 'approved' ? 'success' : voice.approval.state === 'rejected' ? 'danger' : 'neutral'}>Your approval: {voice.approval.state}</Badge>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} loading={busy} onClick={() => void refresh()}>
            Check with Google
          </Button>
          <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => setDel(true)} disabled={voice.status === 'creating'}>
            Delete voice
          </Button>
        </div>
      </div>
      <p className="text-xs text-faint">
        Model {voice.modelId} · stored by Google (stateful) · {voice.expiresAt ? `Google deletes it after a year without use — about ${new Date(voice.expiresAt).toLocaleDateString()} if unused` : 'expiry unknown'}
      </p>
      {expired && (
        <Notice tone="danger">
          Google no longer has this voice. Earlier editions keep their audio. To narrate again, <button type="button" className="cursor-pointer font-medium underline" onClick={onRecordBetter}>record new samples and create a new voice</button>.
        </Notice>
      )}
      <ConfirmDialog
        open={del}
        onOpenChange={setDel}
        danger
        title="Delete this voice?"
        confirmLabel="Delete voice"
        loading={busy}
        confirmDisabled={confirm.trim() !== voice.displayName}
        onConfirm={() => void remove()}
        body={
          <div className="space-y-2">
            <p>This removes:</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>the voice stored at Google (it can no longer be used to synthesise anything);</li>
              <li>your reference and consent recordings and the test clips kept here.</li>
            </ul>
            <p>Audio editions already generated — their takes and exports — are kept and stay playable. They cannot be regenerated with this voice afterwards.</p>
          </div>
        }
      >
        <Field label={`Type “${voice.displayName}” to confirm`} className="mt-4">
          <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
        </Field>
      </ConfirmDialog>
    </div>
  );
}

export function PronunciationNotebook() {
  const { status, setStatus } = useNarrator();
  const [entries, setEntries] = useState<PronunciationEntry[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const recordings = useRecordings();
  useEffect(() => {
    if (status && !entries) setEntries(status.pronunciations);
  }, [status, entries]);
  if (!entries) return <Skeleton className="h-40" />;
  const dirty = JSON.stringify(entries) !== JSON.stringify(status?.pronunciations);
  const update = (id: string, patch: Partial<PronunciationEntry>) => setEntries(entries.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  const save = async () => {
    setSaving(true);
    try {
      const r = await nar<{ pronunciations: PronunciationEntry[] }>('profileSave', { pronunciations: entries });
      if (status) setStatus({ ...status, pronunciations: r.pronunciations });
      toast.success('Pronunciation notebook saved.');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <section aria-labelledby="notebook" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="notebook" className="display text-[28px] text-fg">
            Pronunciation notebook
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-dim">Write how a name should be spoken. The spelling you give is sent to the voice instead of the written word — your article text never changes. Nothing here is guessed; Google offers no phonetic control for these voices, so spellings are the tool.</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setEntries([...entries, { id: `t${Date.now().toString(36)}`, term: '', spokenAs: '', hint: '', caseSensitive: false, recordingId: null }])}>
            Add a name
          </Button>
          <Button size="sm" variant="primary" disabled={!dirty || entries.some((e) => !e.term.trim())} loading={saving} onClick={() => void save()}>
            Save notebook
          </Button>
        </div>
      </div>
      <ul className="divide-y divide-line rounded-2xl border border-line">
        {entries.map((e) => {
          const preview = providerTextFor(`${e.term}.`, [e]).text;
          const rec = recordings.data.find((r) => r.id === e.recordingId) ?? null;
          return (
            <li key={e.id} className="space-y-3 px-4 py-4 sm:px-5">
              <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                <Field label="Written">
                  <Input value={e.term} onChange={(x) => update(e.id, { term: x.target.value })} placeholder="e.g. Pwavwe" />
                </Field>
                <Field label="Spoken as (speech-only spelling)">
                  <Input value={e.spokenAs} onChange={(x) => update(e.id, { spokenAs: x.target.value })} placeholder="Leave empty to say it as written" />
                </Field>
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setOpen(open === e.id ? null : e.id)} aria-expanded={open === e.id}>
                    {open === e.id ? 'Less' : 'More'}
                  </Button>
                  <Button size="sm" variant="ghost" aria-label={`Remove ${e.term || 'entry'}`} onClick={() => setEntries(entries.filter((x) => x.id !== e.id))}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
              <p className="text-xs text-faint">
                Sent to the voice as: <span className="text-dim">“{preview}”</span>
                {!e.spokenAs.trim() && ' — not set yet'}
              </p>
              {open === e.id && (
                <div className="grid gap-4 rounded-xl bg-white/[0.02] p-3 sm:grid-cols-2">
                  <Field label="Your note on how it sounds">
                    <Textarea rows={2} value={e.hint} onChange={(x) => update(e.id, { hint: x.target.value })} placeholder="e.g. stress on the first syllable" />
                  </Field>
                  <div className="space-y-2">
                    <p className="text-[12.5px] font-medium text-dim">Your own recording of it (private, for reference)</p>
                    <Recorder kind="pronunciation" compact recording={rec} termId={e.id} onChange={(id) => update(e.id, { recordingId: id })} />
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-faint">Kasem and other languages the voice model does not document may not be spoken correctly, even with your own voice. Listen to a test before relying on it.</p>
    </section>
  );
}

export default function VoicePage() {
  const { status } = useNarrator();
  const voices = useVoices();
  const recordings = useRecordings();
  const [enrolling, setEnrolling] = useState(false);
  const live = voices.data.filter((v) => v.status !== 'deleted');
  const voice = enrolling ? null : (live.find((v) => v.status === 'active') ?? live[0] ?? null);
  const tests = useTests(voice?.id ?? null);
  const job = useJob(voice?.status === 'creating' ? voice.jobId : null);
  const [referenceId, setReferenceId] = useState<string | null>(null);
  const [consentId, setConsentId] = useState<string | null>(null);
  const [locale, setLocale] = useState<ConsentLocale>('en-GB');
  const [script, setScript] = useState(REFERENCE_SCRIPT);
  const [attest, setAttest] = useState(false);
  const [busy, setBusy] = useState(false);
  const createKey = useRef(newRequestId('v'));
  const [testText, setTestText] = useState(AUDITION_SCRIPT);
  const [preset, setPreset] = useState<DeliveryPreset>('conversational');
  const [customStyle, setCustomStyle] = useState('');
  const testKey = useRef<string | null>(null);
  const [assessment, setAssessment] = useState<VoiceAssessment>({ naturalness: null, resemblance: null, accent: null, pronunciation: null, pacing: null, notes: '' });

  // Latest unused recordings are picked up automatically (e.g. after a reload).
  // New voices go to the speech service chosen in Settings; each service verifies its own consent sentence.
  const route = status?.settings.route ?? 'developer';
  const newest = [...recordings.data].sort((a, b) => (toMillis(b.createdAt) ?? 0) - (toMillis(a.createdAt) ?? 0));
  const unused = newest.filter((r) => !r.usedByVoiceId);
  // A reference already used on the other service is still the same speaker: it can be reused while it is kept.
  const reusable = newest.find((r) => r.kind === 'reference' && r.status === 'ready' && r.storagePath && live.some((v) => v.referenceRecordingId === r.id && routeOfVoice(v) !== route)) ?? null;
  const reference = recordings.data.find((r) => r.id === referenceId) ?? (referenceId === null ? (unused.find((r) => r.kind === 'reference') ?? reusable) : null);
  const consent = recordings.data.find((r) => r.id === consentId) ?? (consentId === null ? (unused.find((r) => r.kind === 'consent' && (r.consentRoute ?? 'developer') === route) ?? null) : null);
  const statement = { text: consentStatementFor(route, locale) };
  const otherRouteVoice = live.find((v) => routeOfVoice(v) !== route) ?? null;
  const readyTests = tests.data.filter((t) => t.status === 'ready');

  const derived: Step = voice ? (voice.status === 'active' ? (readyTests.length ? 4 : 3) : 2) : !reference || hasBlockingIssue(reference.analysis) ? 0 : !consent || hasBlockingIssue(consent.analysis) ? 1 : 2;
  const [chosen, setChosen] = useState<Step | null>(null);
  const step = chosen ?? derived;
  useEffect(() => setChosen(null), [voice?.id, voice?.status]);
  useEffect(() => {
    if (voice?.approval.assessment) setAssessment(voice.approval.assessment);
  }, [voice?.approval.assessment]);

  const reachable = (s: Step) => (voice ? s >= 2 && (s < 3 || voice.status === 'active') && (s < 4 || readyTests.length > 0) : s === 0 || (s === 1 && Boolean(reference)) || (s === 2 && Boolean(reference && consent)));
  const estSec = useMemo(() => estimateSpeechSec(script), [script]);

  const create = async () => {
    if (!reference || !consent) return;
    setBusy(true);
    try {
      await nar('voiceCreate', { referenceId: reference.id, consentId: consent.id, consentLocale: locale, requestId: createKey.current, attestSameAdultSpeaker: true });
      setEnrolling(false);
    } catch (e) {
      toast.error(errorMessage(e));
      createKey.current = newRequestId('v');
    } finally {
      setBusy(false);
    }
  };

  const generateTest = async () => {
    if (!voice) return;
    testKey.current ??= newRequestId('t');
    setBusy(true);
    try {
      await nar('voiceTest', { voiceId: voice.id, text: testText, preset, customStyle, requestId: testKey.current });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      testKey.current = null;
      setBusy(false);
    }
  };

  const assess = async (decision: 'approve' | 'reject' | 'pending') => {
    if (!voice) return;
    setBusy(true);
    try {
      await nar('voiceAssess', { voiceId: voice.id, decision, assessment, preset });
      if (decision === 'approve') toast.success('Voice approved for audio editions.');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (voices.loading || recordings.loading) return <Skeleton className="h-96" />;
  const generatingTest = tests.data.some((t) => t.status === 'generating');
  const providerOk = Boolean(status?.provider.configured && status.provider.voicesApi.available);

  return (
    <div className="space-y-10">
      {voice && <VoiceStatus voice={voice} onRecordBetter={() => setEnrolling(true)} />}
      {enrolling && live.length > 0 && (
        <Notice tone="accent">
          Recording new samples for a new voice. Your current voice stays available until you delete it.{' '}
          <button type="button" className="cursor-pointer font-medium underline" onClick={() => setEnrolling(false)}>
            Back to the current voice
          </button>
        </Notice>
      )}
      {otherRouteVoice && !live.some((v) => routeOfVoice(v) === route) && (
        <Notice tone="accent">
          New voices are created on {ROUTE_LABELS[route]} (Settings → Speech service). Your current voice lives on {ROUTE_LABELS[routeOfVoice(otherRouteVoice)]}; Google keeps a separate voice store for each, so it cannot be used there. To narrate on {ROUTE_LABELS[route]}, enrol again: {reusable ? 'your reference recording is reused, ' : 'record a reference, '}record the consent statement for this service, then create, test and approve the new voice. Editions switched to it are re-narrated in full.
        </Notice>
      )}
      <Stepper step={step} reachable={reachable} onStep={setChosen} />

      {step === 0 && (
        <Panel
          title="Record your reference"
          aside={
            <>
              <p className="font-medium text-fg">Google’s guidance</p>
              <p>10–30 seconds of clean, natural speech from one adult speaker. Record in a quiet room without music, echo or other voices, and use the same microphone and room for the consent recording.</p>
              <p>Speak as you would to a listener — not a performance. The script is a suggestion; any natural speech works.</p>
              <p>A good recording helps, but no sample guarantees an accurate replica. You will listen and decide.</p>
            </>
          }
        >
          <Field label="Reference script (editable)" hint={`${countWords(script)} words · about ${Math.round(estSec)} s at a typical pace — your own pace may differ. Aim for 10–30 s.`}>
            <Textarea rows={4} value={script} onChange={(e) => setScript(e.target.value)} className="display text-[19px] leading-relaxed" />
          </Field>
          <Recorder kind="reference" recording={reference} scriptText={script} onChange={(id) => setReferenceId(id ?? '')} />
          <Button variant="primary" disabled={!reference || hasBlockingIssue(reference.analysis)} onClick={() => setChosen(1)}>
            Continue to consent
          </Button>
        </Panel>
      )}

      {step === 1 && (
        <Panel
          title="Record your consent"
          aside={
            <>
              <p>Google requires the same person to read this statement exactly. It is checked against your reference recording.</p>
              <p>
                Wording from{' '}
                <a href={(route === 'vertex' ? status?.consent.cloud?.source.url : status?.consent.source.url) ?? 'https://ai.google.dev/gemini-api/docs/voice-replication'} target="_blank" rel="noreferrer" className="text-accent-2 hover:underline">
                  Google’s voice replication page ({ROUTE_LABELS[route]})
                </a>
                , checked {(route === 'vertex' ? status?.consent.cloud?.source.checkedOn : status?.consent.source.checkedOn) ?? '2026-10-17'}. It must not be paraphrased, and it must be your own live voice — never synthesised.
              </p>
            </>
          }
        >
          <Field label="Language of the statement">
            <Select value={locale} onChange={(e) => setLocale(e.target.value as ConsentLocale)} className="max-w-xs">
              {CONSENT_STATEMENTS.map((c) => (
                <option key={c.locale} value={c.locale}>
                  {c.language}
                </option>
              ))}
            </Select>
          </Field>
          <blockquote className="display rounded-2xl border border-accent/25 bg-accent/[0.06] px-6 py-5 text-[24px] leading-snug text-fg">“{statement.text}”</blockquote>
          <Recorder kind="consent" recording={consent} consentLocale={locale} consentRoute={route} scriptText={statement.text} onChange={(id) => setConsentId(id ?? '')} />
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setChosen(0)}>
              Back
            </Button>
            <Button variant="primary" disabled={!consent || hasBlockingIssue(consent.analysis)} onClick={() => setChosen(2)}>
              Continue
            </Button>
          </div>
        </Panel>
      )}

      {step === 2 && (
        <Panel
          title="Create your voice"
          aside={
            <>
              <p className="font-medium text-fg">What is sent to Google</p>
              <p>Your two recordings (as 24 kHz mono WAV) go to the {ROUTE_LABELS[route]} Voices service, which checks the consent and stores a voice profile in AZ Studio’s Google project. Google keeps a stored voice for one year from its last use; you can delete it at any time.</p>
              <p className="font-medium text-fg">What AZ Studio keeps</p>
              <p>The consent recording is deleted as soon as Google accepts it. The reference is kept privately for {RETENTION.referenceAfterCreateDays} days so you can compare it with tests, then deleted. Unused recordings are deleted after {RETENTION.unusedRecordingDays} days.</p>
              <p>{status?.voiceCreationCost}</p>
            </>
          }
        >
          {voice?.status === 'creating' ? (
            <div className="space-y-3" aria-live="polite">
              <p className="text-sm text-fg">{job.data?.stage ?? 'Creating your voice…'}</p>
              <ProgressBar value={job.data?.progress ?? 0.1} label="Voice creation" />
            </div>
          ) : voice?.status === 'failed' || voice?.status === 'needs_recovery' ? (
            <Notice tone="danger" icon={<CircleAlert className="size-4" />}>
              <p className="font-medium">{voice.status === 'failed' ? (voice.consent.state === 'rejected' ? 'Google did not accept the recordings.' : 'The voice could not be created.') : 'Google’s answer was lost — the voice may exist.'}</p>
              <p className="mt-1">{voice.error?.message}</p>
              <p className="mt-2">
                {voice.status === 'needs_recovery' ? (
                  <Link to="/narrator/settings" className="font-medium underline">
                    Check Google for voices
                  </Link>
                ) : (
                  <button type="button" className="cursor-pointer font-medium underline" onClick={() => setEnrolling(true)}>
                    Record again
                  </button>
                )}
              </p>
            </Notice>
          ) : (
            <>
              {!providerOk && (
                <Notice tone="warning" icon={<CircleAlert className="size-4" />}>
                  {status?.provider.message ?? 'Checking access to voice replication…'}{' '}
                  <Link to="/narrator/settings" className="font-medium underline">
                    Provider details
                  </Link>
                </Notice>
              )}
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="rounded-xl border border-line p-4">
                  <p className="eyebrow mb-2">Reference</p>
                  {reference ? <p className="text-sm text-fg">{reference.analysis.durationSec.toFixed(1)} s · {reference.source}</p> : <p className="text-sm text-faint">Missing</p>}
                </div>
                <div className="rounded-xl border border-line p-4">
                  <p className="eyebrow mb-2">Consent</p>
                  {consent ? <p className="text-sm text-fg">{consent.analysis.durationSec.toFixed(1)} s · {consent.source}</p> : <p className="text-sm text-faint">Missing</p>}
                </div>
              </div>
              <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-4 text-sm text-dim">
                <input type="checkbox" checked={attest} onChange={(e) => setAttest(e.target.checked)} className="mt-1 size-4 accent-[#4c8dff]" />
                <span>
                  Both recordings are of me, {NARRATOR.defaultAuthor}, an adult, speaking live. Neither is synthesised or made with an existing AI voice, and I consent to Google creating a synthetic model of my voice.
                </span>
              </label>
              <Button variant="primary" size="lg" icon={<Sparkles className="size-4" />} loading={busy} disabled={!attest || !reference || !consent || !providerOk || busy} onClick={() => void create()}>
                Create voice
              </Button>
            </>
          )}
        </Panel>
      )}

      {step === 3 && voice && (
        <Panel
          title="Let’s hear you."
          aside={
            <>
              <p>One test is generated each time you press the button — never automatically.</p>
              <p>Delivery presets set a short style direction sent alongside the text (Google’s speech_metadata style); your recorded voice carries the identity.</p>
              {status && <p>Estimated cost of a test: well under one cent at {status.rates.modelId} list prices.</p>}
            </>
          }
        >
          <Field label="Test script" hint="A test script for listening — not an excerpt from a published article.">
            <Textarea rows={5} value={testText} onChange={(e) => setTestText(e.target.value)} className="display text-[19px] leading-relaxed" />
          </Field>
          <Field label="Delivery">
            <Segmented label="Delivery" value={preset} onChange={setPreset} options={DELIVERY_PRESET_IDS.map((id) => ({ value: id, label: DELIVERY_PRESETS[id].label, title: DELIVERY_PRESETS[id].blurb }))} />
          </Field>
          <details className="rounded-xl border border-line px-4 py-3">
            <summary className="cursor-pointer text-sm text-dim">Custom delivery direction</summary>
            <Field label="Style (short, replaces the preset)" hint="e.g. “warm, unhurried”. Long directions make voices drift." className="mt-3">
              <Input value={customStyle} maxLength={80} onChange={(e) => setCustomStyle(e.target.value)} />
            </Field>
          </details>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" icon={<Sparkles className="size-4" />} loading={busy || generatingTest} disabled={!testText.trim() || busy || generatingTest} onClick={() => void generateTest()}>
              Generate test
            </Button>
            {readyTests.length > 0 && (
              <Button variant="secondary" onClick={() => setChosen(4)}>
                Assess and approve
              </Button>
            )}
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <div>
              <p className="eyebrow mb-1">Tests</p>
              {tests.data.length ? (
                <ul className="divide-y divide-line">
                  {tests.data.slice(0, 6).map((t) => (
                    <TestRow key={t.id} voiceId={voice.id} test={t} />
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-faint">No tests yet.</p>
              )}
            </div>
            <div className="space-y-5">
              <ReferencePlayback voice={voice} />
              <LocalSample />
            </div>
          </div>
        </Panel>
      )}

      {step === 4 && voice && (
        <Panel title="Your verdict" aside={<p>These are your listening judgements. AZ Studio does not score resemblance automatically. Consent verification (Google) and your approval are separate: the voice is used for editions only after you approve it.</p>}>
          {readyTests[0] && <TestRow voiceId={voice.id} test={readyTests[0]} />}
          <div className="divide-y divide-line rounded-2xl border border-line px-4">
            {CRITERIA.map((c) => (
              <Rating key={c.key} label={c.label} hint={c.hint} value={assessment[c.key]} onChange={(v) => setAssessment({ ...assessment, [c.key]: v })} />
            ))}
          </div>
          <Field label="Notes">
            <Textarea rows={2} value={assessment.notes} onChange={(e) => setAssessment({ ...assessment, notes: e.target.value })} placeholder="What to listen for next time…" />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" icon={<Check className="size-4" />} loading={busy} onClick={() => void assess('approve')}>
              Approve this voice
            </Button>
            <Button variant="secondary" onClick={() => setChosen(3)}>
              Try another delivery
            </Button>
            <Button variant="ghost" onClick={() => setEnrolling(true)}>
              Record a better sample
            </Button>
          </div>
          {voice.approval.state === 'approved' && <Notice tone="success">Approved {voice.approval.at ? new Date(voice.approval.at).toLocaleString() : ''}. You can now narrate editions.</Notice>}
        </Panel>
      )}

      <PronunciationNotebook />
    </div>
  );
}

function ReferencePlayback({ voice }: { voice: WithId<NarratorVoiceDoc> }) {
  const recordings = useRecordings();
  const ref = recordings.data.find((r) => r.id === voice.referenceRecordingId);
  const src = useNarratorMedia(ref ? { kind: 'recording', id: ref.id } : null);
  return (
    <div className="space-y-2">
      <p className="text-sm text-fg">Your reference recording</p>
      {ref ? <ClipPlayer src={src} label="reference recording" /> : <p className="text-xs text-faint">No longer kept (deleted after {RETENTION.referenceAfterCreateDays} days or by you).</p>}
    </div>
  );
}
