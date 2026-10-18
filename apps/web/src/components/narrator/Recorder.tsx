import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleAlert, CircleCheck, Mic, Square, Trash2, TriangleAlert, Upload } from 'lucide-react';
import { ENROLLMENT, type ConsentLocale, type NarratorRecordingDoc, type RecordingKind } from '@az-studio/shared';
import { errorMessage } from '../../lib/api';
import { ref, uploadBytes } from 'firebase/storage';
import { fileToBase64, nar, newRequestId, useNarratorMedia, type UploadResult, type WithId } from '../../lib/narrator';
import { storage } from '../../lib/firebase';
import { useUid } from '../../lib/session';
import { Button, cx, Select } from '../ui';
import { ClipPlayer } from './audio';

const MIME_CHOICES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'];

function pickMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return MIME_CHOICES.find((m) => MediaRecorder.isTypeSupported(m));
}

type Phase = 'idle' | 'requesting' | 'recording' | 'uploading';

/** Larger files go to the owner's private upload inbox; the API converts and then deletes them. */
async function toInbox(blob: Blob, uid: string): Promise<string> {
  const path = `users/${uid}/narrator-inbox/${newRequestId('in')}`;
  await uploadBytes(ref(storage, path), blob, { contentType: blob.type.startsWith('audio/') ? blob.type : 'application/octet-stream' });
  return path;
}

/** Live input meter from the real microphone signal (peak, dBFS). */
function Meter({ level, clipped }: { level: number; clipped: boolean }) {
  const db = level > 0 ? 20 * Math.log10(level) : -90;
  const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  return (
    <div className="space-y-1">
      <div className="relative h-2.5 overflow-hidden rounded-full bg-white/[0.07]" role="meter" aria-label="Input level" aria-valuemin={-60} aria-valuemax={0} aria-valuenow={Math.round(db)} aria-valuetext={`${Math.round(db)} dBFS`}>
        <div className={cx('h-full rounded-full transition-[width] duration-75', db > -3 ? 'bg-danger' : db > -12 ? 'bg-warning' : 'bg-success')} style={{ width: `${pct}%` }} />
        <div className="absolute inset-y-0 w-px bg-white/40" style={{ left: `${((-12 + 60) / 60) * 100}%` }} aria-hidden />
      </div>
      <div className="flex justify-between text-[10.5px] text-faint">
        <span>Quiet</span>
        <span className={clipped ? 'font-medium text-[#ff9b9b]' : ''}>{clipped ? 'Too loud — distortion' : 'Aim for peaks just under the line'}</span>
      </div>
    </div>
  );
}

export function RecordingSummary({ rec }: { rec: WithId<NarratorRecordingDoc> }) {
  const src = useNarratorMedia({ kind: 'recording', id: rec.id });
  const a = rec.analysis;
  const errors = a.issues.filter((i) => i.severity === 'error');
  const warnings = a.issues.filter((i) => i.severity === 'warning');
  return (
    <div className="space-y-2.5">
      <ClipPlayer src={src} label={`${rec.kind} recording`} />
      <p className="text-xs text-faint">
        {a.durationSec.toFixed(1)} s · speech {a.speechSec.toFixed(1)} s · peak {a.peakDbfs} dBFS · noise floor {a.noiseFloorDbfs} dBFS · converted to 24 kHz mono 16-bit WAV
      </p>
      {errors.map((i) => (
        <p key={i.code} className="flex items-start gap-1.5 text-[13px] text-[#ff9b9b]">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> {i.message}
        </p>
      ))}
      {warnings.map((i) => (
        <p key={i.code} className="flex items-start gap-1.5 text-[13px] text-warning">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> {i.message}
        </p>
      ))}
      {!a.issues.length && (
        <p className="flex items-center gap-1.5 text-[13px] text-success">
          <CircleCheck className="size-4" aria-hidden /> No problems measured. Listen back before you continue — measurements cannot judge how natural it sounds.
        </p>
      )}
    </div>
  );
}

/**
 * Records from the microphone or accepts a file, then uploads it privately; the server converts it to
 * 24 kHz mono 16-bit WAV (never just renamed) and measures length, level, clipping, noise and pauses.
 * The microphone is released when recording stops or the component unmounts (leaving the screen).
 */
export function Recorder({ kind, recording, onChange, consentLocale, termId, scriptText, compact }: { kind: RecordingKind; recording: WithId<NarratorRecordingDoc> | null; onChange: (recordingId: string | null) => void; consentLocale?: ConsentLocale; termId?: string; scriptText?: string; compact?: boolean }) {
  const limits = ENROLLMENT[kind];
  const uid = useUid();
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [clipped, setClipped] = useState(false);
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
  const fileInput = useRef<HTMLInputElement>(null);

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

  // Leaving the screen stops capture and releases the microphone.
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

  const upload = async (blob: Blob, source: 'microphone' | 'upload') => {
    setPhase('uploading');
    setError(null);
    try {
      if (blob.size > ENROLLMENT.maxUploadBytes) throw new Error(`The file is ${(blob.size / 1048576).toFixed(1)} MB; the limit is ${ENROLLMENT.maxUploadBytes / 1048576} MB.`);
      const transport = blob.size <= ENROLLMENT.maxInlineBytes ? { dataBase64: await fileToBase64(blob) } : { inboxPath: await toInbox(blob, uid) };
      const res = await nar<UploadResult>('recordingUpload', { kind, source, mimeType: blob.type || 'application/octet-stream', ...transport, ...(scriptText ? { scriptText: scriptText.slice(0, 2000) } : {}), ...(consentLocale ? { consentLocale } : {}), ...(termId ? { termId } : {}) });
      if (recording) void nar('recordingDelete', { recordingId: recording.id }).catch(() => undefined);
      onChange(res.recordingId);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPhase('idle');
    }
  };

  const stop = () => {
    if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop();
  };

  const start = async () => {
    setError(null);
    setClipped(false);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('This browser cannot record audio here. Upload a recording instead.');
      return;
    }
    setPhase('requesting');
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
      stream.current = s;
      const list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
      setDevices(list);
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
        setClipped(performance.now() - clipAt.current < 1200 && clipAt.current > 0);
        raf.current = requestAnimationFrame(tick);
      };
      tick();
      const mime = pickMime();
      const rec = new MediaRecorder(s, mime ? { mimeType: mime } : undefined);
      recorder.current = rec;
      chunks.current = [];
      rec.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      rec.onstop = () => {
        const blob = new Blob(chunks.current, { type: rec.mimeType || mime || 'audio/webm' });
        release();
        void upload(blob, 'microphone');
      };
      rec.start(250);
      startedAt.current = performance.now();
      setElapsed(0);
      timer.current = setInterval(() => {
        const sec = (performance.now() - startedAt.current) / 1000;
        setElapsed(sec);
        if (sec >= limits.maxSec) stop();
      }, 100);
      setPhase('recording');
    } catch (e) {
      release();
      setPhase('idle');
      const name = (e as DOMException)?.name;
      setError(name === 'NotAllowedError' || name === 'SecurityError' ? 'Microphone access was denied. Allow it in the browser’s site settings, or upload a recording instead.' : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'No microphone was found. Connect one, or upload a recording instead.' : name === 'NotReadableError' ? 'The microphone is in use by another app. Close it and try again.' : `Recording could not start (${errorMessage(e)}).`);
    }
  };

  const remove = async () => {
    if (!recording) return;
    try {
      await nar('recordingDelete', { recordingId: recording.id });
      onChange(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const recordingNow = phase === 'recording';
  const inRange = elapsed >= limits.minSec && elapsed <= limits.maxSec;
  return (
    <div className={cx('space-y-4', compact && 'space-y-3')}>
      {recordingNow ? (
        <div className="space-y-3 rounded-xl border border-danger/30 bg-danger/[0.06] p-4" aria-live="polite">
          <div className="flex items-center justify-between gap-3">
            <p className="flex items-center gap-2 text-sm font-medium text-fg">
              <span className="size-2.5 animate-pulse rounded-full bg-danger" aria-hidden /> Recording
            </p>
            <p className={cx('timecode text-lg', inRange ? 'text-success' : 'text-fg')} aria-label={`${elapsed.toFixed(0)} seconds recorded`}>
              {elapsed.toFixed(1)} s<span className="text-sm text-faint"> / {limits.minSec}–{limits.maxSec} s</span>
            </p>
          </div>
          <Meter level={level} clipped={clipped} />
          <Button variant="danger" icon={<Square className="size-4" />} onClick={stop} className="w-full sm:w-auto">
            Stop recording
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant={recording ? 'secondary' : 'primary'} icon={<Mic className="size-4" />} loading={phase === 'requesting'} disabled={phase === 'uploading'} onClick={() => void start()}>
            {recording ? 'Record again' : 'Start recording'}
          </Button>
          <Button variant="ghost" icon={<Upload className="size-4" />} disabled={phase !== 'idle'} onClick={() => fileInput.current?.click()}>
            Upload a file
          </Button>
          {recording && (
            <Button variant="ghost" icon={<Trash2 className="size-4" />} disabled={phase !== 'idle'} onClick={() => void remove()}>
              Delete
            </Button>
          )}
          {devices.length > 1 && (
            <Select aria-label="Microphone" value={deviceId} onChange={(e) => setDeviceId(e.target.value)} className="w-auto max-w-56 py-1.5 text-xs">
              <option value="">Default microphone</option>
              {devices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || 'Microphone'}
                </option>
              ))}
            </Select>
          )}
          <input
            ref={fileInput}
            type="file"
            accept="audio/*,.wav,.mp3,.m4a,.flac,.ogg,.webm"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void upload(f, 'upload');
            }}
          />
        </div>
      )}
      {phase === 'uploading' && <p className="text-sm text-dim" role="status">Converting and checking the recording…</p>}
      {error && (
        <p className="flex items-start gap-1.5 text-[13px] text-[#ff9b9b]" role="alert">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> {error}
        </p>
      )}
      {recording && phase !== 'recording' && <RecordingSummary rec={recording} />}
    </div>
  );
}
