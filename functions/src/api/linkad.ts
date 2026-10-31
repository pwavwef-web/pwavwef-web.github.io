import { HttpsError } from 'firebase-functions/v2/https';
import {
  ACTIVE_STATUSES,
  assembleLinkAd,
  checkPublicUrl,
  compositionHash,
  EXPORT_PRESETS,
  estimateRender,
  factHash,
  allFacts,
  linkAdReadiness,
  linkAdStatus,
  LINKAD_LIMITS,
  LINKAD_STAGE_LABELS,
  normalizeLinkAd,
  reviewScenes,
  stableHash,
  stampFor,
  usedFactsHash,
  type AssetDoc,
  type LinkAdDoc,
  type LinkAdEdit,
  type LinkAdRequest,
  type ReviseScope,
  type CostEstimate,
  defaultLinkAd,
  type ExportRecord,
  type LiteAssetInfo,
  buildPosterScript,
  defaultPoster,
  kitPhotosFirst,
  kitToLinkAdBrand,
  posterFormHash,
  posterInputHash,
  posterReadiness,
  POSTER_FORMATS,
  POSTER_MUSIC_PROMPTS,
  POSTER_TEMPLATE_INFO,
  reviewState,
  syncPosterFacts,
  todayKey,
  type BrandKitInput,
  type LinkAdAsset,
  type PosterForm,
  type UserFact,
} from '@az-studio/shared';
import { loadKit } from './brand-kits';
import { MODEL_REGISTRY } from '../config/models';
import { IS_EMULATOR } from '../config/runtime';
import { col, db, FieldValue } from '../lib/firebase';
import { FIRECRAWL_SECRET } from '../lib/linkad-site';
import { briefEstimate, directionsEstimate, reviseEstimate, voiceEstimate } from '../lib/linkad-model';
import {
  FIXTURES_ALLOWED,
  activeJobFor,
  addLedger,
  assertLinkAdAccess,
  assertWithinAdCap,
  committedUsd,
  consumeQuota,
  createLinkAdJob,
  linkAdEntitlement,
  linkAdJobId,
  loadAd,
  moveStage,
  mutateAd,
  type LinkAdStep,
} from '../lib/linkad-store';
import { probe } from '../lib/media';
import { mediaInputUrl } from '../lib/media-proxy';
import { loadAssets } from '../lib/prepare';
import { createJobs, prepareAll } from '../lib/submit';
import { readOptionalSecret } from '../lib/secrets';
import type { Owner } from '../lib/owner';
import { assertRateLimit, assertWithinLimits, getSettings, spendSnapshot } from '../lib/usage';
import { PRICING } from '../config/pricing';
import { cancelJob } from './actions';
import { withLock } from './lite';

type Req<O extends LinkAdRequest['op']> = Extract<LinkAdRequest, { op: O }>;

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------
// Configuration the interface needs (never a key, a balance or another owner's data)
// ---------------------------------------------------------------------------

async function config(owner: Owner) {
  const ent = await linkAdEntitlement(owner);
  const firecrawl = Boolean(IS_EMULATOR ? process.env[FIRECRAWL_SECRET]?.trim() : await readOptionalSecret(FIRECRAWL_SECRET));
  const setup: { id: string; level: 'info' | 'action'; message: string }[] = [];
  if (!firecrawl) setup.push({ id: 'firecrawl', level: 'info', message: `Script-built pages can't be read without a Firecrawl key. Optional: store it as the secret ${FIRECRAWL_SECRET}. Ordinary pages work without it.` });
  return {
    entitlement: ent,
    providers: { reasoning: MODEL_REGISTRY.reasoning.displayName, speech: MODEL_REGISTRY.speech.displayName, transcription: MODEL_REGISTRY.transcription.displayName, image: MODEL_REGISTRY.image.displayName, music: MODEL_REGISTRY.music.displayName, firecrawl },
    fixturesAllowed: FIXTURES_ALLOWED(),
    limits: { maxPages: LINKAD_LIMITS.maxPagesCap, durationMin: LINKAD_LIMITS.durationMin, durationMax: LINKAD_LIMITS.durationMax, scenes: [LINKAD_LIMITS.minScenes, LINKAD_LIMITS.maxScenes] },
    pricing: { version: PRICING.version, source: PRICING.source },
    setup,
  };
}

// ---------------------------------------------------------------------------
// Creating an ad
// ---------------------------------------------------------------------------

async function create(owner: Owner, p: Req<'create'>) {
  const ent = await assertLinkAdAccess(owner);
  await assertRateLimit(owner.uid, 1, 30);
  const fixture = p.fixture && FIXTURES_ALLOWED();
  if (p.fixture && !fixture) throw new HttpsError('failed-precondition', 'Fixture mode is available only in the emulators and tests.');
  const url = p.url.trim();
  const manual = p.manualText.trim();
  if (url) {
    const c = checkPublicUrl(url);
    if (!c.ok) throw new HttpsError('invalid-argument', c.reason);
  } else if (manual.length < 20) throw new HttpsError('invalid-argument', 'Paste a website address, or write at least a few lines about what you want to promote.');
  const extra: string[] = [];
  for (const raw of p.extraUrls.map((x) => x.trim()).filter(Boolean)) {
    const c = checkPublicUrl(raw);
    if (!c.ok) throw new HttpsError('invalid-argument', `“${raw.slice(0, 60)}”: ${c.reason}`);
    extra.push(c.url.toString());
  }
  const host = url ? (checkPublicUrl(url) as { ok: true; url: URL }).url.hostname.replace(/^www\./, '') : '';
  const title = (p.promote.trim() || host || 'New ad').slice(0, 120);
  const id = `la${stableHash([owner.uid, p.requestId])}`.slice(0, 40);
  const ref = col.projects().doc(id);
  const doc: LinkAdDoc = {
    ...defaultLinkAd({ url: url ? (checkPublicUrl(url) as { ok: true; url: URL }).url.toString() : '', promote: p.promote.trim(), manualText: manual, maxPages: Math.min(LINKAD_LIMITS.maxPagesCap, p.maxPages ?? LINKAD_LIMITS.defaultMaxPages), extraUrls: extra }),
    mode: fixture ? 'fixture' : 'live',
    updatedAt: Date.now(),
  };
  const created = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      if (snap.get('ownerUid') !== owner.uid) throw new HttpsError('not-found', 'Ad not found.');
      return false;
    }
    tx.set(ref, { ownerUid: owner.uid, title, type: 'link_ad', logline: '', idea: '', genre: '', status: 'active', format: { aspectRatio: '9:16', fps: 30 }, coverAssetId: null, styleBible: {}, linkad: { ...doc, spend: { ...doc.spend, capUsd: Math.min(doc.spend.capUsd, ent.quotas.maxSpendCapUsd) } }, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    return true;
  });
  return { projectId: id, created };
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

function assertAssetsExist(doc: LinkAdDoc, ids: (string | null | undefined)[], what: string) {
  const known = new Set(doc.source.assets.map((a) => a.id));
  for (const id of ids) if (id && !known.has(id)) throw new HttpsError('invalid-argument', `${what} refers to a picture that is not in this ad.`);
}

export function applyEdit(doc0: LinkAdDoc, e: LinkAdEdit, maxCap: number): LinkAdDoc {
  let d = doc0;
  if (e.input) {
    const input = { ...d.input, ...e.input };
    if (e.input.url !== undefined && input.url.trim()) {
      const c = checkPublicUrl(input.url);
      if (!c.ok) throw new HttpsError('invalid-argument', c.reason);
      input.url = c.url.toString();
    }
    for (const u of input.extraUrls) {
      const c = checkPublicUrl(u);
      if (!c.ok) throw new HttpsError('invalid-argument', `“${u.slice(0, 60)}”: ${c.reason}`);
    }
    d = { ...d, input: { ...input, sourceKind: d.input.sourceKind, maxPages: Math.min(LINKAD_LIMITS.maxPagesCap, input.maxPages) } };
    if (e.input.rightsConfirmed !== undefined) d = { ...d, source: { ...d.source, assets: d.source.assets.map((a) => (a.origin === 'site' ? { ...a, rights: e.input!.rightsConfirmed ? 'confirmed' : 'unconfirmed' } : a)) } };
  }
  if (e.userFacts) {
    const seen = new Set<string>();
    for (const f of e.userFacts) {
      if (seen.has(f.id)) throw new HttpsError('invalid-argument', 'Two facts share an id.');
      seen.add(f.id);
    }
    d = { ...d, userFacts: e.userFacts.map((f) => ({ ...f, text: flat(f.text) })).filter((f) => f.text) };
  }
  if (e.factEdits) {
    const edits = e.factEdits;
    d = { ...d, source: { ...d.source, facts: d.source.facts.map((f) => (edits[f.id] !== undefined ? { ...f, text: flat(edits[f.id]!).slice(0, 400), edited: true } : f)) } };
  }
  const byId = () => new Map(allFacts(d).map((f) => [f.id, f]));
  if (e.confirm?.length) {
    const facts = byId();
    const c = { ...d.confirmations };
    for (const fid of e.confirm) {
      const f = facts.get(fid);
      if (!f) throw new HttpsError('invalid-argument', 'That fact no longer exists.');
      c[fid] = factHash(f);
    }
    d = { ...d, confirmations: c };
  }
  if (e.unconfirm?.length) {
    const c = { ...d.confirmations };
    for (const fid of e.unconfirm) delete c[fid];
    d = { ...d, confirmations: c };
  }
  if (e.assets) {
    const upd = new Map(e.assets.map((a) => [a.id, a]));
    d = { ...d, source: { ...d.source, assets: d.source.assets.map((a) => {
      const u = upd.get(a.id);
      if (!u) return a;
      return { ...a, ...(u.selected !== undefined ? { selected: u.selected } : {}), ...(u.rights !== undefined ? { rights: u.rights } : {}), ...(u.reviewed !== undefined ? { reviewed: u.reviewed } : {}), ...(u.role !== undefined ? { role: u.role } : {}), ...(u.alt !== undefined ? { alt: u.alt } : {}) };
    }) } };
  }
  if (e.brief) {
    const b = { ...d.brief, ...e.brief };
    assertAssetsExist(d, [b.logoId, ...b.imageIds], 'The brief');
    const known = new Set(allFacts(d).map((f) => f.id));
    b.usedFactIds = b.usedFactIds.filter((x) => known.has(x));
    d = { ...d, brief: { ...b, origin: 'manual' } };
  }
  if (e.ad) {
    const a = e.ad;
    let ad = d.ad;
    if (a.title !== undefined) ad = { ...ad, title: a.title };
    if (a.scenes) {
      const ids = new Set<string>();
      for (const s of a.scenes) {
        if (ids.has(s.id)) throw new HttpsError('invalid-argument', 'Two scenes share an id.');
        ids.add(s.id);
      }
      assertAssetsExist(d, a.scenes.map((s) => s.assetId), 'A scene');
      const known = new Set(allFacts(d).map((f) => f.id));
      const prev = new Map(ad.scenes.map((s) => [s.id, s]));
      const scenes = a.scenes.map((s) => {
        const before = prev.get(s.id);
        const factIds = s.factIds.filter((x) => known.has(x));
        // A scene's fact stamp is written when its words are: new scenes, or scenes whose words changed, are stamped now.
        const words = before && before.narration === s.narration && before.overlay === s.overlay;
        // New facts are stamped now; facts the scene already relied on keep the stamp from when its words were written.
        const factStamp = words ? { ...stampFor(d, factIds.filter((x) => before!.factStamp[x] === undefined)), ...Object.fromEntries(factIds.filter((x) => before!.factStamp[x] !== undefined).map((x) => [x, before!.factStamp[x]!])) } : stampFor(d, factIds);
        return { ...s, narration: flat(s.narration), overlay: flat(s.overlay), factIds, factStamp };
      });
      const takes = Object.fromEntries(Object.entries(ad.takes).filter(([sid]) => ids.has(sid)));
      ad = { ...ad, scenes, takes };
    }
    if (a.closing) ad = { ...ad, closing: { ...ad.closing, ...a.closing } };
    if (a.brand) ad = { ...ad, brand: { ...ad.brand, ...a.brand } };
    if (a.captions) ad = { ...ad, captions: { ...ad.captions, ...a.captions } };
    if (a.voiceGainDb !== undefined) ad = { ...ad, voiceGainDb: a.voiceGainDb };
    if (a.music) ad = { ...ad, music: { ...ad.music, ...a.music } };
    d = { ...d, ad };
  }
  if (e.spendCapUsd !== undefined) d = { ...d, spend: { ...d.spend, capUsd: Math.min(maxCap, e.spendCapUsd) } };
  if (e.poster) {
    if (!d.poster) throw new HttpsError('failed-precondition', 'This ad has no poster form.');
    const poster: PosterForm = { ...d.poster, ...Object.fromEntries(Object.entries(e.poster).filter(([, v]) => v !== undefined)) };
    assertAssetsExist(d, poster.photoIds, 'The poster');
    const rows = [...poster.prices.map((x) => x.id), ...poster.contacts.map((x) => x.id)];
    if (new Set(rows).size !== rows.length) throw new HttpsError('invalid-argument', 'Two prices or contacts share an id.');
    // The form's facts are the ad's facts: re-derived on every change (an edited price is no longer confirmed).
    d = syncPosterFacts({ ...d, poster });
  }
  // Wording that rests on a fact that has changed is flagged for review.
  d = { ...d, ad: { ...d.ad, scenes: reviewScenes(d) } };
  return d;
}

async function edit(owner: Owner, p: Req<'edit'>) {
  const ent = await assertLinkAdAccess(owner);
  if (p.edit.ad?.music?.assetId) {
    const a = await col.assets().doc(p.edit.ad.music.assetId).get();
    if (!a.exists || a.get('ownerUid') !== owner.uid || a.get('kind') !== 'audio' || a.get('status') !== 'ready') throw new HttpsError('invalid-argument', 'Choose music from your own library (a ready audio file).');
    if (!p.edit.ad.music.title) p.edit.ad.music.title = String(a.get('title') ?? '').slice(0, 160);
  }
  if (p.edit.ad?.music && p.edit.ad.music.assetId === null) p.edit.ad.music = { assetId: null, title: '', rightsConfirmed: false };
  const doc = await mutateAd(owner.uid, p.projectId, (d) => applyEdit(d, p.edit, ent.quotas.maxSpendCapUsd), { expectedRevision: p.revision });
  return { revision: doc.revision };
}

// ---------------------------------------------------------------------------
// Starting a step (one at a time, idempotent, inside the ad's cap and the owner's limits)
// ---------------------------------------------------------------------------

interface StartArgs {
  owner: Owner;
  projectId: string;
  step: LinkAdStep;
  requestId: string;
  label: string;
  estimate: CostEstimate;
  ledgerKind: 'reasoning' | 'speech';
  units: string;
  params?: Record<string, unknown>;
  stage?: 'analysing' | 'planning';
  stageNote?: string;
  quota?: { kind: 'analyses' | 'voiceRuns'; limit: number };
}

async function startStep(a: StartArgs) {
  const { owner, projectId } = a;
  const jobId = linkAdJobId(projectId, a.step, a.requestId);
  return withLock(projectId, `linkad_${a.step}`, async () => {
    const { doc } = await loadAd(owner.uid, projectId);
    if ((await col.jobs().doc(jobId).get()).exists) return { jobId, started: false };
    const running = await activeJobFor(owner.uid, projectId);
    if (running) throw new HttpsError('failed-precondition', 'Another step is still running for this ad. Wait for it to finish, or stop it first.', { reason: 'busy', jobId: running.id });
    assertWithinAdCap(doc, a.estimate.usd);
    if (a.estimate.usd > 0) assertWithinLimits(await getSettings(owner.uid), await spendSnapshot(owner.uid), a.estimate.usd);
    if (a.quota) await consumeQuota(owner.uid, a.quota.kind, a.quota.limit);
    await assertRateLimit(owner.uid, 1, 30);
    await mutateAd(owner.uid, projectId, (d) => {
      const moved = a.stage ? moveStage(d, a.stage, a.stageNote ?? '') : d;
      return addLedger({ ...moved, activeJobId: jobId, lastError: null }, { step: a.step, kind: a.ledgerKind, units: a.units, estimateUsd: a.estimate.usd, actualUsd: null, jobId, basis: d.mode === 'fixture' ? 'fixture' : 'published_rate' });
    });
    try {
      const r = await createLinkAdJob({ uid: owner.uid, projectId, step: a.step, requestId: a.requestId, label: a.label, params: a.params ?? {}, estimate: a.estimate });
      return { jobId: r.jobId, started: r.created };
    } catch (e) {
      // The job could not be queued: put the ad back so nothing looks like it is running.
      await mutateAd(owner.uid, projectId, (d) => ({ ...d, activeJobId: null, stage: a.stage ? (d.source.facts.length || d.userFacts.length ? 'reviewing' : 'draft') : d.stage })).catch(() => undefined);
      throw e;
    }
  });
}

/** What a step would cost, and whether the ad's cap and the owner's limits allow it (nothing is started). */
async function stepEstimate(uid: string, doc: LinkAdDoc, est: CostEstimate) {
  let problem: string | null = null;
  try {
    assertWithinAdCap(doc, est.usd);
    if (est.usd > 0) assertWithinLimits(await getSettings(uid), await spendSnapshot(uid), est.usd);
  } catch (e) {
    problem = (e as Error).message;
  }
  return { jobId: null, started: false, estimate: est, capUsd: doc.spend.capUsd, committedUsd: committedUsd(doc), problem, fixture: doc.mode === 'fixture' };
}

async function analyse(owner: Owner, p: Req<'analyse'>) {
  const ent = await assertLinkAdAccess(owner);
  const { doc } = await loadAd(owner.uid, p.projectId);
  if (doc.input.sourceKind === 'facts') throw new HttpsError('failed-precondition', 'A motion poster ad is made from its facts form, not a website. Use “Write the ad from the facts”.');
  if (!p.manualOnly && !doc.input.url.trim() && doc.input.manualText.trim().length < 20) throw new HttpsError('failed-precondition', 'Add a website address, or write a few lines about what to promote.');
  const est = briefEstimate(doc, 9000);
  if (p.estimateOnly) return stepEstimate(owner.uid, doc, est);
  return startStep({ owner, projectId: p.projectId, step: 'analyse', requestId: p.requestId, label: `Read ${doc.input.url ? new URL(doc.input.url).hostname : 'your notes'}`, estimate: est, ledgerKind: 'reasoning', units: `${Math.min(doc.input.maxPages, LINKAD_LIMITS.maxPagesCap)} page(s) max`, params: { manualOnly: p.manualOnly }, ...(doc.briefApprovedAt || doc.ad.scenes.length ? {} : { stage: 'analysing' as const, stageNote: 'Reading the website…' }), quota: { kind: 'analyses', limit: ent.quotas.analysesPerDay } });
}

async function approveBrief(owner: Owner, p: Req<'approveBrief'>) {
  await assertLinkAdAccess(owner);
  const doc = await mutateAd(
    owner.uid,
    p.projectId,
    (d) => {
      if (!d.brief.focus.trim()) throw new HttpsError('failed-precondition', 'Say what the ad promotes first.');
      if (d.brief.durationSec < LINKAD_LIMITS.durationMin || d.brief.durationSec > LINKAD_LIMITS.durationMax) throw new HttpsError('failed-precondition', 'Choose a length between 15 and 30 seconds.');
      return { ...d, briefApprovedAt: Date.now(), briefApprovedHash: usedFactsHash(d) };
    },
    { expectedRevision: p.revision },
  );
  return { revision: doc.revision };
}

async function plan(owner: Owner, p: Req<'plan'>) {
  await assertLinkAdAccess(owner);
  const { doc } = await loadAd(owner.uid, p.projectId);
  if (!doc.briefApprovedAt && !p.estimateOnly) throw new HttpsError('failed-precondition', 'Approve the brief first.');
  if (doc.stage === 'draft' || doc.stage === 'analysing') throw new HttpsError('failed-precondition', 'Read the website first.');
  const est = directionsEstimate(doc);
  if (p.estimateOnly) return stepEstimate(owner.uid, doc, est);
  return startStep({ owner, projectId: p.projectId, step: 'directions', requestId: p.requestId, label: 'Plan three directions', estimate: est, ledgerKind: 'reasoning', units: '3 directions', stage: 'planning', stageNote: 'Planning three directions…' });
}

async function selectDirection(owner: Owner, p: Req<'selectDirection'>) {
  await assertLinkAdAccess(owner);
  const doc = await mutateAd(owner.uid, p.projectId, (d) => {
    const dir = d.directions.find((x) => x.id === p.directionId);
    if (!dir) throw new HttpsError('not-found', 'That direction is no longer available.');
    const known = new Set(d.source.assets.filter((a) => a.status === 'stored').map((a) => a.id));
    const scenes = dir.scenes.map((s) => ({ ...s, assetId: s.assetId && known.has(s.assetId) ? s.assetId : null, factStamp: stampFor(d, s.factIds) }));
    const ad = { ...d.ad, directionId: dir.id, title: dir.title, scenes, closing: dir.closing, takes: {} };
    const moved = d.stage === 'generating' ? d : moveStage(d, 'generating', 'Edit the script, then make the voice.', { force: true });
    return { ...moved, ad };
  });
  return { revision: doc.revision };
}

async function revise(owner: Owner, p: Req<'revise'>) {
  await assertLinkAdAccess(owner);
  const { doc } = await loadAd(owner.uid, p.projectId);
  if (!doc.ad.scenes.length) throw new HttpsError('failed-precondition', 'Choose a direction first.');
  if (p.scope === 'scene' && !doc.ad.scenes.some((s) => s.id === p.sceneId)) throw new HttpsError('invalid-argument', 'Choose a scene to rewrite.');
  const est = reviseEstimate(doc, p.scope as ReviseScope);
  if (p.estimateOnly) return stepEstimate(owner.uid, doc, est);
  return startStep({ owner, projectId: p.projectId, step: 'revise', requestId: p.requestId, label: p.scope === 'hook' ? 'Rewrite the hook' : p.scope === 'script' ? 'Rewrite the script' : 'Rewrite a scene', estimate: est, ledgerKind: 'reasoning', units: p.scope, params: { scope: p.scope, sceneId: p.sceneId, guidance: flat(p.guidance) } });
}

async function voice(owner: Owner, p: Req<'voice'>) {
  const ent = await assertLinkAdAccess(owner);
  const { doc } = await loadAd(owner.uid, p.projectId);
  const st = linkAdStatus(doc);
  const wanted = st.scenesNeedingVoice.filter((id) => !p.sceneIds || p.sceneIds.includes(id));
  if (!doc.ad.scenes.length) throw new HttpsError('failed-precondition', 'Choose a direction first.');
  if (!wanted.length) return { jobId: null, started: false, noop: true, message: 'Every scene already has a current recording.', estimate: null };
  const scenes = doc.ad.scenes.filter((s) => wanted.includes(s.id));
  const est = voiceEstimate(scenes);
  const settings = await getSettings(owner.uid);
  const interrupted = scenes.filter((s) => doc.voiceInFlight[s.id]).map((s) => s.id);
  const needsConfirm = est.usd >= settings.confirmAboveUsd;
  if (p.estimateOnly) {
    let problem: string | null = null;
    try {
      assertWithinAdCap(doc, est.usd);
      assertWithinLimits(settings, await spendSnapshot(owner.uid), est.usd);
    } catch (e) {
      problem = (e as Error).message;
    }
    return { jobId: null, started: false, noop: false, estimate: est, sceneIds: wanted, interrupted, needsConfirm, capUsd: doc.spend.capUsd, committedUsd: committedUsd(doc), problem, fixture: doc.mode === 'fixture' };
  }
  if (interrupted.length && !p.acknowledgeInterrupted) throw new HttpsError('failed-precondition', 'An earlier recording for this scene was interrupted and may already have been charged. Retrying records it again and may be charged again. Confirm to go ahead.', { reason: 'interrupted', sceneIds: interrupted });
  if (needsConfirm && (p.confirmedUsd === null || p.confirmedUsd + 0.005 < est.usd)) throw new HttpsError('failed-precondition', 'Confirm the estimated cost before recording.', { reason: 'confirmation_required', estimate: est });
  const r = await startStep({ owner, projectId: p.projectId, step: 'voice', requestId: p.requestId, label: `Record the voice (${scenes.length} scene${scenes.length === 1 ? '' : 's'})`, estimate: est, ledgerKind: 'speech', units: `${scenes.length} scene(s)`, params: { sceneIds: wanted }, quota: { kind: 'voiceRuns', limit: ent.quotas.voiceRunsPerDay } });
  if (r.started && interrupted.length) await mutateAd(owner.uid, p.projectId, (d) => ({ ...d, voiceInFlight: Object.fromEntries(Object.entries(d.voiceInFlight).filter(([k]) => !interrupted.includes(k))) }));
  return { ...r, noop: false, estimate: est };
}

// ---------------------------------------------------------------------------
// Export: composition -> timeline -> real render -> checks on the finished file
// ---------------------------------------------------------------------------

function studioAssetIds(doc: LinkAdDoc): string[] {
  const refs = new Map(doc.source.assets.map((a) => [a.id, a]));
  const ids = new Set<string>();
  for (const s of doc.ad.scenes) {
    const a = s.assetId ? refs.get(s.assetId) : null;
    if (a?.assetId) ids.add(a.assetId);
  }
  const logo = doc.brief.logoId ? refs.get(doc.brief.logoId) : null;
  if (logo?.assetId && doc.ad.closing.showLogo) ids.add(logo.assetId);
  for (const t of Object.values(doc.ad.takes)) ids.add(t.assetId);
  if (doc.ad.music.assetId) ids.add(doc.ad.music.assetId);
  return [...ids];
}

async function exportAd(owner: Owner, p: Req<'export'>) {
  const ent = await assertLinkAdAccess(owner);
  const loaded = await loadAd(owner.uid, p.projectId);
  const doc = loaded.doc;
  const final = p.quality === 'final';
  const issues = linkAdReadiness(doc, { final });
  const blocking = issues.filter((i) => i.severity === 'error');
  if (blocking.length) throw new HttpsError('failed-precondition', `Fix ${blocking.length} problem${blocking.length === 1 ? '' : 's'} before exporting: ${blocking.slice(0, 3).map((i) => i.message).join(' ')}`, { reason: 'not_ready', issues: blocking.slice(0, 20) });
  // Every file the video uses must be the owner's and ready (loadAssets refuses anything else).
  const assets = await loadAssets(owner.uid, studioAssetIds(doc));
  const info: Record<string, LiteAssetInfo> = {};
  for (const a of assets.values()) info[a.id] = { width: a.width ?? null, height: a.height ?? null, durationSec: a.durationSec ?? null };
  const preset = EXPORT_PRESETS.vertical_9x16;
  const assembly = assembleLinkAd({ doc, assets: info, outWidth: final ? preset.final.width : preset.draft.width });
  const problems = assembly.issues.filter((i) => i.severity === 'error');
  if (problems.length) throw new HttpsError('failed-precondition', `The composition has problems: ${problems.slice(0, 3).map((i) => i.message).join(' ')}`, { reason: 'composition', issues: problems.slice(0, 20) });
  if (assembly.durationSec < LINKAD_LIMITS.durationMin - 0.3 || assembly.durationSec > LINKAD_LIMITS.durationMax + 0.3) throw new HttpsError('failed-precondition', `The ad runs ${assembly.durationSec.toFixed(1)} s; it must be between ${LINKAD_LIMITS.durationMin} and ${LINKAD_LIMITS.durationMax} s.`, { reason: 'length' });

  const hash = compositionHash(doc);
  const render = { type: 'render.timeline' as const, projectId: p.projectId, timelineId: 'pending', preset: 'vertical_9x16' as const, quality: p.quality, inspect: false, skipInspection: true, acceptLyricSync: false, audioMaster: 'normalize' as const, label: `${loaded.title} · ${final ? 'final 1080×1920' : 'draft preview'}` };
  if (p.estimateOnly) {
    // Price against the composition as it would be saved (no timeline is written for an estimate).
    const prepared = await prepareRenderEstimate(owner.uid, assembly.durationSec, p.quality);
    return { estimate: prepared, durationSec: assembly.durationSec, warnings: issues.filter((i) => i.severity === 'warning').slice(0, 20), fixture: doc.mode === 'fixture' };
  }
  await consumeQuota(owner.uid, 'exports', ent.quotas.exportsPerDay);
  return withLock(p.projectId, 'linkad_export', async () => {
    const fresh = (await loadAd(owner.uid, p.projectId)).doc;
    const dup = fresh.exports.find((x) => x.timelineHash === hash && x.quality === p.quality && (x.status === 'queued' || x.status === 'rendering'));
    if (dup) return { renderId: dup.renderId, jobId: dup.jobId, started: false, durationSec: assembly.durationSec };
    // Save the composition as the project's timeline (what the renderer and preview read).
    const tlRef = fresh.timelineId ? col.timelines(p.projectId).doc(fresh.timelineId) : col.timelines(p.projectId).doc();
    const prev = await tlRef.get();
    const version = prev.exists ? Number(prev.get('version') ?? 1) + 1 : 1;
    await tlRef.set({ ownerUid: owner.uid, projectId: p.projectId, name: `${loaded.title} — 9:16`, fps: assembly.state.fps, aspectRatio: '9:16', tracks: assembly.state.tracks, clips: assembly.state.clips, markers: assembly.state.markers, beatGrid: null, version, durationSec: assembly.durationSec, ...(prev.exists ? {} : { createdAt: FieldValue.serverTimestamp() }), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    const res = await createJobs(owner.uid, [{ ...render, timelineId: tlRef.id }], { confirmedUsd: p.confirmedUsd, batchLabel: render.label });
    const renderId = res.prepared[0]!.render!.renderId;
    const record: ExportRecord = { renderId, jobId: res.jobIds[0]!, quality: p.quality, timelineHash: hash, at: Date.now(), status: 'queued', outputAssetId: null, durationSec: null, checks: null, error: null };
    await mutateAd(owner.uid, p.projectId, (d) => {
      const moved = d.stage === 'composing' ? d : moveStage(d, 'composing', `Exporting the ${final ? 'final' : 'draft'} video…`, { force: true });
      return addLedger({ ...moved, timelineId: tlRef.id, exports: [record, ...d.exports].slice(0, LINKAD_LIMITS.exports) }, { step: 'export', kind: 'render', units: `${assembly.durationSec.toFixed(1)} s ${p.quality}`, estimateUsd: res.estimate.usd, actualUsd: null, jobId: res.jobIds[0]!, basis: 'published_rate' });
    });
    return { renderId, jobId: res.jobIds[0]!, started: true, durationSec: assembly.durationSec, estimate: res.estimate };
  });
}

async function prepareRenderEstimate(_uid: string, durationSec: number, quality: 'draft' | 'final'): Promise<CostEstimate> {
  return estimateRender({ durationSec, quality }, PRICING);
}

/** Checks the finished file itself (duration, picture and sound streams, size, codecs), not just that the renderer said it finished. */
export async function validateExport(outputAssetId: string, expectedSec: number, quality: 'draft' | 'final'): Promise<NonNullable<ExportRecord['checks']>> {
  const snap = await col.assets().doc(outputAssetId).get();
  const notes: string[] = [];
  if (!snap.exists) return { ok: false, measuredSec: null, expectedSec, width: null, height: null, videoCodec: null, audioCodec: null, notes: ['The exported file was not found.'] };
  const info = await probe(await mediaInputUrl(String(snap.get('storagePath'))));
  const want = EXPORT_PRESETS.vertical_9x16[quality === 'final' ? 'final' : 'draft'];
  if (!info.hasVideo) notes.push('The file has no picture.');
  if (!info.hasAudio) notes.push('The file has no sound.');
  if (info.durationSec === null || Math.abs(info.durationSec - expectedSec) > 0.6) notes.push(`The file runs ${info.durationSec?.toFixed(2) ?? '?'} s but the plan was ${expectedSec.toFixed(2)} s.`);
  if (info.width !== want.width || info.height !== want.height) notes.push(`The picture is ${info.width}×${info.height}, expected ${want.width}×${want.height}.`);
  if (info.videoCodec && info.videoCodec !== 'h264') notes.push(`Video codec is ${info.videoCodec}, expected h264.`);
  if (info.audioCodec && info.audioCodec !== 'aac') notes.push(`Audio codec is ${info.audioCodec}, expected aac.`);
  return { ok: notes.length === 0, measuredSec: info.durationSec, expectedSec, width: info.width, height: info.height, videoCodec: info.videoCodec, audioCodec: info.audioCodec, notes };
}

/** Brings the ad's export records in line with the renders (status, output file, measured checks) and the stage with them. */
export async function syncExports(uid: string, projectId: string): Promise<LinkAdDoc> {
  const { doc } = await loadAd(uid, projectId);
  const open = doc.exports.filter((e) => e.status === 'queued' || e.status === 'rendering' || (e.status === 'completed' && !e.checks));
  if (!open.length) return doc;
  const updates = new Map<string, Partial<ExportRecord>>();
  for (const e of open) {
    const r = await col.renders().doc(e.renderId).get();
    if (!r.exists || r.get('ownerUid') !== uid || r.get('projectId') !== projectId) continue;
    const status = String(r.get('status')) as ExportRecord['status'];
    if (status === 'completed' && r.get('outputAssetId')) {
      const outputAssetId = String(r.get('outputAssetId'));
      const expected = Number(r.get('durationSec') ?? e.durationSec ?? 0);
      let checks: ExportRecord['checks'];
      try {
        checks = await validateExport(outputAssetId, expected, e.quality);
      } catch (err) {
        checks = { ok: false, measuredSec: null, expectedSec: expected, width: null, height: null, videoCodec: null, audioCodec: null, notes: [`The file could not be checked: ${String((err as Error)?.message ?? err).slice(0, 160)}`] };
      }
      updates.set(e.renderId, { status: 'completed', outputAssetId, durationSec: checks.measuredSec, checks });
    } else if (status === 'failed' || status === 'cancelled') updates.set(e.renderId, { status, error: String(r.get('error.message') ?? r.get('stage') ?? '').slice(0, 300) || null });
    else if (status !== e.status) updates.set(e.renderId, { status: status === 'rendering' ? 'rendering' : 'queued' });
  }
  if (!updates.size) return doc;
  return mutateAd(uid, projectId, (d) => {
    const exports = d.exports.map((e) => (updates.has(e.renderId) ? { ...e, ...updates.get(e.renderId)! } : e));
    let next: LinkAdDoc = { ...d, exports };
    const running = exports.some((e) => e.status === 'queued' || e.status === 'rendering');
    const good = exports.find((e) => e.status === 'completed' && e.checks?.ok && e.quality === 'final');
    if (!running && d.stage === 'composing') next = moveStage(next, good ? 'ready' : 'generating', good ? 'Your video is ready.' : 'The export did not finish; your work is kept.');
    const failed = [...updates.entries()].find(([, u]) => u.status === 'failed');
    if (failed) next = { ...next, lastError: { message: String(updates.get(failed[0])!.error ?? 'The export failed.'), step: 'export', at: Date.now(), retryable: true } };
    return next;
  });
}

// ---------------------------------------------------------------------------
// Pictures
// ---------------------------------------------------------------------------

async function addAsset(owner: Owner, p: Req<'addAsset'>) {
  await assertLinkAdAccess(owner);
  const a = await col.assets().doc(p.assetId).get();
  if (!a.exists || a.get('ownerUid') !== owner.uid) throw new HttpsError('not-found', 'Picture not found.');
  if (a.get('kind') !== 'image' || a.get('status') !== 'ready') throw new HttpsError('invalid-argument', 'Choose a ready picture (JPEG, PNG or WebP).');
  const asset = { id: a.id, ...(a.data() as Omit<AssetDoc, 'id'>) } as AssetDoc;
  const doc = await mutateAd(owner.uid, p.projectId, (d) => {
    if (d.source.assets.some((x) => x.assetId === asset.id)) throw new HttpsError('already-exists', 'That picture is already in this ad.');
    const ref = { id: `a_${stableHash([asset.id])}`, assetId: asset.id, role: p.role, origin: 'upload' as const, url: null, pageUrl: null, alt: asset.title.slice(0, 240), width: asset.width ?? null, height: asset.height ?? null, bytes: asset.sizeBytes ?? null, mime: asset.mimeType ?? null, status: 'stored' as const, rejectReason: null, rights: p.rightsConfirmed ? ('confirmed' as const) : ('unconfirmed' as const), needsReview: false, reviewed: false, selected: true, note: 'Uploaded by you' };
    const brief = p.role === 'logo' && !d.brief.logoId ? { ...d.brief, logoId: ref.id } : p.role === 'image' ? { ...d.brief, imageIds: [...d.brief.imageIds, ref.id].slice(0, LINKAD_LIMITS.maxImages) } : d.brief;
    return { ...d, brief, source: { ...d.source, assets: [...d.source.assets, ref].slice(0, 40) } };
  });
  return { revision: doc.revision };
}

async function enhance(owner: Owner, p: Req<'enhance'>) {
  await assertLinkAdAccess(owner);
  const { doc, title } = await loadAd(owner.uid, p.projectId);
  const scene = doc.ad.scenes.find((s) => s.id === p.sceneId);
  const ref = scene?.assetId ? doc.source.assets.find((a) => a.id === scene.assetId) : null;
  if (!scene || !ref?.assetId) throw new HttpsError('failed-precondition', 'This scene has no picture to enhance.');
  if (ref.rights !== 'confirmed') throw new HttpsError('failed-precondition', 'Confirm you may use this picture before changing it.');
  const request = {
    type: 'image.generate' as const,
    projectId: p.projectId,
    prompt: 'Recompose this exact photograph into a vertical 9:16 frame for a mobile advert. Extend only the natural background (sky, wall, floor, water) to fill the taller frame. Keep every real object, room, person, building, product, packaging, sign and logo exactly as it appears, with the same colours and proportions. Do not add, remove or invent any object, text, logo, facility, food or decoration. No text or watermarks.',
    purpose: 'free' as const,
    aspectRatio: '9:16',
    imageSize: '1K',
    referenceAssetIds: [ref.assetId],
    referenceLabels: ['The real photograph to extend, unchanged'],
    grounding: false,
    applyStyleBible: false,
    characterIds: [],
    collections: ['linkad:enhance', `linkad:scene:${scene.id}`],
    title: `${title} · scene extension`,
    label: 'Extend a picture to vertical',
    target: { kind: 'linkad' as const, id: scene.id },
    inputHash: stableHash([ref.assetId, 'extend-vertical-v1']),
  };
  const prepared = await prepareAll(owner.uid, [request]);
  const est = prepared[0]!.estimate;
  if (p.estimateOnly) {
    let problem: string | null = null;
    try {
      assertWithinAdCap(doc, est.usd);
      assertWithinLimits(await getSettings(owner.uid), await spendSnapshot(owner.uid), est.usd);
    } catch (e) {
      problem = (e as Error).message;
    }
    return { estimate: est, problem, capUsd: doc.spend.capUsd, committedUsd: committedUsd(doc), warning: 'AI will redraw the background. Real products, rooms and logos are asked to stay unchanged, but you must look at the result before using it.' };
  }
  if (p.confirmedUsd === null || p.confirmedUsd + 0.005 < est.usd) throw new HttpsError('failed-precondition', 'Confirm the estimated cost first.', { reason: 'confirmation_required', estimate: est });
  assertWithinAdCap(doc, est.usd);
  const res = await createJobs(owner.uid, [request], { confirmedUsd: p.confirmedUsd });
  await mutateAd(owner.uid, p.projectId, (d) => addLedger(d, { step: 'enhance', kind: 'image', units: '1 picture', estimateUsd: res.estimate.usd, actualUsd: null, jobId: res.jobIds[0]!, basis: 'published_rate' }));
  return { jobId: res.jobIds[0]!, estimate: res.estimate };
}

/** Pulls finished picture enhancements into the ad as AI-made candidates that still need a look. */
async function collectEnhancements(uid: string, projectId: string): Promise<boolean> {
  const jobs = await col.jobs().where('ownerUid', '==', uid).where('projectId', '==', projectId).where('type', '==', 'image.generate').where('status', '==', 'completed').get();
  const done = jobs.docs.filter((j) => (j.get('params.collections') as string[] | undefined)?.includes('linkad:enhance'));
  if (!done.length) return false;
  const { doc } = await loadAd(uid, projectId);
  const known = new Set(doc.source.assets.map((a) => a.assetId));
  const fresh = done.filter((j) => {
    const aid = ((j.get('result.assetIds') as string[] | undefined) ?? [])[0];
    return aid && !known.has(aid);
  });
  if (!fresh.length) return false;
  await mutateAd(uid, projectId, (d) => {
    const assets = [...d.source.assets];
    let ledger = d;
    for (const j of fresh) {
      const aid = ((j.get('result.assetIds') as string[]) ?? [])[0]!;
      if (assets.some((a) => a.assetId === aid)) continue;
      const collections = j.get('params.collections') as string[];
      const sceneKey = collections.find((c) => c.startsWith('linkad:scene:'))?.slice('linkad:scene:'.length) ?? '';
      assets.push({ id: `a_${stableHash([aid])}`, assetId: aid, role: 'image', origin: 'generated', url: null, pageUrl: null, alt: 'AI-extended picture', width: null, height: null, bytes: null, mime: null, status: 'stored', rejectReason: null, rights: 'confirmed', needsReview: true, reviewed: false, selected: false, note: `Made by AI from the picture in ${sceneKey ? 'one of your scenes' : 'your ad'}. Check it before using it.` });
      ledger = { ...ledger, spend: { ...ledger.spend, ledger: ledger.spend.ledger.map((e) => (e.jobId === j.id && e.actualUsd === null ? { ...e, actualUsd: Number(j.get('usageUsd') ?? e.estimateUsd) } : e)) } };
    }
    return { ...ledger, source: { ...d.source, assets: assets.slice(0, 40) } };
  });
  return true;
}

// ---------------------------------------------------------------------------
// Stop, refresh, duplicate
// ---------------------------------------------------------------------------

async function cancel(owner: Owner, p: Req<'cancel'>) {
  await assertLinkAdAccess(owner);
  await loadAd(owner.uid, p.projectId);
  const active = await col.jobs().where('ownerUid', '==', owner.uid).where('projectId', '==', p.projectId).where('status', 'in', [...ACTIVE_STATUSES]).get();
  const results: { jobId: string; status: string }[] = [];
  for (const d of active.docs) {
    const t = d.get('type');
    if (t !== 'linkad.run' && t !== 'render.timeline' && t !== 'image.generate' && t !== 'music.generate') continue;
    const r = await cancelJob(owner, { jobId: d.id });
    results.push({ jobId: d.id, status: r.status });
  }
  return { stopped: results.length, results };
}

async function refresh(owner: Owner, p: Req<'refresh'>) {
  await assertLinkAdAccess(owner);
  await collectEnhancements(owner.uid, p.projectId).catch(() => false);
  await collectMusic(owner.uid, p.projectId).catch(() => false);
  const doc = await syncExports(owner.uid, p.projectId);
  const active = await activeJobFor(owner.uid, p.projectId);
  // A step that finished (or died) without clearing the marker must not leave the ad looking busy.
  if (!active && doc.activeJobId) {
    const fixed = await mutateAd(owner.uid, p.projectId, (d) => ({ ...d, activeJobId: null }));
    return { revision: fixed.revision, stage: fixed.stage, stageLabel: LINKAD_STAGE_LABELS[fixed.stage] };
  }
  return { revision: doc.revision, stage: doc.stage, stageLabel: LINKAD_STAGE_LABELS[doc.stage] };
}

async function duplicate(owner: Owner, p: Req<'duplicate'>) {
  await assertLinkAdAccess(owner);
  const src = await loadAd(owner.uid, p.projectId);
  const id = `${src.type === 'poster_ad' ? 'pa' : 'la'}${stableHash([owner.uid, p.requestId, 'dup'])}`.slice(0, 40);
  const ref = col.projects().doc(id);
  const copy: LinkAdDoc = normalizeLinkAd({ ...src.doc, revision: 0, activeJobId: null, lastError: null, exports: [], timelineId: null, voiceInFlight: {}, spend: { ...src.doc.spend, ledger: [] }, importedFrom: { projectId: p.projectId, title: src.title, at: Date.now() }, poster: src.doc.poster ? { ...src.doc.poster, exports: {} } : null, ad: { ...src.doc.ad, music: { ...src.doc.ad.music, jobId: null } }, stage: src.doc.stage === 'composing' || src.doc.stage === 'ready' ? 'generating' : src.doc.stage === 'analysing' ? 'reviewing' : src.doc.stage === 'planning' ? 'reviewing' : src.doc.stage, updatedAt: Date.now() });
  const created = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) return false;
    tx.set(ref, { ownerUid: owner.uid, title: `${src.title} (copy)`.slice(0, 160), type: src.type, logline: '', idea: '', genre: '', status: 'active', format: { aspectRatio: '9:16', fps: 30 }, coverAssetId: null, styleBible: {}, linkad: copy, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    return true;
  });
  return { projectId: id, created };
}

// ---------------------------------------------------------------------------
// Motion Poster Ad: facts form -> poster + motion ad (same document, stages and pipeline)
// ---------------------------------------------------------------------------

async function createPoster(owner: Owner, p: Req<'createPoster'>) {
  const ent = await assertLinkAdAccess(owner);
  await assertRateLimit(owner.uid, 1, 30);
  const fixture = p.fixture && FIXTURES_ALLOWED();
  if (p.fixture && !fixture) throw new HttpsError('failed-precondition', 'Fixture mode is available only in the emulators and tests.');
  const kit = p.kitId ? (await loadKit(owner.uid, p.kitId)).kit : null;
  const id = `pa${stableHash([owner.uid, p.requestId])}`.slice(0, 40);
  const ref = col.projects().doc(id);
  const base = defaultLinkAd({ sourceKind: 'facts' });
  let doc: LinkAdDoc = { ...base, mode: fixture ? 'fixture' : 'live', stage: 'reviewing', stageNote: 'Fill in the facts and add real photos.', poster: defaultPoster(p.template), ad: { ...base.ad, music: { ...base.ad.music, prompt: POSTER_MUSIC_PROMPTS[p.template] } }, spend: { ...base.spend, capUsd: Math.min(base.spend.capUsd, ent.quotas.maxSpendCapUsd) }, updatedAt: Date.now() };
  if (kit && p.kitId) doc = await withKit(owner.uid, doc, p.kitId, kit);
  const title = (p.title.trim() || (kit ? `${kit.name} · ${POSTER_TEMPLATE_INFO[p.template].label}` : POSTER_TEMPLATE_INFO[p.template].label)).slice(0, 120);
  const created = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      if (snap.get('ownerUid') !== owner.uid) throw new HttpsError('not-found', 'Ad not found.');
      return false;
    }
    tx.set(ref, { ownerUid: owner.uid, title, type: 'poster_ad', logline: '', idea: '', genre: '', status: 'active', format: { aspectRatio: '9:16', fps: 30 }, coverAssetId: null, styleBible: {}, linkad: doc, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    return true;
  });
  return { projectId: id, created };
}

const kitRefId = (assetId: string) => `a_${stableHash([assetId])}`;

/**
 * Copies a brand kit into an ad: colours and the video font, the poster fonts, the logo and real photos (stored,
 * marked real, offered before anything generated), prices and contacts with their review-by days. Prices the kit
 * confirmed and that are not past review are confirmed in the ad; overdue ones stay unconfirmed and block export.
 * Re-applying refreshes what came from the kit and keeps the director's own additions.
 */
export async function withKit(uid: string, doc0: LinkAdDoc, kitId: string, kit: BrandKitInput, now = Date.now()): Promise<LinkAdDoc> {
  const today = todayKey(now);
  const files = [...kit.logos.slice(0, 1).map((l) => l.assetId), ...kitPhotosFirst(kit).map((ph) => ph.assetId)];
  const snaps = files.length ? await db.getAll(...files.map((x) => col.assets().doc(x))) : [];
  const info = new Map(snaps.filter((s) => s.exists && s.get('ownerUid') === uid && s.get('status') === 'ready' && s.get('kind') === 'image').map((s) => [s.id, s.data() as Omit<AssetDoc, 'id'>]));
  return applyKitToDoc(doc0, kitId, kit, info, today, now);
}

/** The pure part of applying a kit (tested): `info` holds the kit's files that are ready pictures the owner has. */
export function applyKitToDoc(doc0: LinkAdDoc, kitId: string, kit: BrandKitInput, info: Map<string, Pick<AssetDoc, 'title' | 'width' | 'height' | 'sizeBytes' | 'mimeType'>>, today: string, now: number): LinkAdDoc {
  let d: LinkAdDoc = { ...doc0, ad: { ...doc0.ad, brand: kitToLinkAdBrand(kit) } };
  const assets: LinkAdAsset[] = [...d.source.assets];
  const addFile = (assetId: string, role: 'logo' | 'image', real: boolean, label: string): string | null => {
    const a = info.get(assetId);
    if (!a) return null;
    const refId = kitRefId(assetId);
    const existing = assets.findIndex((x) => x.assetId === assetId);
    const entry: LinkAdAsset = { id: existing >= 0 ? assets[existing]!.id : refId, assetId, role, origin: 'upload', url: null, pageUrl: null, alt: (label || a.title || '').slice(0, 240), width: a.width ?? null, height: a.height ?? null, bytes: a.sizeBytes ?? null, mime: a.mimeType ?? null, status: 'stored', rejectReason: null, rights: 'confirmed', needsReview: false, reviewed: false, selected: true, note: `From the brand kit “${kit.name.slice(0, 80)}”${real ? ' · real photo' : ''}`.slice(0, 240), real };
    if (existing >= 0) assets[existing] = { ...assets[existing]!, ...entry };
    else assets.push(entry);
    return entry.id;
  };
  const logoId = kit.logos[0] ? addFile(kit.logos[0].assetId, 'logo', false, kit.logos[0].label || `${kit.name} logo`) : null;
  const photoIds = kitPhotosFirst(kit).map((ph) => addFile(ph.assetId, 'image', ph.real, ph.label || ph.product)).filter((x): x is string => Boolean(x));
  d = { ...d, source: { ...d.source, assets: assets.slice(0, 40) }, brief: { ...d.brief, logoId: logoId ?? d.brief.logoId, imageIds: [...new Set([...photoIds, ...d.brief.imageIds])].slice(0, LINKAD_LIMITS.maxImages) } };

  // Facts: the brand's name, and (outside a poster form) its prices and contacts.
  const kitFacts: UserFact[] = [{ id: 'kit_name', kind: 'business_name', text: kit.name.slice(0, 400), at: now, kit: null }];
  if (!d.poster) {
    for (const o of kit.offers) kitFacts.push({ id: `kit_o_${o.id}`.slice(0, 80), kind: 'price', text: [o.item, `${o.currency}${o.price}`, o.unit].filter(Boolean).join(' ').slice(0, 400), at: now, kit: { kitId, entryId: o.id, reviewBy: o.reviewBy } });
    for (const c of kit.contacts) kitFacts.push({ id: `kit_c_${c.id}`.slice(0, 80), kind: c.kind === 'website' || c.kind === 'social' ? 'destination' : c.kind === 'address' ? 'location' : 'contact', text: `${c.label ? `${c.label} ` : ''}${c.value}`.slice(0, 400), at: now, kit: { kitId, entryId: c.id, reviewBy: c.reviewBy } });
  }
  d = { ...d, userFacts: [...d.userFacts.filter((f) => !f.id.startsWith('kit_')), ...kitFacts].slice(0, 40) };

  if (d.poster) {
    const p = d.poster;
    const offers = new Map(kit.offers.map((o) => [o.id, o]));
    const contacts = new Map(kit.contacts.map((c) => [c.id, c]));
    // Rows that came from the kit follow it; an empty form is filled from it.
    let prices = p.prices.filter((r) => !r.kitEntryId || offers.has(r.kitEntryId)).map((r) => {
      const o = r.kitEntryId ? offers.get(r.kitEntryId) : undefined;
      return o ? { ...r, item: o.item.slice(0, 60), price: o.price, currency: o.currency, unit: o.unit.slice(0, 40), reviewBy: o.reviewBy } : r;
    });
    if (!prices.length) prices = kit.offers.slice(0, p.template === 'price_list' ? 8 : 2).map((o) => ({ id: `p_${o.id}`.slice(0, 80), item: o.item.slice(0, 60), price: o.price, currency: o.currency, unit: o.unit.slice(0, 40), kitEntryId: o.id, reviewBy: o.reviewBy }));
    let pc = p.contacts.filter((r) => !r.kitEntryId || contacts.has(r.kitEntryId)).map((r) => {
      const c = r.kitEntryId ? contacts.get(r.kitEntryId) : undefined;
      return c ? { ...r, kind: c.kind, value: c.value.slice(0, 160), reviewBy: c.reviewBy } : r;
    });
    if (!pc.length) {
      const order = ['phone', 'whatsapp', 'website', 'social', 'email', 'address'];
      pc = [...kit.contacts].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)).slice(0, 2).map((c) => ({ id: `c_${c.id}`.slice(0, 80), kind: c.kind, value: c.value.slice(0, 160), kitEntryId: c.id, reviewBy: c.reviewBy }));
    }
    const poster: PosterForm = { ...p, prices, contacts: pc, fonts: { heading: kit.fonts.heading, body: kit.fonts.body }, photoIds: p.photoIds.length ? p.photoIds : photoIds.slice(0, 4) };
    d = { ...d, poster };
  }
  d = { ...d, brandKit: { kitId, name: kit.name.slice(0, 120), appliedAt: now } };
  d = syncPosterFacts(d, now);

  // The kit's own confirmation stands in the ad while it is current; an overdue entry must be re-confirmed in the kit.
  const confirmations = { ...d.confirmations };
  for (const f of allFacts(d)) {
    const u = d.userFacts.find((x) => x.id === f.id);
    if (!u?.kit) continue;
    if (reviewState(u.kit.reviewBy, today) === 'overdue') delete confirmations[f.id];
    else confirmations[f.id] = factHash(f);
  }
  d = { ...d, confirmations };
  return { ...d, ad: { ...d.ad, scenes: reviewScenes(d) } };
}

async function applyKit(owner: Owner, p: Req<'applyKit'>) {
  await assertLinkAdAccess(owner);
  const { kit } = await loadKit(owner.uid, p.kitId);
  const { doc: cur } = await loadAd(owner.uid, p.projectId);
  const prepared = await withKit(owner.uid, cur, p.kitId, kit);
  const doc = await mutateAd(owner.uid, p.projectId, (d) => ({ ...d, ad: { ...d.ad, brand: prepared.ad.brand, scenes: prepared.ad.scenes }, source: { ...d.source, assets: prepared.source.assets }, brief: { ...d.brief, logoId: prepared.brief.logoId, imageIds: prepared.brief.imageIds }, userFacts: prepared.userFacts, confirmations: prepared.confirmations, poster: prepared.poster, brandKit: prepared.brandKit }));
  return { revision: doc.revision };
}

async function buildScript(owner: Owner, p: Req<'buildScript'>) {
  await assertLinkAdAccess(owner);
  const doc = await mutateAd(
    owner.uid,
    p.projectId,
    (d0) => {
      if (!d0.poster) throw new HttpsError('failed-precondition', 'This ad has no facts form.');
      if (!d0.poster.headline.trim()) throw new HttpsError('failed-precondition', 'Write a headline first.');
      const d = syncPosterFacts(d0);
      const script = buildPosterScript(d);
      // Recordings stay with scenes whose words did not change (a take's hash says whether it is current).
      const ids = new Set(script.scenes.map((s) => s.id));
      const takes = Object.fromEntries(Object.entries(d.ad.takes).filter(([sid]) => ids.has(sid)));
      const brief = { ...d.brief, ...script.brief };
      const next: LinkAdDoc = { ...d, brief, ad: { ...d.ad, title: script.title.slice(0, 120), scenes: script.scenes, closing: script.closing, takes }, poster: { ...d.poster!, scriptFor: posterFormHash(d.poster!) } };
      const approved = { ...next, briefApprovedAt: Date.now(), briefApprovedHash: usedFactsHash(next) };
      return d.stage === 'generating' ? approved : moveStage(approved, 'generating', 'Check the script, then make the voice.', { force: true });
    },
    { expectedRevision: p.revision },
  );
  return { revision: doc.revision, scenes: doc.ad.scenes.length };
}

async function savePoster(owner: Owner, p: Req<'savePoster'>) {
  await assertLinkAdAccess(owner);
  const loaded = await loadAd(owner.uid, p.projectId);
  const doc = loaded.doc;
  if (!doc.poster) throw new HttpsError('failed-precondition', 'This ad has no poster.');
  if (p.hash !== posterInputHash(doc, p.format)) throw new HttpsError('failed-precondition', 'The poster changed while it was being drawn. Save it again.', { reason: 'stale_poster' });
  const blocking = posterReadiness(doc).filter((i) => i.severity === 'error');
  if (blocking.length) throw new HttpsError('failed-precondition', `Fix ${blocking.length} problem${blocking.length === 1 ? '' : 's'} before saving the poster: ${blocking.slice(0, 3).map((i) => i.message).join(' ')}`, { reason: 'not_ready', issues: blocking.slice(0, 20) });
  const a = await col.assets().doc(p.assetId).get();
  if (!a.exists || a.get('ownerUid') !== owner.uid) throw new HttpsError('not-found', 'Poster file not found.');
  if (a.get('kind') !== 'image' || a.get('status') !== 'ready') throw new HttpsError('failed-precondition', 'The poster file is not a ready picture yet.');
  const want = POSTER_FORMATS[p.format];
  if (Number(a.get('width')) !== want.width || Number(a.get('height')) !== want.height) throw new HttpsError('failed-precondition', `The poster file is ${a.get('width')}×${a.get('height')}; the ${p.format} poster must be exactly ${want.width}×${want.height}.`);
  const next = await mutateAd(owner.uid, p.projectId, (d) => (d.poster ? { ...d, poster: { ...d.poster, exports: { ...d.poster.exports, [p.format]: { assetId: p.assetId, hash: p.hash, width: want.width, height: want.height, at: Date.now() } } } } : d));
  if (p.format === '4:5' || !(await loaded.ref.get()).get('coverAssetId')) await loaded.ref.update({ coverAssetId: p.assetId }).catch(() => undefined);
  return { revision: next.revision };
}

async function music(owner: Owner, p: Req<'music'>) {
  await assertLinkAdAccess(owner);
  const { doc, title } = await loadAd(owner.uid, p.projectId);
  const request = { type: 'music.generate' as const, projectId: p.projectId, purpose: 'song' as const, instrumental: true, prompt: p.prompt, alternate: false, imageAssetIds: [], title: `${title} · music bed`.slice(0, 160), label: 'Instrumental bed for the ad' };
  const prepared = await prepareAll(owner.uid, [request]);
  const est = prepared[0]!.estimate;
  const stepProblem = async () => {
    try {
      assertWithinAdCap(doc, est.usd);
      assertWithinLimits(await getSettings(owner.uid), await spendSnapshot(owner.uid), est.usd);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  };
  if (p.estimateOnly) return { estimate: est, problem: await stepProblem(), capUsd: doc.spend.capUsd, committedUsd: committedUsd(doc), fixture: doc.mode === 'fixture' };
  return withLock(p.projectId, 'linkad_music', async () => {
    const fresh = (await loadAd(owner.uid, p.projectId)).doc;
    if (fresh.ad.music.jobId) {
      const j = await col.jobs().doc(fresh.ad.music.jobId).get();
      if (j.exists && ACTIVE_STATUSES.includes(j.get('status'))) return { jobId: j.id, started: false, estimate: est };
    }
    assertWithinAdCap(fresh, est.usd);
    const res = await createJobs(owner.uid, [request], { confirmedUsd: p.confirmedUsd, batchLabel: request.label });
    const jobId = res.jobIds[0]!;
    await mutateAd(owner.uid, p.projectId, (d) => addLedger({ ...d, ad: { ...d.ad, music: { ...d.ad.music, jobId, prompt: p.prompt, origin: 'generated' } } }, { step: 'music', kind: 'music', units: '1 instrumental', estimateUsd: res.estimate.usd, actualUsd: null, jobId, basis: d.mode === 'fixture' ? 'fixture' : 'published_rate' }));
    return { jobId, started: true, estimate: res.estimate };
  });
}

/** Puts a finished music bed on the ad (made by the studio's own music job for this ad, so its use is confirmed). */
async function collectMusic(uid: string, projectId: string): Promise<boolean> {
  const { doc } = await loadAd(uid, projectId);
  const jobId = doc.ad.music.jobId;
  if (!jobId) return false;
  const j = await col.jobs().doc(jobId).get();
  if (!j.exists || j.get('ownerUid') !== uid) return false;
  const status = String(j.get('status'));
  if (status !== 'completed' && status !== 'failed' && status !== 'cancelled') return false;
  const assetId = ((j.get('result.assetIds') as string[] | undefined) ?? [])[0] ?? null;
  await mutateAd(uid, projectId, (d) => {
    if (d.ad.music.jobId !== jobId) return d;
    const ledger = { ...d, spend: { ...d.spend, ledger: d.spend.ledger.map((e) => (e.jobId === jobId && e.actualUsd === null ? { ...e, actualUsd: Number(j.get('usageUsd') ?? 0) } : e)) } };
    if (status === 'completed' && assetId) return { ...ledger, ad: { ...d.ad, music: { ...d.ad.music, assetId, title: 'Instrumental bed (made in the studio)', rightsConfirmed: true, origin: 'generated', jobId: null } } };
    return { ...ledger, ad: { ...d.ad, music: { ...d.ad.music, jobId: null } }, lastError: { message: String(j.get('error.message') ?? 'The music bed could not be made.').slice(0, 500), step: 'music', at: Date.now(), retryable: true } };
  });
  return true;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function linkAd(owner: Owner, p: LinkAdRequest) {
  switch (p.op) {
    case 'config':
      return config(owner);
    case 'create':
      return create(owner, p);
    case 'edit':
      return edit(owner, p);
    case 'analyse':
      return analyse(owner, p);
    case 'approveBrief':
      return approveBrief(owner, p);
    case 'plan':
      return plan(owner, p);
    case 'selectDirection':
      return selectDirection(owner, p);
    case 'revise':
      return revise(owner, p);
    case 'voice':
      return voice(owner, p);
    case 'export':
      return exportAd(owner, p);
    case 'addAsset':
      return addAsset(owner, p);
    case 'enhance':
      return enhance(owner, p);
    case 'cancel':
      return cancel(owner, p);
    case 'refresh':
      return refresh(owner, p);
    case 'duplicate':
      return duplicate(owner, p);
    case 'createPoster':
      return createPoster(owner, p);
    case 'applyKit':
      return applyKit(owner, p);
    case 'buildScript':
      return buildScript(owner, p);
    case 'savePoster':
      return savePoster(owner, p);
    case 'music':
      return music(owner, p);
    default: {
      const never: never = p;
      throw new HttpsError('invalid-argument', `Unknown Link to Ad operation ${(never as { op?: string }).op ?? ''}.`);
    }
  }
}

