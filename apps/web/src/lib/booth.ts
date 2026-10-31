import { useCallback, useEffect, useRef, useState } from 'react';
import type { BoothSceneDoc, LiteBoothRequest } from '@az-studio/shared';
import { api } from './api';
import { useDoc } from './data';
import { uploadFile } from './media';
import { pickMime } from '../components/narrator/Recorder';

/** Calls one recording-booth operation on the owner-only API. */
export function booth<T, O extends LiteBoothRequest['op']>(op: O, payload: Omit<Extract<LiteBoothRequest, { op: O }>, 'op'>): Promise<T> {
  return api<T, 'liteBooth'>('liteBooth', { op, ...payload } as LiteBoothRequest);
}

/** The scene's booth state (written by the API; the owner reads it live). */
export const useBoothScene = (projectId: string | undefined, sceneId: string | undefined) => useDoc<BoothSceneDoc>(projectId && sceneId ? `projects/${projectId}/boothScenes/${sceneId}` : null);

/** Uploads a recorded take through the ordinary asset path (createUpload → storage → azsOnUpload validation). */
export async function uploadTake(blob: Blob, opts: { projectId: string; sceneId: string; lineId: string; label: string }): Promise<string> {
  // The storage rules accept `type/subtype` only, so codec parameters are dropped from the declared type.
  const type = (blob.type || 'audio/webm').split(';')[0]!.trim();
  const ext = type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'm4a' : type.includes('wav') ? 'wav' : 'webm';
  const file = new File([blob], `booth-${opts.lineId}-${Date.now().toString(36)}.${ext}`, { type });
  return uploadFile(file, { kind: 'audio', projectId: opts.projectId, title: opts.label.slice(0, 160), collections: ['lite:booth', `lite:booth:scene:${opts.sceneId}`] });
}

export type MicPhase = 'idle' | 'requesting' | 'recording';

/**
 * Microphone capture for one take at a time (the Narrator Recorder's pattern: raw input without browser processing,
 * a live peak meter, the microphone released as soon as recording stops or the page closes).
 */
export function useMicTake(onTake: (blob: Blob, seconds: number) => void, maxSec: number) {
  const [phase, setPhase] = useState<MicPhase>('idle');
  const [level, setLevel] = useState(0);
  const [clipped, setClipped] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const ctx = useRef<AudioContext | null>(null);
  const raf = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const chunks = useRef<Blob[]>([]);
  const startedAt = useRef(0);
  const clipAt = useRef(0);
  const cb = useRef(onTake);
  cb.current = onTake;

  const release = useCallback(() => {
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = null;
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    void ctx.current?.close().catch(() => undefined);
    ctx.current = null;
    setLevel(0);
  }, []);

  useEffect(
    () => () => {
      if (recorder.current && recorder.current.state !== 'inactive') {
        recorder.current.onstop = null;
        recorder.current.stop();
      }
      release();
    },
    [release],
  );

  const stop = useCallback(() => {
    if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop();
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setClipped(false);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('This browser cannot record audio here.');
      return;
    }
    setPhase('requesting');
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
      stream.current = s;
      setDevices((await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput'));
      const ac = new AudioContext();
      ctx.current = ac;
      const analyser = ac.createAnalyser();
      analyser.fftSize = 2048;
      ac.createMediaStreamSource(s).connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      const tick = () => {
        analyser.getFloatTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v));
        setLevel(peak);
        if (peak >= 0.99) clipAt.current = performance.now();
        setClipped(clipAt.current > 0 && performance.now() - clipAt.current < 1200);
        raf.current = requestAnimationFrame(tick);
      };
      tick();
      const mime = pickMime();
      const rec = new MediaRecorder(s, mime ? { mimeType: mime } : undefined);
      recorder.current = rec;
      chunks.current = [];
      rec.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      rec.onstop = () => {
        const seconds = (performance.now() - startedAt.current) / 1000;
        const blob = new Blob(chunks.current, { type: rec.mimeType || mime || 'audio/webm' });
        release();
        setPhase('idle');
        cb.current(blob, seconds);
      };
      rec.start(250);
      startedAt.current = performance.now();
      setElapsed(0);
      timer.current = setInterval(() => {
        const sec = (performance.now() - startedAt.current) / 1000;
        setElapsed(sec);
        if (sec >= maxSec) stop();
      }, 100);
      setPhase('recording');
    } catch (e) {
      release();
      setPhase('idle');
      const name = (e as DOMException)?.name;
      setError(name === 'NotAllowedError' || name === 'SecurityError' ? 'Microphone access was denied. Allow it in the browser’s site settings.' : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'No microphone was found.' : name === 'NotReadableError' ? 'The microphone is in use by another app.' : 'Recording could not start.');
    }
  }, [deviceId, maxSec, release, stop]);

  return { phase, level, clipped, elapsed, error, devices, deviceId, setDeviceId, start, stop };
}
