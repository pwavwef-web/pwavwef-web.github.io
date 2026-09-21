/// <reference lib="webworker" />
import { analyzeAudio } from '@az-studio/shared';

self.onmessage = (e: MessageEvent<{ samples: Float32Array; sampleRate: number }>) => {
  try {
    const result = analyzeAudio(e.data.samples, e.data.sampleRate, { peakBins: 2400 });
    self.postMessage({ ok: true, result });
  } catch (err) {
    self.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
