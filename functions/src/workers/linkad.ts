import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import {
  allFacts,
  deriveBrand,
  linkAdStatus,
  parseBrief,
  parseDirections,
  parseRevise,
  sceneVoiceHash,
  stampFor,
  usedFactsHash,
  type JobDoc,
  type LinkAdDoc,
  type ReviseScope,
} from '@az-studio/shared';
import { withTmpDir, createAsset } from '../lib/assets';
import { JobFailure } from '../lib/errors';
import { bucket, col } from '../lib/firebase';
import { cancelJobDoc, getJob, progress, transition } from '../lib/jobs';
import { FIXTURES_ALLOWED, addLedger, loadAd, moveStage, mutateAd, settleLedger } from '../lib/linkad-store';
import { fixturePlanner, fixtureTransport } from '../lib/linkad-fixture';
import { modelPlanner, type Planner } from '../lib/linkad-model';
import { applySiteRead, factsFromNotes, FIRECRAWL_SECRET, readSite, storeSitePicture, type SiteReadDeps } from '../lib/linkad-site';
import { FetchRefusal, type Transport } from '../lib/linkad-net';
import { alignScene, fixtureSpeaker, liveSpeaker, type Speaker } from '../lib/linkad-voice';
import { readOptionalSecret } from '../lib/secrets';
import { IS_EMULATOR } from '../config/runtime';
import { storagePaths } from '@az-studio/shared';

/**
 * Link to Ad background work (`linkad.run`): one job per pipeline step — analyse the site, plan directions, revise a
 * passage, record the voice. Every step writes its results to the ad as it goes (checkpoints), checks for cancellation
 * between units of work, reuses anything already finished, and never sends a paid request twice for the same input.
 */

export interface LinkAdDeps {
  planner: Planner;
  speaker: Speaker;
  transport: Transport | undefined;
  firecrawlKey: () => Promise<string | null>;
  respectRobots: boolean;
}

const liveDeps: LinkAdDeps = { planner: modelPlanner, speaker: liveSpeaker, transport: undefined, firecrawlKey: async () => (IS_EMULATOR ? process.env[FIRECRAWL_SECRET]?.trim() || null : readOptionalSecret(FIRECRAWL_SECRET)), respectRobots: true };
const fixtureDeps: LinkAdDeps = { planner: fixturePlanner, speaker: fixtureSpeaker, transport: fixtureTransport, firecrawlKey: async () => null, respectRobots: true };

let override: Partial<LinkAdDeps> | null = null;
/** Tests replace providers here. Production code never calls this. */
export function setLinkAdDeps(o: Partial<LinkAdDeps> | null): void {
  override = o;
}
export function depsFor(doc: Pick<LinkAdDoc, 'mode'>): LinkAdDeps {
  const base = doc.mode === 'fixture' && FIXTURES_ALLOWED() ? fixtureDeps : liveDeps;
  return { ...base, ...(override ?? {}) };
}

class Stopped extends Error {}

async function checkStop(jobId: string): Promise<void> {
  const j = await getJob(jobId);
  if (!j || j.cancelRequested || j.status === 'cancelled') throw new Stopped('cancelled');
}

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const fail = (code: string, message: string, retryable = false): never => {
  throw new JobFailure({ code, message, retryable });
};

type Params = { step: 'analyse' | 'directions' | 'revise' | 'voice'; manualOnly?: boolean; scope?: ReviseScope; sceneId?: string | null; guidance?: string; sceneIds?: string[]; attempt?: number };

export async function runLinkAdJob(job: JobDoc): Promise<void> {
  const p = job.params as unknown as Params;
  if (!job.projectId) return fail('invalid_request', 'This job has no ad.');
  const projectId = job.projectId;
  const uid = job.ownerUid;
  if (!(await transition(job.id, 'generating', { stage: 'Starting', progress: 0.02, lease: { until: Date.now() + 25 * 60_000 } }))) return;
  try {
    const loaded = await loadAd(uid, projectId);
    const deps = depsFor(loaded.doc);
    if (p.step === 'analyse') await analyse(job, uid, projectId, deps, Boolean(p.manualOnly));
    else if (p.step === 'directions') await directions(job, uid, projectId, deps);
    else if (p.step === 'revise') await revise(job, uid, projectId, deps, p.scope ?? 'script', p.sceneId ?? null, p.guidance ?? '');
    else if (p.step === 'voice') await voice(job, uid, projectId, deps, p.sceneIds);
  } catch (e) {
    if (e instanceof Stopped) {
      await settleAfterStop(job, uid, projectId, p.step);
      await cancelJobDoc(job, 'Stopped. Finished work was kept.');
      return;
    }
    // Keep what was saved and say plainly where it stopped; the worker's retry policy decides about automatic retries.
    await recordFailure(job, uid, projectId, p.step, e).catch(() => undefined);
    throw e;
  }
}

async function settleAfterStop(job: JobDoc, uid: string, projectId: string, step: Params['step']): Promise<void> {
  await mutateAd(uid, projectId, (d) => {
    const back = step === 'analyse' ? 'cancelled' : step === 'directions' ? 'reviewing' : 'generating';
    const stage = d.stage === 'analysing' || d.stage === 'planning' || d.stage === 'generating' ? back : d.stage;
    const base = stage !== d.stage ? moveStage(d, stage, 'Stopped. Finished work was kept.') : d;
    const inflight = { ...base.voiceInFlight };
    for (const [k, v] of Object.entries(inflight)) if (v.jobId === job.id) delete inflight[k];
    return { ...base, activeJobId: null, voiceInFlight: inflight };
  }).catch(() => undefined);
}

async function recordFailure(job: JobDoc, uid: string, projectId: string, step: Params['step'], e: unknown): Promise<void> {
  const message = e instanceof JobFailure ? e.jobError.message : e instanceof FetchRefusal ? e.message : String((e as Error)?.message ?? e).slice(0, 300);
  const retryable = e instanceof JobFailure ? e.jobError.retryable : false;
  await mutateAd(uid, projectId, (d) => {
    const hasSource = d.source.facts.length > 0 || d.userFacts.length > 0;
    const to = step === 'analyse' ? (hasSource ? 'reviewing' : 'failed') : step === 'directions' ? 'reviewing' : d.stage === 'analysing' || d.stage === 'planning' ? 'reviewing' : d.stage;
    const moved = to !== d.stage ? moveStage(d, to, message) : { ...d, stageNote: message.slice(0, 400) };
    return { ...moved, activeJobId: null, lastError: { message: message.slice(0, 500), step, at: Date.now(), retryable } };
  });
}

// ---------------------------------------------------------------------------
// Analyse: read the site, keep the pictures, propose the brief
// ---------------------------------------------------------------------------

async function analyse(job: JobDoc, uid: string, projectId: string, deps: LinkAdDeps, manualOnly: boolean): Promise<void> {
  const start = await loadAd(uid, projectId);
  const input = start.doc.input;
  let read: Awaited<ReturnType<typeof readSite>> | null = null;
  let siteError: string | null = null;
  if (!manualOnly && input.url.trim()) {
    const siteDeps: SiteReadDeps = {
      transport: deps.transport,
      respectRobots: deps.respectRobots,
      firecrawlKey: await deps.firecrawlKey(),
      onProgress: (m) => progress(job.id, m, 0.1),
      isCancelled: async () => (await getJob(job.id))?.cancelRequested === true,
    };
    try {
      read = await readSite(input, siteDeps);
    } catch (e) {
      if ((await getJob(job.id))?.cancelRequested) throw new Stopped('cancelled');
      siteError = e instanceof FetchRefusal ? e.message : 'The website could not be read.';
    }
  }
  await checkStop(job.id);
  const now = Date.now();
  await mutateAd(uid, projectId, (d) => {
    // Facts typed in the notes box are the director's own; they replace the previous note-derived facts only.
    const noteFacts = factsFromNotes(d.input.manualText, now);
    const kept = d.userFacts.filter((f) => !f.id.startsWith('u_'));
    const merged: LinkAdDoc = { ...d, userFacts: [...kept, ...noteFacts].slice(0, 40) };
    const source = applySiteRead(merged, read, now);
    if (siteError) source.warnings = [siteError, ...source.warnings].slice(0, 30);
    return { ...merged, source, lastError: null };
  });

  // Pictures: logos first, then the best candidates. Each is stored on its own so a bad one costs nothing else.
  const afterRead = (await loadAd(uid, projectId)).doc;
  const wanted = [...afterRead.source.assets.filter((a) => a.role === 'logo' && a.status === 'candidate').slice(0, 2), ...afterRead.source.assets.filter((a) => a.role === 'image' && a.status === 'candidate').slice(0, 8)];
  let n = 0;
  for (const cand of wanted) {
    await checkStop(job.id);
    n++;
    await progress(job.id, `Checking picture ${n} of ${wanted.length}`, 0.3 + (0.35 * n) / Math.max(1, wanted.length));
    let result: { ok: true; assetId: string; width: number; height: number; bytes: number; mime: string } | { ok: false; reason: string };
    try {
      const s = await storeSitePicture({ uid, projectId, ref: cand, jobId: job.id, transport: deps.transport, title: cand.alt || (cand.role === 'logo' ? 'Logo' : 'Website picture') });
      result = { ok: true, ...s };
    } catch (e) {
      result = { ok: false, reason: e instanceof FetchRefusal ? e.message : 'The picture could not be used.' };
    }
    await mutateAd(uid, projectId, (d) => ({
      ...d,
      source: {
        ...d.source,
        assets: d.source.assets.map((a) =>
          a.id !== cand.id ? a : result.ok ? { ...a, status: 'stored', assetId: result.assetId, width: result.width, height: result.height, bytes: result.bytes, mime: result.mime, rejectReason: null, rights: d.input.rightsConfirmed ? 'confirmed' : 'unconfirmed' } : { ...a, status: 'rejected', rejectReason: result.reason },
        ),
      },
    }));
  }

  // The brief.
  await checkStop(job.id);
  const doc = (await loadAd(uid, projectId)).doc;
  const hasMaterial = doc.source.facts.length > 0 || doc.userFacts.length > 0;
  // An approved brief is the director's decision: reading the site again refreshes facts and pictures, never the brief.
  const rereading = Boolean(doc.briefApprovedAt);
  let briefError: string | null = null;
  let proposed: ReturnType<typeof parseBrief> | null = null;
  let modelNote = '';
  if (hasMaterial && !rereading) {
    await progress(job.id, 'Proposing the ad', 0.75);
    try {
      const body = read?.extracted.map((x) => `# ${x.title}\n${x.text}`).join('\n\n') ?? '';
      const res = await deps.planner.brief(doc, body, { uid, projectId, jobId: job.id });
      proposed = parseBrief(res.json, doc);
      modelNote = res.live ? res.modelId : `${res.modelId} (fixture)`;
      await mutateAd(uid, projectId, (d) => settleLedger(d, job.id, 'reasoning', res.usd));
    } catch (e) {
      if ((await getJob(job.id))?.cancelRequested) throw new Stopped('cancelled');
      briefError = e instanceof JobFailure ? e.jobError.message : 'The ad could not be proposed automatically. You can fill in the brief yourself.';
      if (e instanceof JobFailure && e.jobError.retryable) throw e;
    }
  }
  await mutateAd(uid, projectId, (d) => {
    const stored = d.source.assets.filter((a) => a.status === 'stored');
    const logo = stored.find((a) => a.role === 'logo') ?? null;
    const images = stored.filter((a) => a.role === 'image').sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0)).slice(0, 6);
    const brandFrom = deriveBrand(d.source.colours);
    let brief = d.brief;
    if (proposed) {
      // A brief the director already edited by hand keeps their words; the proposal only fills what is empty.
      const keepMine = d.brief.origin === 'manual';
      const pb = proposed.brief;
      brief = keepMine
        ? { ...d.brief, focus: d.brief.focus || (pb.focus ?? ''), message: d.brief.message || (pb.message ?? ''), action: d.brief.action || (pb.action ?? ''), destination: d.brief.destination.value ? d.brief.destination : (pb.destination ?? d.brief.destination), benefit: d.brief.benefit.text ? d.brief.benefit : (pb.benefit ?? d.brief.benefit), offerings: pb.offerings ?? [], usedFactIds: d.brief.usedFactIds.length ? d.brief.usedFactIds : (pb.usedFactIds ?? []), confirmNotes: pb.confirmNotes ?? [] }
        : { ...d.brief, ...pb, audience: pb.audience ?? d.brief.audience, benefit: pb.benefit ?? d.brief.benefit, destination: pb.destination ?? d.brief.destination, origin: d.mode === 'fixture' ? 'fixture' : 'ai' };
    }
    if (!brief.logoId && logo) brief = { ...brief, logoId: logo.id };
    if (!brief.imageIds.length) brief = { ...brief, imageIds: images.map((a) => a.id) };
    const sources = brief.imageIds.length ? new Set(brief.imageIds) : new Set<string>();
    const assets = d.source.assets.map((a) => (a.role === 'image' && a.status === 'stored' ? { ...a, selected: sources.has(a.id) } : a.role === 'logo' && a.id === brief.logoId ? { ...a, selected: true } : a));
    if (!brief.destination.value) {
      const dest = allFacts(d).find((f) => f.kind === 'destination') ?? allFacts(d).find((f) => f.kind === 'contact');
      if (dest) brief = { ...brief, destination: { kind: dest.kind === 'contact' ? (dest.text.startsWith('Email') ? 'email' : 'phone') : 'url', value: dest.value ?? dest.text, factId: dest.id } };
      else if (d.input.url) brief = { ...brief, destination: { kind: 'url', value: d.input.url, factId: null } };
    }
    const nextBrief = rereading ? d.brief : { ...brief, durationSec: d.brief.durationSec, voice: d.brief.voice };
    const hasContent = Boolean(nextBrief.focus || hasMaterial);
    const base = d.stage === 'analysing' ? moveStage(d, hasContent ? 'reviewing' : 'failed', hasContent ? (proposed ? 'Review the ad I propose.' : 'Fill in the brief, then continue.') : 'Nothing could be read. Paste the details yourself.') : d;
    const withLedger = addLedger(base, { step: 'analyse', kind: 'fetch', units: `${d.source.pages.length} page(s)`, estimateUsd: 0, actualUsd: 0, jobId: job.id, basis: 'unknown' });
    return {
      ...withLedger,
      brief: nextBrief,
      source: { ...d.source, assets },
      ad: { ...d.ad, brand: { ...d.ad.brand, ...brandFrom } },
      activeJobId: null,
      lastError: briefError ? { message: briefError, step: 'analyse', at: Date.now(), retryable: true } : null,
    };
  });
  await transition(job.id, 'completed', { stage: proposed ? `Ad proposed${modelNote ? ` · ${modelNote}` : ''}` : hasMaterial ? 'Site read; fill in the brief' : 'Nothing could be read', result: { data: { facts: doc.source.facts.length, pictures: doc.source.assets.filter((a) => a.status === 'stored').length, proposed: Boolean(proposed) } } });
}

// ---------------------------------------------------------------------------
// Directions
// ---------------------------------------------------------------------------

async function directions(job: JobDoc, uid: string, projectId: string, deps: LinkAdDeps): Promise<void> {
  const doc = (await loadAd(uid, projectId)).doc;
  let feedback: string[] = [];
  let parsed = null as ReturnType<typeof parseDirections> | null;
  let totalUsd = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    await checkStop(job.id);
    await progress(job.id, attempt ? 'Checking the wording against the facts' : 'Planning three directions', 0.25 + attempt * 0.3);
    const res = await deps.planner.directions(doc, feedback, { uid, projectId, jobId: job.id });
    totalUsd += res.usd;
    parsed = parseDirections(res.json, doc, res.live ? 'ai' : 'fixture');
    if (!parsed.feedback.length) break;
    feedback = parsed.feedback;
  }
  await mutateAd(uid, projectId, (d) => settleLedger(d, job.id, 'reasoning', totalUsd)).catch(() => undefined);
  if (!parsed || !parsed.directions.length) return fail('no_directions', 'No usable directions came back. Try again, or adjust the brief.', true);
  await checkStop(job.id);
  const result = parsed;
  await mutateAd(uid, projectId, (d) => {
    const moved = moveStage(d, 'awaiting_selection', 'Choose a direction to start from.');
    return { ...moved, directions: result.directions, directionsFor: usedFactsHash(d), activeJobId: null, lastError: result.problems.length ? { message: result.problems.join(' '), step: 'directions', at: Date.now(), retryable: false } : null };
  });
  await transition(job.id, 'completed', { stage: `${result.directions.length} directions ready`, result: { data: { directions: result.directions.length, notes: result.problems } } });
}

// ---------------------------------------------------------------------------
// Revise (a hook, the whole script, or one scene)
// ---------------------------------------------------------------------------

async function revise(job: JobDoc, uid: string, projectId: string, deps: LinkAdDeps, scope: ReviseScope, sceneId: string | null, guidance: string): Promise<void> {
  const doc = (await loadAd(uid, projectId)).doc;
  await progress(job.id, scope === 'hook' ? 'Rewriting the hook' : scope === 'script' ? 'Rewriting the script' : 'Rewriting the scene', 0.3);
  let res = await deps.planner.revise(doc, scope, sceneId, guidance, { uid, projectId, jobId: job.id });
  let out = parseRevise(res.json, doc, scope, sceneId);
  let usd = res.usd;
  if (out.feedback.length) {
    await checkStop(job.id);
    res = await deps.planner.revise(doc, scope, sceneId, `${guidance}\nFix these: ${out.feedback.join(' ')}`, { uid, projectId, jobId: job.id });
    out = parseRevise(res.json, doc, scope, sceneId);
    usd += res.usd;
  }
  if (!out.patches.length) return fail('no_revision', 'No rewrite came back. Try again.', true);
  await checkStop(job.id);
  const patches = out.patches;
  await mutateAd(uid, projectId, (d) => {
    const byId = new Map(patches.map((x) => [x.sceneId, x]));
    // Only the words change: pictures, timing of untouched scenes and their recordings stay as they were.
    const scenes = d.ad.scenes.map((s) => {
      const x = byId.get(s.id);
      if (!x) return s;
      const factIds = x.factIds.length ? x.factIds : s.factIds;
      return { ...s, narration: flat(x.narration) || s.narration, overlay: flat(x.overlay), factIds, factStamp: stampFor(d, factIds), review: null };
    });
    return settleLedger({ ...d, ad: { ...d.ad, scenes }, activeJobId: null }, job.id, 'reasoning', usd);
  });
  await transition(job.id, 'completed', { stage: 'Rewritten', result: { data: { scenes: patches.length } } });
}

// ---------------------------------------------------------------------------
// Voice: one take per scene, saved before it is timed
// ---------------------------------------------------------------------------

async function voice(job: JobDoc, uid: string, projectId: string, deps: LinkAdDeps, only?: string[]): Promise<void> {
  const first = (await loadAd(uid, projectId)).doc;
  const targets = first.ad.scenes.filter((s) => flat(s.narration) && (!only || only.includes(s.id)));
  if (!targets.length) return fail('no_narration', 'There is no narration to record.');
  let done = 0;
  let spent = 0;
  const notes: string[] = [];
  for (const target of targets) {
    await checkStop(job.id);
    const { doc } = await loadAd(uid, projectId);
    const scene = doc.ad.scenes.find((s) => s.id === target.id);
    if (!scene) continue;
    const hash = sceneVoiceHash(scene, doc.brief.voice, doc.brief.voiceDirection);
    const have = doc.ad.takes[scene.id];
    if (have && have.hash === hash) {
      done++;
      continue; // already recorded for exactly these words and this voice
    }
    await progress(job.id, `Recording scene ${doc.ad.scenes.indexOf(scene) + 1} of ${doc.ad.scenes.length}`, 0.1 + (0.8 * done) / targets.length);
    const ctx = { uid, projectId, jobId: job.id };
    // The request is about to leave: mark it, so a worker that dies mid-request never resends it on its own.
    await mutateAd(uid, projectId, (d) => ({ ...d, voiceInFlight: { ...d.voiceInFlight, [scene.id]: { hash, jobId: job.id, at: Date.now() } } }));
    const spoken = await deps.speaker.speak(flat(scene.narration), doc.brief.voice, doc.brief.voiceDirection, ctx);
    // Save the audio before timing it: a retry of the timing step never pays for the speech again.
    const assetId = col.assets().doc().id;
    const storagePath = `${storagePaths.generatedDir(uid, job.id)}${assetId}.wav`;
    await withTmpDir(async (dir) => {
      const local = path.join(dir, 'narration.wav');
      await writeFile(local, spoken.wav);
      await bucket.upload(local, { destination: storagePath, resumable: false, metadata: { contentType: 'audio/wav', cacheControl: 'private, max-age=31536000' } });
      await createAsset({ uid, assetId, projectId, kind: 'audio', source: 'generated', title: `Voice — “${flat(scene.narration).slice(0, 50)}${scene.narration.length > 50 ? '…' : ''}”`, fileName: 'narration.wav', mimeType: 'audio/wav', storagePath, localFile: local, dir, collections: ['linkad:voice'], generation: { jobId: job.id, modelId: spoken.modelId, prompt: flat(scene.narration), params: { voice: doc.brief.voice, direction: doc.brief.voiceDirection, purpose: 'linkad_voice', sceneId: scene.id, fixture: spoken.fixture } } });
    });
    const aligned = await alignScene({ storagePath, text: flat(scene.narration), fileSeconds: spoken.fileSeconds, ctx, voiced: spoken });
    const speechStart = aligned.speechStart ?? spoken.speech?.start ?? 0;
    const speechEnd = aligned.speechEnd ?? spoken.speech?.end ?? spoken.fileSeconds;
    spent += spoken.usd + aligned.usd;
    await mutateAd(uid, projectId, (d) => {
      const cur = d.ad.scenes.find((s) => s.id === scene.id);
      const inflight = { ...d.voiceInFlight };
      delete inflight[scene.id];
      // The words may have been edited while the voice was being recorded: the take is kept, and its hash says it is stale.
      const stale = !cur || sceneVoiceHash(cur, d.brief.voice, d.brief.voiceDirection) !== hash;
      if (stale) notes.push(`Scene ${d.ad.scenes.indexOf(scene) + 1} changed while it was being recorded.`);
      let next: LinkAdDoc = { ...d, voiceInFlight: inflight, ad: { ...d.ad, takes: { ...d.ad.takes, [scene.id]: { hash, assetId, jobId: job.id, fileSec: spoken.fileSeconds, speechStart, speechEnd: Math.max(speechEnd, speechStart + 0.1), words: aligned.words, alignment: aligned.alignment, coverage: aligned.coverage, flags: aligned.flags, source: spoken.fixture ? 'fixture' : 'generated', voice: d.brief.voice, createdAt: Date.now() } } } };
      next = settleLedger(next, job.id, 'speech', spoken.usd);
      if (aligned.usd) next = settleLedger(next, job.id, 'transcription', aligned.usd);
      return next;
    });
    done++;
  }
  await mutateAd(uid, projectId, (d) => ({ ...d, activeJobId: null, lastError: null }));
  const st = linkAdStatus((await loadAd(uid, projectId)).doc);
  await transition(job.id, 'completed', { stage: `${done} scene${done === 1 ? '' : 's'} recorded · ${st.totalSec.toFixed(1)} s${notes.length ? ' · ' + notes.join(' ') : ''}`, result: { data: { scenes: done, totalSec: st.totalSec, spentUsd: spent } } });
}

