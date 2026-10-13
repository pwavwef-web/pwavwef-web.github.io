import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AMBIENCE_LABELS, type AmbienceKind, type JobDoc } from '@az-studio/shared';
import { createAsset, withTmpDir } from '../lib/assets';
import { bucket, col } from '../lib/firebase';
import { progress, transition } from '../lib/jobs';
import { FFMPEG } from '../lib/media';

const execFileAsync = promisify(execFile);

/**
 * Synthesised ambience beds for Film Studio Lite: filtered, slowly modulated noise (seeded, so the same
 * request always gives the same audio). Honest about what it is — atmosphere, not a field recording —
 * and seamless to loop with a crossfade because it has no recognisable events.
 */
export function ambienceGraph(kind: AmbienceKind, durationSec: number, seed: number): string {
  const d = Math.round(durationSec * 1000) / 1000;
  const noise = (color: string, s: number, amp = 0.5) => `anoisesrc=d=${d}:c=${color}:r=48000:a=${amp}:s=${s}`;
  // Two decorrelated channels give width without phase tricks.
  const stereo = (chain: (s: number) => string) => `${chain(seed)}[l];${chain(seed + 101)}[r];[l][r]join=inputs=2:channel_layout=stereo`;
  switch (kind) {
    case 'wind':
      return stereo((s) => `${noise('brown', s, 0.7)},highpass=f=35,lowpass=f=520,volume='0.5+0.32*sin(2*PI*0.061*t+${(s % 7) / 3})+0.18*sin(2*PI*0.017*t)':eval=frame`);
    case 'rain':
      return stereo((s) => `${noise('pink', s, 0.45)},highpass=f=700,lowpass=f=8000,volume='0.85+0.15*sin(2*PI*0.09*t+${(s % 5) / 2})':eval=frame`);
    case 'water':
      return stereo((s) => `${noise('pink', s, 0.55)},highpass=f=220,lowpass=f=1900,volume='0.7+0.18*sin(2*PI*0.83*t+${(s % 3) / 2})*sin(2*PI*0.29*t)+0.12*sin(2*PI*2.3*t)':eval=frame`);
    case 'night':
      return `${stereo((s) => `${noise('brown', s, 0.5)},lowpass=f=260,volume=0.7`)}[bed];${stereo((s) => `${noise('pink', s + 7, 0.25)},highpass=f=3200,lowpass=f=5200,volume='0.05+0.05*(0.5+0.5*sin(2*PI*16*t))*(0.5+0.5*sin(2*PI*0.21*t))':eval=frame`)}[air];[bed][air]amix=inputs=2:normalize=0`;
    case 'room':
      return stereo((s) => `${noise('brown', s, 0.4)},lowpass=f=180,highpass=f=25`);
  }
}

export async function runAmbienceJob(job: JobDoc): Promise<void> {
  const p = job.params as { kind: AmbienceKind; durationSec: number; seed: number };
  if (!(await transition(job.id, 'rendering', { stage: `Synthesising ${AMBIENCE_LABELS[p.kind].toLowerCase()}`, progress: 0.2, lease: { until: Date.now() + 5 * 60_000 } }))) return;
  const assetId = col.assets().doc().id;
  const storagePath = `users/${job.ownerUid}/generated/${job.id}/${assetId}.m4a`;
  await withTmpDir(async (dir) => {
    const out = path.join(dir, 'ambience.m4a');
    // Quiet, steady bed: the mix sets its final level.
    const graph = `${ambienceGraph(p.kind, p.durationSec, p.seed)},loudnorm=I=-28:TP=-8:LRA=6,aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[out]`;
    await execFileAsync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-filter_complex', graph, '-map', '[out]', '-t', String(p.durationSec), '-c:a', 'aac', '-b:a', '160k', out], { timeout: 240_000 });
    await progress(job.id, 'Saving the ambience', 0.8);
    await bucket.upload(out, { destination: storagePath, resumable: false, metadata: { contentType: 'audio/mp4', cacheControl: 'private, max-age=31536000' } });
    await createAsset({ uid: job.ownerUid, assetId, projectId: job.projectId, kind: 'audio', source: 'derived', title: `${AMBIENCE_LABELS[p.kind]} ambience (synthesised)`, fileName: `${p.kind}-ambience.m4a`, mimeType: 'audio/mp4', storagePath, localFile: out, dir, collections: ['lite:ambience', `ambience:${p.kind}`] });
  });
  await transition(job.id, 'completed', { stage: `${AMBIENCE_LABELS[p.kind]} ambience ready · ${Math.round(p.durationSec)} s · synthesised (no AI)`, usageUsd: 0, result: { assetIds: [assetId], data: { kind: p.kind, seed: p.seed, durationSec: p.durationSec } } });
}
