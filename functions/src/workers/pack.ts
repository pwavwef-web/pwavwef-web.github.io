import { execFile } from 'node:child_process';
import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { checkPackVideo, formatSrt, formatVtt, PACK_PRESET_LABELS, packCaptions, packReadme, packSlug, type AssetDoc, type JobDoc, type PackDoc, type PackFileCheck, type PackPreset, type RenderDoc, type TimelineDoc } from '@az-studio/shared';
import { packsCol } from '../api/deliverables';
import { withTmpDir } from '../lib/assets';
import { fail } from '../lib/errors';
import { bucket, col } from '../lib/firebase';
import { progress, transition } from '../lib/jobs';
import { FFMPEG, FFPROBE, probe } from '../lib/media';
import { writeStoredZip } from '../lib/zip';

const execFileAsync = promisify(execFile);

/** Decoded frame count of the first video stream. */
async function countFrames(file: string): Promise<number | null> {
  const { stdout } = await execFileAsync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file], { timeout: 600_000 });
  const n = Number.parseInt(stdout.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/** Integrated loudness and true peak (EBU R128). */
async function loudness(file: string): Promise<{ lufs: number | null; truePeakDb: number | null }> {
  const { stderr } = await execFileAsync(FFMPEG, ['-hide_banner', '-nostats', '-i', file, '-map', '0:a:0', '-af', 'ebur128=peak=true', '-f', 'null', '-'], { timeout: 600_000, maxBuffer: 32 * 1024 * 1024 });
  const lufs = [...stderr.matchAll(/I:\s+(-?[\d.]+) LUFS/g)].at(-1)?.[1];
  const peak = [...stderr.matchAll(/Peak:\s+(-?[\d.]+) dBFS/g)].at(-1)?.[1];
  return { lufs: lufs !== undefined ? Number(lufs) : null, truePeakDb: peak !== undefined ? Number(peak) : null };
}

const ORDER: PackPreset[] = ['youtube_16x9', 'vertical_9x16', 'portrait_4x5', 'square_1x1'];

/** pack.assemble: verifies every rendered file, adds poster, thumbnails, captions and a read-me, and zips the lot. */
export async function runPackAssembleJob(job: JobDoc): Promise<void> {
  const { packId } = job.params as { packId: string };
  const ref = packsCol().doc(packId);
  const pack = (await ref.get()).data() as PackDoc | undefined;
  if (!pack) fail('not_found', 'The pack no longer exists.');
  if (!(await transition(job.id, 'rendering', { stage: 'Checking the rendered files', progress: 0.05, lease: { until: Date.now() + 25 * 60_000 } }))) return;
  try {
    const project = await col.projects().doc(pack.projectId).get();
    const slug = packSlug(pack.title);
    const renders = await Promise.all(
      pack.presets.map(async (preset) => {
        const r = (await col.renders().doc(pack.renderIds[preset] ?? '').get()).data() as RenderDoc | undefined;
        const a = r?.outputAssetId ? ((await col.assets().doc(r.outputAssetId).get()).data() as AssetDoc | undefined) : undefined;
        if (!r || !a?.storagePath) fail('not_found', `The ${PACK_PRESET_LABELS[preset]} render is missing.`);
        return { preset, r, a };
      }),
    );
    const out = await withTmpDir(async (dir) => {
      const files: PackFileCheck[] = [];
      const entries: { name: string; path: string }[] = [];
      let i = 0;
      for (const { preset, r, a } of renders.sort((x, y) => ORDER.indexOf(x.preset) - ORDER.indexOf(y.preset))) {
        await progress(job.id, `Checking the ${PACK_PRESET_LABELS[preset]} file`, 0.1 + (0.6 * i++) / renders.length);
        const name = `${slug}-${preset.replace('_', '-')}.mp4`;
        const local = path.join(dir, name);
        await bucket.file(a.storagePath).download({ destination: local });
        const [info, frames] = await Promise.all([probe(local), countFrames(local)]);
        const loud = info.hasAudio ? await loudness(local) : { lufs: null, truePeakDb: null };
        files.push({ name, kind: 'video', preset, bytes: (await stat(local)).size, width: info.width ?? r.width, height: info.height ?? r.height, durationSec: info.durationSec ?? undefined, frames: frames ?? undefined, expectedFrames: Math.round(r.durationSec * r.fps), lufs: loud.lufs, truePeakDb: loud.truePeakDb, issues: checkPackVideo({ durationSec: info.durationSec, frames, hasAudio: info.hasAudio, ...loud }, { durationSec: r.durationSec, fps: r.fps, audioMaster: pack.audioMaster }) });
        entries.push({ name, path: local });
        // A thumbnail per format at the poster moment (long side 1280).
        const thumb = `${slug}-${preset.replace('_', '-')}-thumbnail.jpg`;
        await execFileAsync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', pack.posterAtSec.toFixed(3), '-i', local, '-frames:v', '1', '-vf', "scale='if(gt(iw,ih),1280,-2)':'if(gt(iw,ih),-2,1280)'", '-q:v', '3', path.join(dir, thumb)], { timeout: 120_000 });
        files.push({ name: thumb, kind: 'thumbnail', preset, bytes: (await stat(path.join(dir, thumb))).size, issues: [] });
        entries.push({ name: thumb, path: path.join(dir, thumb) });
      }
      // The poster: a full-resolution still from the widest format.
      await progress(job.id, 'Making the poster and captions', 0.75);
      const widest = files.find((f) => f.kind === 'video')!;
      const poster = `${slug}-poster.png`;
      await execFileAsync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', pack.posterAtSec.toFixed(3), '-i', path.join(dir, widest.name), '-frames:v', '1', path.join(dir, poster)], { timeout: 120_000 });
      files.push({ name: poster, kind: 'poster', bytes: (await stat(path.join(dir, poster))).size, width: widest.width, height: widest.height, issues: [] });
      entries.push({ name: poster, path: path.join(dir, poster) });
      // Captions from the edit itself (the same caption clips every format renders).
      const tl = (await col.timelines(pack.projectId).doc(pack.timelineId).get()).data() as TimelineDoc | undefined;
      const cues = packCaptions((renders[0]?.r as RenderDoc & { snapshot?: { clips?: TimelineDoc['clips'] } }).snapshot?.clips ?? tl?.clips ?? []);
      if (cues.length) {
        for (const [ext, text] of [['srt', formatSrt(cues)], ['vtt', formatVtt(cues)]] as const) {
          const n = `${slug}-captions.${ext}`;
          await writeFile(path.join(dir, n), text, 'utf8');
          files.push({ name: n, kind: 'captions', bytes: Buffer.byteLength(text), issues: [] });
          entries.push({ name: n, path: path.join(dir, n) });
        }
      }
      const readme = packReadme({ title: pack.title, projectTitle: String(project.get('title') ?? ''), createdAt: Date.now(), files, captions: cues.length });
      await writeFile(path.join(dir, 'README.txt'), readme, 'utf8');
      files.push({ name: 'README.txt', kind: 'readme', bytes: Buffer.byteLength(readme), issues: [] });
      entries.unshift({ name: 'README.txt', path: path.join(dir, 'README.txt') });

      await progress(job.id, 'Packing the files', 0.85);
      const zipLocal = path.join(dir, `${slug}.zip`);
      const bytes = await writeStoredZip(entries.map((e) => ({ name: `${slug}/${e.name}`, path: e.path })), zipLocal);
      const storagePath = `users/${pack.ownerUid}/packs/${packId}/${slug}.zip`;
      await bucket.upload(zipLocal, { destination: storagePath, resumable: bytes > 32 * 1024 * 1024, metadata: { contentType: 'application/zip', cacheControl: 'private, max-age=0', metadata: { jobId: job.id, op: 'pack' } } });
      return { files, zip: { storagePath, bytes } };
    });
    const problems = out.files.filter((f) => f.issues.length).length;
    await ref.set({ status: 'ready', message: problems ? `Ready — ${problems} file${problems === 1 ? '' : 's'} need a look (see the checks).` : 'Ready — every file passed its checks.', files: out.files, zip: out.zip, updatedAt: Date.now() }, { merge: true });
    await transition(job.id, 'completed', { stage: 'Pack ready', progress: 1, result: { data: { packId, files: out.files.length, bytes: out.zip.bytes, problems } } });
  } catch (e) {
    await ref.set({ status: 'failed', message: `The pack could not be built: ${String((e as Error)?.message ?? e).slice(0, 200)}`, updatedAt: Date.now() }, { merge: true });
    throw e;
  }
}
