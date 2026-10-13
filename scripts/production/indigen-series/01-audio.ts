import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type AssetDoc } from '@az-studio/shared';
import { transcribe } from '../../../functions/src/lib/audio-models';
import { bucket, col, FieldValue, loadState, patchState, say, saveState, studioOwner, submitJobs, waitForJob, WORK } from './common';
import { DIRECTION, VIDEOS, VOICE } from './scripts';

// Usage: 01-audio.ts setup|speech|music|words [v1 v2 …]   (state in exports/indigen-contributor-series/_work/state.json)
const [step = 'status', ...only] = process.argv.slice(2);
const keys = only.length ? only : VIDEOS.map((v) => v.key);
const vocab = ['Kasem', 'Indigen World', 'Kawuri', 'TribeStudio', 'usage note'];

async function setup() {
  const owner = await studioOwner();
  const st = loadState();
  st.projects ??= {};
  for (const v of VIDEOS) {
    if (st.projects[v.key]) continue;
    const ref = col.projects().doc();
    await ref.set({
      ownerUid: owner.uid,
      title: `Indigen World contributors — ${v.title}`,
      type: 'film',
      logline: `Contributor series: ${v.title}. Vertical 9:16 social video for existing Indigen World contributors.`,
      idea: '',
      genre: 'Explainer',
      status: 'active',
      format: { aspectRatio: '9:16', fps: 30, videoResolution: '1080p' },
      coverAssetId: null,
      styleBible: {},
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    st.projects[v.key] = ref.id;
    say(`project ${v.key} ${ref.id}`);
  }
  saveState(st);
}

async function speech() {
  const owner = await studioOwner();
  for (const v of VIDEOS.filter((x) => keys.includes(x.key))) {
    const st = loadState();
    const lines = v.lines.map((text, index) => ({ index, character: 'Narrator', text, voice: VOICE, direction: DIRECTION }));
    const [jobId] = await submitJobs(owner, [{ type: 'speech.generate', projectId: st.projects[v.key], lines, languageCode: 'en', voiceover: false, label: `${v.key} narration` }], `${v.key} narration`);
    const job = await waitForJob(jobId!, say, 20 * 60_000);
    if (job.status !== 'completed') throw new Error(`${v.key}: ${JSON.stringify(job.error)}`);
    const data = (job.result as { data: { lines: { index: number; text: string; assetId: string; seconds: number | null }[] } }).data;
    st.speech ??= {};
    st.speech[v.key] = data.lines.map((l) => ({ index: l.index, text: l.text, assetId: l.assetId, seconds: l.seconds }));
    saveState(st);
    say(`${v.key}: ${data.lines.map((l) => (l.seconds ?? 0).toFixed(1)).join(' ')} = ${data.lines.reduce((s, l) => s + (l.seconds ?? 0), 0).toFixed(1)} s`);
  }
}

async function speechline() {
  const owner = await studioOwner();
  const v = VIDEOS.find((x) => x.key === only[0])!;
  const idx = Number(only[1]);
  const st = loadState();
  const lines = [{ index: idx, character: 'Narrator', text: v.lines[idx]!, voice: VOICE, direction: DIRECTION }];
  const [jobId] = await submitJobs(owner, [{ type: 'speech.generate', projectId: st.projects[v.key], lines, languageCode: 'en', voiceover: false, label: v.key + ' narration line ' + idx }], v.key + ' line ' + idx);
  const job = await waitForJob(jobId!, say, 20 * 60_000);
  if (job.status !== 'completed') throw new Error(JSON.stringify(job.error));
  const l = (job.result as { data: { lines: { index: number; text: string; assetId: string; seconds: number | null }[] } }).data.lines[0]!;
  const cur = loadState();
  cur.speech[v.key][idx] = { index: idx, text: l.text, assetId: l.assetId, seconds: l.seconds };
  saveState(cur);
  say(v.key + ' line ' + idx + ': ' + l.seconds + ' s');
}

/** Downloads each narration line and records word timings (also checks what was actually spoken). */
async function words() {
  const st = loadState();
  for (const v of VIDEOS.filter((x) => keys.includes(x.key))) {
    const dir = path.join(WORK, 'audio', v.key);
    mkdirSync(dir, { recursive: true });
    const out: Record<number, { text: string; heard: string; words: { start: number; end: number; text: string }[] }> = {};
    for (const l of st.speech[v.key] as { index: number; text: string; assetId: string }[]) {
      const a = (await col.assets().doc(l.assetId).get()).data() as AssetDoc;
      const [buf] = await bucket.file(a.storagePath).download();
      writeFileSync(path.join(dir, `line-${l.index}.wav`), buf);
      const r = await transcribe({ data: buf, mimeType: 'audio/wav', languageCode: 'en', vocabulary: vocab });
      out[l.index] = { text: l.text, heard: r.text, words: r.words.map((w) => ({ start: w.start, end: w.end, text: w.text })) };
      say(`${v.key} #${l.index}: ${r.text}`);
    }
    writeFileSync(path.join(dir, 'words.json'), JSON.stringify(out, null, 1));
  }
}

async function music() {
  const owner = await studioOwner();
  for (const v of VIDEOS.filter((x) => keys.includes(x.key))) {
    const st = loadState();
    const [jobId] = await submitJobs(owner, [{ type: 'music.generate', projectId: st.projects[v.key], purpose: 'song', prompt: v.musicPrompt, instrumental: true, languageCode: null, title: `${v.title} score`, label: `${v.key} score` }], `${v.key} score`);
    const job = await waitForJob(jobId!, say, 30 * 60_000);
    say(`${v.key} music ${job.status} ${JSON.stringify(job.result ?? job.error).slice(0, 400)}`);
    if (job.status !== 'completed') continue;
    patchState({ music: { ...(loadState().music ?? {}), [v.key]: { jobId, result: job.result } } });
  }
}

async function status() {
  say(JSON.stringify(loadState(), null, 1).slice(0, 4000));
}

const steps: Record<string, () => Promise<void>> = { setup, speech, speechline, words, music, status };
const fn = steps[step];
if (!fn) throw new Error(`Unknown step ${step}`);
await fn();
process.exit(0);
