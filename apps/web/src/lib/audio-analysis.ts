import { mixToMono, type AudioAnalysisResult } from '@az-studio/shared';
import { getMediaUrls } from './media';

/** Decodes an audio asset in the browser and runs the beat/section analysis in a Web Worker. */
export async function analyzeAssetAudio(assetId: string, onStage?: (s: string) => void): Promise<AudioAnalysisResult> {
  onStage?.('Downloading audio');
  const urls = await getMediaUrls(assetId);
  if (!urls.file) throw new Error('The audio file is not available.');
  const res = await fetch(urls.file);
  if (!res.ok) throw new Error(`Could not load the audio (${res.status}).`);
  const buf = await res.arrayBuffer();
  onStage?.('Decoding');
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AC();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(buf);
  } finally {
    void ctx.close();
  }
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i));
  const mono = mixToMono(channels);
  onStage?.('Finding beats and sections');
  const worker = new Worker(new URL('../workers/audio.worker.ts', import.meta.url), { type: 'module' });
  try {
    return await new Promise<AudioAnalysisResult>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<{ ok: boolean; result?: AudioAnalysisResult; error?: string }>) => (e.data.ok ? resolve(e.data.result!) : reject(new Error(e.data.error)));
      worker.onerror = (e) => reject(new Error(e.message || 'Audio analysis failed.'));
      const copy = new Float32Array(mono);
      worker.postMessage({ samples: copy, sampleRate: decoded.sampleRate }, [copy.buffer]);
    });
  } finally {
    worker.terminate();
  }
}

/** Timed prompt cues from beats inside a clip window (Omni takes timing directions, not audio). */
export function beatCues(beats: number[], windowStart: number, windowSec: number, effect: string, maxCues = 12): string {
  const inside = beats.filter((b) => b >= windowStart && b < windowStart + windowSec).map((b) => Math.round((b - windowStart) * 10) / 10);
  const picked = inside.length > maxCues ? inside.filter((_, i) => i % Math.ceil(inside.length / maxCues) === 0) : inside;
  if (!picked.length) return '';
  return `Sync the visual changes to the music's beat: ${picked.map((t) => `at ${t}s`).join(', ')} — on each beat, ${effect}.`;
}
