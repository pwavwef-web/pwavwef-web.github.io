import path from 'node:path';
import { getFunctions } from 'firebase-admin/functions';
import { logger } from 'firebase-functions';
import { CHUNK_JOIN_PAUSE_SEC, DEFAULT_WORDS_PER_MINUTE, chunkText, estimateNarration, creditsFor, decodePcm16Wav, joinWithPauses, memberSpeechText, memberToday, stableHash, trimClip, utcDay, type BetaLedgerEntry, type MemberDoc, type MemberEditionDoc } from '@az-studio/shared';
import { MODEL_REGISTRY } from '../config/models';
import { narrationRates } from '../config/pricing';
import { REGION } from '../config/runtime';
import { MEMBER_WORKER_FUNCTION } from '../config/beta';
import { withTmpDir } from '../lib/assets';
import { bbucket, bcol, bdb, betaState, bpath } from '../lib/beta-store';
import { renderMasters, writeRawFloat } from '../lib/narrator-audio';
import { acquireRequest, releaseRequest } from '../lib/narrator-limits';
import { NarratorProviderError, synthesize } from '../lib/narrator-provider';

/**
 * Voices one member edition with a prebuilt Google voice (the Narrator's provider, Developer API route, the shared request
 * queue and daily allowance). Each chunk is saved before the next is sent; a delivery that finds a request still marked in
 * flight (the worker died mid-request) never resends it — the job ends and is charged what was recorded plus that chunk's
 * estimate. The job stops at the per-job ceiling, when the member cancels, and when the beta is switched off. Credits held
 * at submission are released at the end and the real recorded cost is charged.
 */

export interface MemberTask {
  uid: string;
  editionId: string;
  jobId: string;
}

/** Cloud Tasks delivery (kept on one object so tests can record it instead). */
export const memberQueue = {
  async enqueue(task: MemberTask): Promise<void> {
    const queue = getFunctions().taskQueue<MemberTask>(`locations/${REGION}/functions/${MEMBER_WORKER_FUNCTION}`);
    try {
      await queue.enqueue(task, { dispatchDeadlineSeconds: 1800, id: `${task.jobId}-${Date.now().toString(36)}` });
    } catch (e) {
      if (!String((e as { code?: string }).code ?? '').includes('task-already-exists')) throw e;
    }
  },
};

/** Media I/O for member audio (the beta bucket), replaceable in tests. */
export const memberMedia = {
  save: (p: string, data: Buffer, contentType: string) => bbucket.file(p).save(data, { resumable: false, contentType, metadata: { cacheControl: 'private, max-age=0, no-store' } } as never) as Promise<void>,
  read: async (p: string) => (await bbucket.file(p).download())[0] as Buffer,
  removePrefix: (prefix: string) => (bbucket as unknown as { deleteFiles: (o: { prefix: string; force: boolean }) => Promise<void> }).deleteFiles({ prefix, force: true }),
  /** Joins the chunk WAVs and writes a loudness-normalised MP3 (the Narrator's export chain); returns its bytes and length. */
  async master(wavs: Buffer[], meta: { title: string }): Promise<{ mp3: Buffer; durationSec: number }> {
    const parts = wavs.map((w) => {
      const d = decodePcm16Wav(w);
      if (!d) throw new Error('A chunk could not be decoded.');
      return { samples: trimClip(d.samples, d.sampleRate), pauseAfterSec: CHUNK_JOIN_PAUSE_SEC, rate: d.sampleRate };
    });
    const rate = parts[0]?.rate ?? 24_000;
    const joined = joinWithPauses(parts, rate);
    return withTmpDir(async (dir) => {
      const raw = path.join(dir, 'joined.f32');
      await writeRawFloat(raw, joined.samples);
      const m = await renderMasters({ rawPath: raw, rate, dir, channels: 1, target: { integratedLufs: -19, truePeakDbtp: -1.5 }, meta: { title: meta.title, artist: 'AZ Studio beta', album: 'Audio editions', date: null, comment: 'Read by a Google prebuilt voice.' } });
      const { readFile } = await import('node:fs/promises');
      return { mp3: await readFile(m.mp3Path), durationSec: Math.round((joined.samples.length / rate) * 10) / 10 };
    });
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Outcome = { status: 'ready'; audio: NonNullable<MemberEditionDoc['audio']> } | { status: 'failed'; error: string };

/** Ends a job: releases the held credits, charges the recorded cost, updates today's usage and the global breaker. */
export async function settleMemberJob(uid: string, editionId: string, jobId: string, outcome: Outcome, now = Date.now()): Promise<void> {
  const memberRef = bcol.members().doc(uid);
  const edRef = bcol.editions(uid).doc(editionId);
  await bdb.runTransaction(async (tx) => {
    const [mSnap, eSnap] = await Promise.all([tx.get(memberRef), tx.get(edRef)]);
    const ed = eSnap.data() as MemberEditionDoc | undefined;
    const m = mSnap.data() as MemberDoc | undefined;
    if (!ed?.job || ed.job.id !== jobId || ed.status === 'ready' || ed.status === 'failed') return;
    const job = ed.job;
    const startedDay = utcDay(job.startedAt);
    const spendRef = bcol.spend(startedDay);
    const spend = await tx.get(spendRef);
    const spentUsd = Math.round(job.spentUsd * 1e6) / 1e6;
    const charged = creditsFor(spentUsd);
    if (m) {
      const today = memberToday(m, now);
      const sameDay = today.day === startedDay;
      // Seconds were counted from the estimate at submission; correct them with what was made (0 when nothing was).
      const estSec = job.estimateSec ?? 0;
      const madeSec = outcome.status === 'ready' ? outcome.audio.durationSec : 0;
      tx.set(memberRef, {
        credits: { ...m.credits, reserved: Math.max(0, m.credits.reserved - job.reservedCredits), spent: m.credits.spent + charged, balance: Math.max(0, m.credits.balance - charged) },
        today: sameDay ? { ...today, seconds: Math.max(0, today.seconds - estSec + madeSec), usd: Math.round((today.usd + spentUsd) * 1e6) / 1e6 } : today,
        totals: { ...m.totals, seconds: m.totals.seconds + madeSec, usd: Math.round((m.totals.usd + spentUsd) * 1e6) / 1e6, jobs: m.totals.jobs + 1 },
        activeJob: null,
      }, { merge: true });
      const entry: BetaLedgerEntry = { kind: 'settle', credits: job.reservedCredits - charged, usd: spentUsd, jobId, note: `${outcome.status === 'ready' ? 'Edition voiced' : 'Job ended'}: ${charged} credit(s) charged for $${spentUsd.toFixed(4)} recorded; ${job.reservedCredits} held released.`, at: now };
      tx.set(bcol.ledger(uid).doc(`${jobId}-settle`), entry);
    }
    tx.set(spendRef, { reservedUsd: Math.max(0, Number(spend.get('reservedUsd') ?? 0) - job.estimateUsd), usd: Math.round((Number(spend.get('usd') ?? 0) + spentUsd) * 1e6) / 1e6, day: startedDay }, { merge: true });
    tx.set(edRef, { status: outcome.status, audio: outcome.status === 'ready' ? outcome.audio : ed.audio, error: outcome.status === 'failed' ? outcome.error : null, job: { ...job, inflight: null }, updatedAt: now }, { merge: true });
  });
}

export async function runMemberSpeak(task: MemberTask): Promise<void> {
  const edRef = bcol.editions(task.uid).doc(task.editionId);
  const snap = await edRef.get();
  const ed = snap.data() as MemberEditionDoc | undefined;
  if (!ed?.job || ed.job.id !== task.jobId || (ed.status !== 'queued' && ed.status !== 'speaking')) return;
  const fail = (error: string) => settleMemberJob(task.uid, task.editionId, task.jobId, { status: 'failed', error });
  const modelId = MODEL_REGISTRY.narration.id;
  const rates = narrationRates(modelId);
  const chunks = chunkText(memberSpeechText(ed.title, ed.text));
  const job = { ...ed.job };
  const save = (patch: Partial<NonNullable<MemberEditionDoc['job']>>, status: MemberEditionDoc['status'] = 'speaking') => edRef.set({ status, job: { ...job, ...patch }, updatedAt: Date.now() }, { merge: true });

  if (job.inflight !== null && job.inflight !== undefined) {
    // A request was in flight when the previous delivery stopped: Google may have made (and billed) it. Never resend.
    const est = estimateNarration([chunks[job.inflight] ?? ''], rates, { wordsPerMinute: DEFAULT_WORDS_PER_MINUTE, source: 'default' }).usd;
    job.spentUsd += est;
    await save({ spentUsd: job.spentUsd });
    return fail('The voice request was interrupted and was not sent again (it may have been billed). Start the edition again; finished work is not reused across jobs in the beta.');
  }

  for (let i = job.chunks.length; i < chunks.length; i++) {
    const state = await betaState();
    if (!state.enabled) return fail('The beta was switched off before this edition finished. Held credits were returned.');
    const fresh = (await edRef.get()).data() as MemberEditionDoc | undefined;
    if (fresh?.job?.cancelRequested) return fail('Cancelled. Only what was already voiced was charged.');
    const member = (await bcol.members().doc(task.uid).get()).data() as MemberDoc | undefined;
    if (!member || member.status !== 'active') return fail('Beta access ended before this edition finished.');
    if (job.spentUsd >= state.limits.jobCeilingUsd) return fail(`Stopped at the per-job ceiling ($${state.limits.jobCeilingUsd.toFixed(2)}).`);
    const holder = `${task.jobId}:${i}`;
    let gate = await acquireRequest('developer', modelId, holder);
    for (let w = 0; !gate.ok && gate.reason === 'busy' && w < 8; w++) {
      await sleep(Math.min(3000, Math.max(100, gate.waitMs)));
      gate = await acquireRequest('developer', modelId, holder);
    }
    if (!gate.ok) return fail(gate.reason === 'daily' ? 'The voice service’s daily allowance is used up. Try again tomorrow — nothing more was charged.' : 'The voice service is busy. Try again in a few minutes — nothing more was charged.');
    await save({ inflight: i });
    let wav: Buffer;
    let usd: number;
    try {
      let attempt = 0;
      for (;;) {
        try {
          const r = await synthesize({ route: 'developer', modelId, voiceId: ed.voice, segments: [{ text: chunks[i]!, style: '' }] });
          wav = r.wav;
          usd = Math.round(((r.inputTokens / 1e6) * rates.inputPerM + (r.outputTokens / 1e6) * rates.outputPerM) * 1e6) / 1e6;
          if (r.finish === 'MAX_TOKENS') throw new NarratorProviderError('unexpected', 'The voice stopped early on one part of this edition.');
          break;
        } catch (e) {
          if (!(e instanceof NarratorProviderError) || !e.retryable || attempt++ >= 2) throw e;
          await sleep(2000 * attempt);
        }
      }
    } catch (e) {
      const pe = e instanceof NarratorProviderError ? e : null;
      await releaseRequest('developer', modelId, holder, { refund: Boolean(pe && pe.httpStatus !== null && pe.kind !== 'ambiguous'), exhausted: pe?.kind === 'quota' }).catch(() => undefined);
      await save({ inflight: null });
      logger.warn('member speech failed', { uid: task.uid, jobId: task.jobId, kind: pe?.kind ?? 'internal' });
      return fail(pe?.kind === 'policy' ? 'The voice service refused part of this text.' : 'The voice service could not read this edition right now. Nothing more was charged.');
    }
    await releaseRequest('developer', modelId, holder).catch(() => undefined);
    const p = bpath.chunk(task.uid, task.editionId, task.jobId, i);
    await memberMedia.save(p, wav!, 'audio/wav');
    job.chunks = [...job.chunks, p];
    job.spentUsd = Math.round((job.spentUsd + usd!) * 1e6) / 1e6;
    job.inflight = null;
    await save({ chunks: job.chunks, spentUsd: job.spentUsd, inflight: null });
  }

  try {
    const wavs = await Promise.all(job.chunks.map((c) => memberMedia.read(c)));
    const { mp3, durationSec } = await memberMedia.master(wavs, { title: ed.title });
    const audioPath = bpath.audio(task.uid, task.editionId, task.jobId);
    await memberMedia.save(audioPath, mp3, 'audio/mpeg');
    await settleMemberJob(task.uid, task.editionId, task.jobId, { status: 'ready', audio: { path: audioPath, durationSec, bytes: mp3.length, at: Date.now(), textHash: stableHash({ t: ed.title, x: ed.text, v: ed.voice }) } });
  } catch (e) {
    logger.error('member export failed', { uid: task.uid, jobId: task.jobId, error: String((e as Error)?.message ?? e).slice(0, 300) });
    await fail('The audio could not be assembled. You were charged only for the voice requests already made.');
  }
}
