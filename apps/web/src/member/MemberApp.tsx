import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signInWithRedirect, signOut, type User } from 'firebase/auth';
import type { GoogleVoiceName } from '@az-studio/shared';
import { call, MemberApiError, type EditionSummary, type EstimateResult, type MeResult } from './api';
import { memberAuth, memberConfig, memberConfigProblem } from './firebase';

/**
 * The public beta's member app at /app: sign in, redeem an invitation, make audio editions from pasted text or a
 * blogs.pwavwe.com article with a prebuilt voice, download the MP3, see the allowance, send feedback. It reuses the
 * public website's look (site.css) and talks only to the `azsMember` callable.
 */

const fmtMin = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;
const msg = (e: unknown) => (e instanceof MemberApiError || e instanceof Error ? e.message : String(e));
const rid = () => `m${(crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/-/g, '')}`.slice(0, 40);

function Shell({ user, children }: { user: User | null; children: ReactNode }) {
  return (
    <>
      <header className="site-header">
        <div className="container header-row">
          <a className="brand" href="/" aria-label="AZ Studio home">
            <svg className="mark" viewBox="0 0 64 64" width="32" height="32" aria-hidden="true" focusable="false">
              <rect width="64" height="64" rx="14" fill="#0b1426" />
              <circle cx="32" cy="32" r="21" fill="none" stroke="#6f9dff" strokeWidth="3" />
              <path d="M21 42 L32 18 L43 42 M25.5 34 H38.5" fill="none" stroke="#eef3fb" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>AZ Studio</span>
          </a>
          {user && (
            <div className="m-user">
              <span className="m-email">{user.email}</span>
              <button type="button" className="button button-secondary button-small" onClick={() => void signOut(memberAuth)}>
                Sign out
              </button>
            </div>
          )}
        </div>
      </header>
      <main className="section-tight" id="main">
        <div className="container narrow">{children}</div>
      </main>
    </>
  );
}

function Note({ tone = 'info', children }: { tone?: 'info' | 'error' | 'ok'; children: ReactNode }) {
  return <p className={tone === 'error' ? 'form-error' : `m-note m-note-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>{children}</p>;
}

function SignIn() {
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setError(null);
    try {
      const provider = new GoogleAuthProvider().setCustomParameters({ prompt: 'select_account' });
      await (memberConfig.useEmulators ? signInWithRedirect(memberAuth, provider) : signInWithPopup(memberAuth, provider));
    } catch (e) {
      setError(msg(e));
    }
  };
  return (
    <div className="ea-panel">
      <p className="eyebrow">Invitation-only beta</p>
      <h1>Audio editions</h1>
      <p className="lede">Sign in with the Google account of the email address your invitation was sent to.</p>
      {error && <Note tone="error">{error}</Note>}
      <button type="button" className="button button-primary" onClick={() => void go()}>
        Sign in with Google
      </button>
      <p className="form-note">Not invited yet? <a href="/early-access">Join the early-access list</a>.</p>
    </div>
  );
}

function Redeem({ me, onJoined }: { me: MeResult; onJoined: () => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await call('redeem', { code });
      onJoined();
    } catch (err) {
      setError(msg(err));
    } finally {
      setBusy(false);
    }
  };
  if (me.revoked) return <Note>Your beta access has ended. Thank you for taking part.</Note>;
  return (
    <form className="ea-panel" onSubmit={(e) => void submit(e)}>
      <p className="eyebrow">Welcome</p>
      <h1>Redeem your invitation</h1>
      <p className="lede">Enter the code you were given. It works once, for {me.email ?? 'the invited address'}.</p>
      {!me.emailVerified && <Note tone="error">This account’s email address is not verified.</Note>}
      {error && <Note tone="error">{error}</Note>}
      <div className="field">
        <label htmlFor="code">Invitation code</label>
        <input id="code" type="text" autoComplete="off" spellCheck={false} placeholder="ABCD-EFGH-JKMN" value={code} onChange={(e) => setCode(e.target.value)} />
      </div>
      <button type="submit" className="button button-primary" disabled={busy || code.trim().length < 12} aria-busy={busy}>
        Join the beta
      </button>
    </form>
  );
}

function Allowance({ me }: { me: MeResult }) {
  const a = me.allowance!;
  return (
    <section className="m-allowance" aria-label="Your allowance">
      <div>
        <span className="m-k">Credits</span>
        <span className="m-v">{a.remaining.credits}</span>
      </div>
      <div>
        <span className="m-k">Characters left today</span>
        <span className="m-v">{a.remaining.chars.toLocaleString()}</span>
      </div>
      <div>
        <span className="m-k">Minutes left today</span>
        <span className="m-v">{a.remaining.minutes}</span>
      </div>
    </section>
  );
}

function NewEdition({ onCreated }: { onCreated: (id: string) => void }) {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const importIt = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await call<{ title: string; text: string; sourceUrl: string }, 'importUrl'>('importUrl', { url });
      setTitle(r.title);
      setText(r.text);
      setSourceUrl(r.sourceUrl);
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await call<{ editionId: string }, 'editionCreate'>('editionCreate', { title, text, sourceUrl });
      onCreated(r.editionId);
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ea-panel">
      <h2 className="form-title">New audio edition</h2>
      {error && <Note tone="error">{error}</Note>}
      <div className="field">
        <label htmlFor="url">
          Article on blogs.pwavwe.com <span className="field-hint">(optional)</span>
        </label>
        <div className="m-row">
          <input id="url" type="text" inputMode="url" placeholder="https://blogs.pwavwe.com/…" value={url} onChange={(e) => setUrl(e.target.value)} />
          <button type="button" className="button button-secondary" disabled={busy || !url.trim()} onClick={() => void importIt()}>
            Import
          </button>
        </div>
      </div>
      <div className="field">
        <label htmlFor="title">Title</label>
        <input id="title" type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="text">Text to read</label>
        <textarea id="text" className="m-text" rows={12} value={text} onChange={(e) => setText(e.target.value)} />
        <p className="form-note">{text.length.toLocaleString()} characters. Links, Markdown and citation markers are tidied before the voice reads it.</p>
      </div>
      <button type="button" className="button button-primary" disabled={busy || !text.trim()} aria-busy={busy} onClick={() => void create()}>
        Create edition
      </button>
    </div>
  );
}

function Editor({ id, me, onBack, refresh }: { id: string; me: MeResult; onBack: () => void; refresh: () => Promise<void> }) {
  const [ed, setEd] = useState<(EditionSummary & { text: string }) | null>(null);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [voice, setVoice] = useState('');
  const [est, setEst] = useState<EstimateResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audio, setAudio] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await call<EditionSummary & { text: string }, 'editionGet'>('editionGet', { editionId: id });
    setEd(r);
    return r;
  }, [id]);
  useEffect(() => {
    void load().then((r) => {
      setTitle(r.title);
      setText(r.text);
      setVoice(r.voice);
    }, (e) => setError(msg(e)));
  }, [load]);
  // While the voice works, the edition is re-read every few seconds.
  useEffect(() => {
    if (!ed || (ed.status !== 'queued' && ed.status !== 'speaking')) return;
    const t = setInterval(() => void load().then((r) => (r.status === 'ready' || r.status === 'failed' ? refresh() : undefined)), 4000);
    return () => clearInterval(t);
  }, [ed, load, refresh]);

  const dirty = ed && (title !== ed.title || text !== ed.text || voice !== ed.voice);
  const working = ed?.status === 'queued' || ed?.status === 'speaking';
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };
  const save = () => run(async () => {
    if (!ed) return;
    await call('editionSave', { editionId: id, baseRev: ed.rev, title, text, voice: voice as GoogleVoiceName });
    setEst(null);
    await load();
  });
  const estimate = () => run(async () => {
    if (dirty) await save();
    setEst(await call<EstimateResult, 'estimate'>('estimate', { editionId: id }));
  });
  const start = () => run(async () => {
    if (!est) return;
    await call('synthesize', { editionId: id, requestId: rid(), confirmedCredits: est.credits });
    setEst(null);
    await load();
    await refresh();
  });
  const listen = (download: boolean) => run(async () => {
    const r = await call<{ url: string }, 'audioUrl'>('audioUrl', { editionId: id, download });
    if (download) window.location.assign(r.url);
    else setAudio(r.url);
  });
  const remove = () => run(async () => {
    if (!window.confirm('Delete this edition and its audio?')) return;
    await call('editionDelete', { editionId: id });
    await refresh();
    onBack();
  });

  if (!ed) return error ? <Note tone="error">{error}</Note> : <Note>Loading…</Note>;
  return (
    <div className="ea-panel">
      <button type="button" className="m-link" onClick={onBack}>
        ← All editions
      </button>
      {error && <Note tone="error">{error}</Note>}
      <div className="field">
        <label htmlFor="e-title">Title</label>
        <input id="e-title" type="text" value={title} disabled={working} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="e-text">Text</label>
        <textarea id="e-text" className="m-text" rows={14} value={text} disabled={working} onChange={(e) => setText(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="e-voice">Voice</label>
        <select id="e-voice" value={voice} disabled={working} onChange={(e) => setVoice(e.target.value)}>
          {(me.voices ?? []).map((v) => (
            <option key={v.name} value={v.name}>
              {v.name} — {v.character}
            </option>
          ))}
        </select>
        <p className="form-note">Google’s prebuilt voices. The beta does not copy anyone’s voice.</p>
      </div>
      {working && <Note>Reading the edition aloud… this page updates by itself.</Note>}
      {ed.status === 'failed' && ed.error && <Note tone="error">{ed.error}</Note>}
      {est && (
        <div className="m-estimate" role="region" aria-label="Estimate">
          <p>
            About {fmtMin(est.speechSec)} of audio from {est.chars.toLocaleString()} characters. Up to <strong>{est.credits} credits</strong> are held; you are charged only what the voice really costs.
          </p>
          {est.problems.map((p) => (
            <Note key={p} tone="error">
              {p}
            </Note>
          ))}
          <button type="button" className="button button-primary" disabled={busy || est.problems.length > 0} onClick={() => void start()}>
            Read it aloud · up to {est.credits} credits
          </button>
        </div>
      )}
      <div className="actions m-actions">
        <button type="button" className="button button-secondary" disabled={busy || working || !dirty} onClick={() => void save()}>
          Save
        </button>
        <button type="button" className="button button-primary" disabled={busy || working || !text.trim()} onClick={() => void estimate()}>
          {ed.audio ? 'Make the audio again' : 'Make the audio'}
        </button>
        {working && (
          <button type="button" className="button button-secondary" onClick={() => void run(async () => void (await call('cancel', { editionId: id })))}>
            Cancel
          </button>
        )}
        <button type="button" className="button button-secondary" disabled={busy || working} onClick={() => void remove()}>
          Delete
        </button>
      </div>
      {ed.audio && (
        <div className="m-audio">
          <p>
            Audio ready · {fmtMin(ed.audio.durationSec)} · {(ed.audio.bytes / 1048576).toFixed(1)} MB MP3
          </p>
          {audio ? <audio controls src={audio} preload="metadata" /> : <button type="button" className="button button-secondary button-small" onClick={() => void listen(false)}>Listen</button>}
          <button type="button" className="button button-primary button-small" onClick={() => void listen(true)}>
            Download MP3
          </button>
        </div>
      )}
    </div>
  );
}

function Feedback() {
  const [message, setMessage] = useState('');
  const [rating, setRating] = useState<number | null>(null);
  const [state, setState] = useState<'idle' | 'busy' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);
  const send = async (e: FormEvent) => {
    e.preventDefault();
    setState('busy');
    setError(null);
    try {
      await call('feedback', { message, rating, page: 'app' });
      setState('sent');
      setMessage('');
    } catch (err) {
      setError(msg(err));
      setState('idle');
    }
  };
  return (
    <form className="ea-panel" onSubmit={(e) => void send(e)}>
      <h2 className="form-title">Feedback</h2>
      {state === 'sent' && <Note tone="ok">Thank you — your feedback was sent to Francis.</Note>}
      {error && <Note tone="error">{error}</Note>}
      <div className="field">
        <label htmlFor="fb">What worked, what didn’t, what you’d like next</label>
        <textarea id="fb" className="m-text" rows={4} value={message} onChange={(e) => setMessage(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="rating">
          How useful is it so far? <span className="field-hint">(optional)</span>
        </label>
        <select id="rating" value={rating ?? ''} onChange={(e) => setRating(e.target.value ? Number(e.target.value) : null)}>
          <option value="">—</option>
          {[1, 2, 3, 4, 5].map((n) => (
            <option key={n} value={n}>
              {n} of 5
            </option>
          ))}
        </select>
      </div>
      <button type="submit" className="button button-primary" disabled={state === 'busy' || message.trim().length < 3}>
        Send feedback
      </button>
    </form>
  );
}

function Home({ me, refresh }: { me: MeResult; refresh: () => Promise<void> }) {
  const [view, setView] = useState<{ kind: 'list' } | { kind: 'new' } | { kind: 'edit'; id: string }>({ kind: 'list' });
  if (view.kind === 'new') return <NewEdition onCreated={(id) => void refresh().then(() => setView({ kind: 'edit', id }))} />;
  if (view.kind === 'edit') return <Editor id={view.id} me={me} refresh={refresh} onBack={() => setView({ kind: 'list' })} />;
  return (
    <div className="m-stack">
      <div className="m-head">
        <div>
          <p className="eyebrow">AZ Studio beta · {me.member!.wave}</p>
          <h1>Your audio editions</h1>
        </div>
        <button type="button" className="button button-primary" onClick={() => setView({ kind: 'new' })}>
          New edition
        </button>
      </div>
      <Allowance me={me} />
      {me.editions?.length ? (
        <ul className="m-list">
          {me.editions.map((e) => (
            <li key={e.id}>
              <button type="button" onClick={() => setView({ kind: 'edit', id: e.id })}>
                <span className="m-title">{e.title}</span>
                <span className="m-meta">
                  {e.status === 'ready' && e.audio ? `Audio ready · ${fmtMin(e.audio.durationSec)}` : e.status === 'queued' || e.status === 'speaking' ? 'Reading aloud…' : e.status === 'failed' ? 'Needs attention' : 'Draft'} · {e.chars.toLocaleString()} characters
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="empty-state m-empty">
          <p>No editions yet. Paste a text or import an article from blogs.pwavwe.com to make your first.</p>
        </div>
      )}
      <Feedback />
    </div>
  );
}

export function MemberApp() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [me, setMe] = useState<MeResult | null>(null);
  const [closed, setClosed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setMe(await call<MeResult, 'me'>('me'));
      setClosed(false);
    } catch (e) {
      if (e instanceof MemberApiError && e.code === 'permission-denied') setClosed(true);
      else setError(msg(e));
    }
  }, []);
  useEffect(() => onAuthStateChanged(memberAuth, (u) => setUser(u)), []);
  useEffect(() => {
    setMe(null);
    if (user) void refresh();
  }, [user, refresh]);

  if (memberConfigProblem) return <Shell user={null}><Note tone="error">{memberConfigProblem}</Note></Shell>;
  if (user === undefined) return <Shell user={null}><Note>Loading…</Note></Shell>;
  if (!user) return <Shell user={null}><SignIn /></Shell>;
  if (closed)
    return (
      <Shell user={user}>
        <div className="ea-panel">
          <p className="eyebrow">AZ Studio beta</p>
          <h1>Not open yet</h1>
          <p className="lede">The beta is invitation-only and is not open at the moment. If you have registered for early access, you will hear from Francis when your invitation is ready.</p>
          <a className="button button-secondary" href="/">Back to the website</a>
        </div>
      </Shell>
    );
  if (error && !me) return <Shell user={user}><Note tone="error">{error}</Note></Shell>;
  if (!me) return <Shell user={user}><Note>Loading…</Note></Shell>;
  return <Shell user={user}>{me.member ? <Home me={me} refresh={refresh} /> : <Redeem me={me} onJoined={() => void refresh()} />}</Shell>;
}
