import { HttpsError } from 'firebase-functions/v2/https';
import {
  applyCorrections,
  applyFinalFix,
  exportReadiness,
  finalScore,
  type ApiRequest,
  type FinalFinding,
  type FinalInspectionDoc,
  type MusicProjectDoc,
  type MusicVersionDoc,
  type SongDoc,
  type TimelineDoc,
  type TimelineState,
} from '@az-studio/shared';
import { col, db, FieldValue } from '../lib/firebase';
import { createMusicVersion } from '../workers/music-studio';
import type { Owner } from '../lib/owner';

type Payload<A extends ApiRequest['action']> = Extract<ApiRequest, { action: A }>['payload'];

async function ownedProject(uid: string, projectId: string) {
  const snap = await col.projects().doc(projectId).get();
  if (!snap.exists || snap.get('ownerUid') !== uid) throw new HttpsError('not-found', 'Project not found.');
  return snap;
}

// ---------------------------------------------------------------------------
// Final-film inspection: fixes, overrides and per-finding decisions (all recorded)
// ---------------------------------------------------------------------------

function summarize(doc: Pick<FinalInspectionDoc, 'findings' | 'override'>) {
  const open = doc.findings.filter((f) => !f.resolvedAt && !f.overridden);
  return { readiness: exportReadiness(doc.findings, doc.override), score: finalScore(open), errors: open.filter((f) => f.severity === 'error').length, warnings: open.filter((f) => f.severity === 'warning').length };
}

export async function finalInspectionAction(owner: Owner, p: Payload<'finalInspectionAction'>) {
  const proj = await ownedProject(owner.uid, p.projectId);
  const ref = proj.ref.collection('finalInspections').doc(p.inspectionId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Final inspection not found.');
  const doc = { ...(snap.data() as FinalInspectionDoc), id: snap.id };
  if (doc.status !== 'completed') throw new HttpsError('failed-precondition', 'Wait for the inspection to finish.');
  const now = Date.now();
  let findings: FinalFinding[] = doc.findings;
  let override = doc.override;
  let timelineChange: { version: number; applied: string[] } | null = null;

  switch (p.action) {
    case 'override':
      if (!p.note?.trim()) throw new HttpsError('invalid-argument', 'Say why the film may be exported with these issues (the note is kept with the export).');
      override = { at: now, note: p.note.trim() };
      break;
    case 'clear_override':
      override = null;
      break;
    case 'resolve':
    case 'reopen': {
      const f = findings.find((x) => x.id === p.findingId);
      if (!f) throw new HttpsError('not-found', 'Finding not found.');
      findings = findings.map((x) => (x.id === f.id ? (p.action === 'resolve' ? { ...x, overridden: { at: now, note: p.note?.trim() || 'Accepted by the director' } } : { ...x, overridden: null, resolvedAt: null }) : x));
      break;
    }
    case 'apply_fix':
    case 'apply_all_fixes': {
      // Fixes change the timeline; this render still contains the problem, so the finding is marked
      // “fixed in the timeline” and the film must be rendered (and inspected) again to verify it.
      const targets = p.action === 'apply_fix' ? findings.filter((x) => x.id === p.findingId) : findings.filter((x) => x.fix && !x.overridden && !x.fixedAt);
      if (!targets.length || targets.some((x) => !x.fix)) throw new HttpsError('failed-precondition', 'There is no automatic fix for that finding.');
      const tref = proj.ref.collection('timelines').doc(doc.timelineId);
      timelineChange = await db.runTransaction(async (tx) => {
        const ts = await tx.get(tref);
        if (!ts.exists) throw new HttpsError('not-found', 'The timeline no longer exists.');
        const tl = { ...(ts.data() as TimelineDoc), id: ts.id };
        let state: TimelineState = { tracks: tl.tracks, clips: tl.clips, markers: tl.markers, fps: tl.fps, aspectRatio: tl.aspectRatio, beatGrid: tl.beatGrid };
        const applied: string[] = [];
        for (const f of targets) {
          const next = applyFinalFix(state, f.fix!);
          if (next) {
            state = next;
            applied.push(f.id);
          }
        }
        if (!applied.length) throw new HttpsError('failed-precondition', 'The timeline changed since the inspection; these fixes no longer apply. Render and inspect again.');
        const version = Number(tl.version ?? 0) + 1;
        tx.set(tref, { tracks: state.tracks, clips: state.clips, markers: state.markers, version, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        tx.set(tref.collection('versions').doc(), { version, reason: `Final-inspection fix: ${targets.filter((f) => applied.includes(f.id)).map((f) => f.fix!.label).join('; ')}`.slice(0, 500), tracks: state.tracks, clips: state.clips, markers: state.markers, createdAt: FieldValue.serverTimestamp() });
        return { version, applied };
      });
      findings = findings.map((x) => (timelineChange!.applied.includes(x.id) ? { ...x, fixedAt: now, fixedInTimelineVersion: timelineChange!.version } : x));
      break;
    }
  }
  const sum = summarize({ findings, override });
  await ref.set({ findings, override, ...sum, ...(timelineChange ? { needsRerender: true, timelineChangedAt: now } : {}), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  await col.renders().doc(doc.renderId).set({ finalInspection: { id: doc.id, status: 'completed', ...sum } }, { merge: true });
  await proj.ref.collection('finalInspections').doc(doc.id).collection('events').add({ at: now, action: p.action, findingId: p.findingId ?? null, note: p.note ?? '', uid: owner.uid, readiness: sum.readiness, createdAt: FieldValue.serverTimestamp() });
  return { ...sum, timelineVersion: timelineChange?.version ?? null, applied: timelineChange?.applied ?? [], needsRerender: Boolean(timelineChange) };
}

// ---------------------------------------------------------------------------
// Music Studio
// ---------------------------------------------------------------------------

async function musicVersion(projectId: string, musicProjectId: string, versionId: string) {
  const [mp, v] = await Promise.all([col.sub(projectId, 'musicProjects').doc(musicProjectId).get(), col.sub(projectId, 'musicVersions').doc(versionId).get()]);
  if (!mp.exists) throw new HttpsError('not-found', 'Music project not found.');
  if (!v.exists || v.get('musicProjectId') !== musicProjectId) throw new HttpsError('not-found', 'Version not found in this music project.');
  return { mp: { ...(mp.data() as MusicProjectDoc), id: mp.id }, v: { ...(v.data() as MusicVersionDoc), id: v.id } };
}

/** The director corrects an automatic analysis (tempo, key, metre, sections, downbeats); re-analysis keeps it. */
export async function musicCorrectAnalysis(owner: Owner, p: Payload<'musicCorrectAnalysis'>) {
  await ownedProject(owner.uid, p.projectId);
  const ref = col.sub(p.projectId, 'musicVersions').doc(p.versionId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Version not found.');
  const v = snap.data() as MusicVersionDoc;
  if (!v.analysis) throw new HttpsError('failed-precondition', 'Analyse this version first, then correct the analysis.');
  const sections = p.corrections.sections?.slice().sort((a, b) => a.start - b.start);
  if (sections?.some((s) => s.end <= s.start)) throw new HttpsError('invalid-argument', 'Every section must end after it starts.');
  if (sections?.some((s, i) => i > 0 && s.start < sections[i - 1]!.end - 0.05)) throw new HttpsError('invalid-argument', 'Sections may not overlap.');
  const analysis = applyCorrections(v.analysis, { ...p.corrections, ...(sections ? { sections } : {}), ...(p.corrections.downbeats ? { downbeats: [...p.corrections.downbeats].sort((a, b) => a - b) } : {}) });
  await ref.set({ analysis }, { merge: true });
  return { analysis };
}

/**
 * Uploaded or recorded audio becomes a version of the music project. A project without a linked song
 * gets one from its first audio, so lyrics can be transcribed, aligned and styled against it.
 */
export async function musicAddVersion(owner: Owner, p: Payload<'musicAddVersion'>) {
  await ownedProject(owner.uid, p.projectId);
  const mpRef = col.sub(p.projectId, 'musicProjects').doc(p.musicProjectId);
  const mp = await mpRef.get();
  if (!mp.exists) throw new HttpsError('not-found', 'Music project not found.');
  const a = await col.assets().doc(p.assetId).get();
  if (!a.exists || a.get('ownerUid') !== owner.uid) throw new HttpsError('not-found', 'Audio not found in your library.');
  if (a.get('status') !== 'ready') throw new HttpsError('failed-precondition', 'Wait for the upload to finish processing.');
  if (a.get('kind') !== 'audio' && !(a.get('kind') === 'video' && a.get('hasAudio'))) throw new HttpsError('invalid-argument', 'Choose an audio file.');
  const durationSec = Number(a.get('durationSec') ?? 0) || null;
  const title = String(a.get('title') ?? 'Audio');
  const versionId = await createMusicVersion(p.projectId, {
    musicProjectId: mp.id,
    source: p.source,
    label: p.label?.trim() || (p.source === 'recording' ? 'Recording' : title),
    assetId: a.id,
    parentVersionId: null,
    jobId: null,
    prompt: null,
    lyricsText: null,
    modelId: null,
    method: p.source === 'recording' ? 'Recorded in the studio with the browser microphone; nothing generated.' : 'Uploaded audio; nothing generated.',
    durationSec,
    loudness: null,
    analysis: null,
    timeMap: null,
  });
  let songId = (mp.get('songId') as string | null) ?? null;
  if (!songId) {
    const ref = col.songs(p.projectId).doc();
    await ref.set({ audioAssetId: a.id, title: (mp.get('brief.title') as string | undefined)?.trim() || title, artist: '', durationSec: durationSec ?? 0, analysis: null, lyrics: null, ai: null, lyricsSheet: null, instrumental: mp.get('brief.vocals') === 'none', createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    await mpRef.set({ songId: ref.id, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    songId = ref.id;
  }
  return { versionId, songId };
}

/** The version used for exports, videos and lyric sync. */
export async function musicSetMaster(owner: Owner, p: Payload<'musicSetMaster'>) {
  await ownedProject(owner.uid, p.projectId);
  const { mp, v } = await musicVersion(p.projectId, p.musicProjectId, p.versionId);
  await col.sub(p.projectId, 'musicProjects').doc(mp.id).set({ masterVersionId: v.id, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { masterVersionId: v.id };
}

/** Sends a finished version to a music-video project as its song (with the approved lyric sheet). */
export async function musicToVideo(owner: Owner, p: Payload<'musicToVideo'>) {
  await ownedProject(owner.uid, p.projectId);
  const target = await ownedProject(owner.uid, p.targetProjectId);
  if (target.get('type') !== 'music_video') throw new HttpsError('failed-precondition', 'Choose a music-video project.');
  const { mp, v } = await musicVersion(p.projectId, p.musicProjectId, p.versionId);
  const asset = await col.assets().doc(v.assetId).get();
  if (!asset.exists || asset.get('ownerUid') !== owner.uid || asset.get('status') !== 'ready') throw new HttpsError('failed-precondition', 'The version’s audio is not available.');
  const linked = mp.songId ? ((await col.songs(p.projectId).doc(mp.songId).get()).data() as SongDoc | undefined) : undefined;
  // A lyric sheet is copied only when it was synchronised to this very audio (never silently re-timed).
  const sheetFits = Boolean(linked?.lyricsSheet && linked.audioAssetId === v.assetId);
  const ref = col.songs(p.targetProjectId).doc();
  const song: Omit<SongDoc, 'id'> = {
    audioAssetId: v.assetId,
    title: mp.brief.title || v.label || 'Song',
    artist: '',
    durationSec: Number(asset.get('durationSec') ?? v.durationSec ?? 0),
    analysis: null,
    lyrics: null,
    ai: { genre: mp.brief.genre, mood: mp.brief.mood, summary: mp.brief.concept.slice(0, 500) },
    lyricsSheet: sheetFits ? linked!.lyricsSheet! : null,
    instrumental: mp.brief.vocals === 'none',
    generation: v.source === 'lyria' && v.jobId ? { jobId: v.jobId, modelId: v.modelId ?? '', prompt: (v.prompt ?? '').slice(0, 4000), caption: v.method.slice(0, 500), bpm: v.analysis?.bpm ?? mp.brief.tempoBpm ?? null } : null,
  };
  await ref.set({ ...song, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  await col.projects().doc(p.targetProjectId).set({ updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { songId: ref.id, projectId: p.targetProjectId, lyricsCopied: sheetFits, note: sheetFits ? 'The approved lyric sheet came with it.' : linked?.lyricsSheet ? 'The lyric sheet was synchronised to a different audio version; re-sync it in the music video (Lyrics → Re-sync to new audio).' : 'Add or sync lyrics in the music video.' };
}
