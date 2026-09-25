import { useEffect, useMemo, useRef, useState } from 'react';
import { ScanFace, Trash2, Wand2 } from 'lucide-react';
import { aspectValue, computeReframe, cropSize, formatTimecode, headsCut, reframeAt, type Box, type Clip, type ReframeKeyframe, type ReframeTrack, type SubjectSample } from '@az-studio/shared';
import { useProjectDoc } from '../lib/continuity';
import { useMediaUrls } from '../lib/media';
import { useJobSubmitter } from './jobs';
import { useAsset } from './media';
import { Button, Notice, Segmented } from './ui';

type SubjectTrackDoc = { samples: { t: number; faces: { box: Box; confidence: number }[]; people: { box: Box; score: number }[] }[]; fps?: number };

const ASPECTS = ['9:16', '1:1', '4:5', '16:9'] as const;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * Face-safe reframing of one clip for other aspect ratios: the automatic crop path from tracked faces,
 * speakers and people (smoothed, speed-limited, never a fixed centre crop), manual keyframes that always
 * win (drag the crop at the playhead), and a warning wherever a face would be cut.
 */
export function ReframeEditor({ projectId, clip, time, onChange }: { projectId: string; clip: Clip; time: number; onChange: (patch: Partial<Clip>, label: string) => void }) {
  const asset = useAsset(clip.assetId);
  const urls = useMediaUrls(clip.assetId);
  const track = useProjectDoc<SubjectTrackDoc>(projectId, 'subjectTracks', clip.assetId);
  const { submit, busy, dialog } = useJobSubmitter();
  const [aspect, setAspect] = useState<(typeof ASPECTS)[number]>('9:16');
  const videoRef = useRef<HTMLVideoElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x: number; y: number; cx: number; cy: number } | null>(null);
  const [live, setLive] = useState<{ cx: number; cy: number } | null>(null);
  const w = asset.data?.width ?? 16;
  const h = asset.data?.height ?? 9;
  const src = w / h;
  const dst = aspectValue(aspect);
  const crop = cropSize(src, dst);
  const local = Math.max(0, Math.min(clip.duration, time - clip.start));
  const samples: SubjectSample[] = useMemo(
    () =>
      (track.data?.samples ?? [])
        .filter((s) => s.t >= clip.inPoint - 0.5 && s.t <= clip.inPoint + clip.duration + 0.5)
        .map((s) => ({ t: r4(s.t - clip.inPoint), subjects: [...s.faces.filter((f) => f.confidence >= 0.5).map((f) => ({ box: f.box, kind: 'face' as const })), ...s.people.filter((p) => p.score >= 0.5).map((p) => ({ box: p.box, kind: 'person' as const }))] })),
    [track.data, clip.inPoint, clip.duration],
  );
  const stored = clip.reframe?.[aspect] ?? null;
  const manual = useMemo(() => (stored?.keyframes ?? []).filter((k) => k.manual), [stored]);
  const auto = useMemo(() => computeReframe(samples, src, dst, { manual }), [samples, src, dst, manual]);
  const keys = stored?.keyframes ?? auto.keyframes;
  const at = live ?? reframeAt(keys, local);
  const cut = useMemo(() => headsCut(samples, keys, crop), [samples, keys, crop]);
  const nearest = samples.length ? samples.reduce((a, b) => (Math.abs(b.t - local) < Math.abs(a.t - local) ? b : a)) : null;

  useEffect(() => {
    const v = videoRef.current;
    if (v && Math.abs(v.currentTime - (clip.inPoint + local)) > 0.08) v.currentTime = clip.inPoint + local;
  }, [clip.inPoint, local, urls?.file]);

  const store = (nextManual: ReframeKeyframe[], label: string) => {
    const t: ReframeTrack = { ...computeReframe(samples, src, dst, { manual: nextManual }), aspect };
    onChange({ reframe: { ...(clip.reframe ?? {}), [aspect]: t } }, label);
  };
  const clamp = (v: number, size: number) => Math.min(1 - size / 2, Math.max(size / 2, v));
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    setDrag({ x: e.clientX, y: e.clientY, cx: at.cx, cy: at.cy });
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag || !boxRef.current) return;
    const r = boxRef.current.getBoundingClientRect();
    setLive({ cx: r4(clamp(drag.cx + (e.clientX - drag.x) / r.width, crop.w)), cy: r4(clamp(drag.cy + (e.clientY - drag.y) / r.height, crop.h)) });
  };
  const onUp = () => {
    if (drag && live) store([...manual.filter((k) => Math.abs(k.t - local) > 0.2), { t: r4(local), cx: live.cx, cy: live.cy, manual: true }].sort((a, b) => a.t - b.t), 'Reframe keyframe');
    setDrag(null);
    setLive(null);
  };
  if (clip.kind !== 'video' || !clip.assetId) return null;
  const same = Math.abs(src - dst) / dst < 0.02;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="eyebrow">Face-safe reframing</p>
        <Segmented size="sm" label="Target aspect" value={aspect} onChange={setAspect} options={ASPECTS.map((a) => ({ value: a, label: a }))} />
      </div>
      {same ? (
        <p className="text-xs text-faint">The clip is already {aspect}; no reframing is needed.</p>
      ) : (
        <>
          <div ref={boxRef} className="relative w-full overflow-hidden rounded-lg bg-black" style={{ aspectRatio: String(src) }}>
            {urls?.file && <video ref={videoRef} src={urls.file} muted playsInline preload="auto" className="absolute inset-0 size-full" />}
            {nearest?.subjects.filter((s) => s.kind === 'face').map((s, i) => (
              <div key={i} className="pointer-events-none absolute border border-success/80" style={{ left: `${s.box.x * 100}%`, top: `${s.box.y * 100}%`, width: `${s.box.w * 100}%`, height: `${s.box.h * 100}%` }} />
            ))}
            <div
              role="slider"
              aria-label="Crop position"
              aria-valuenow={Math.round(at.cx * 100)}
              tabIndex={0}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
              className="absolute cursor-grab border-2 border-accent shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]"
              style={{ left: `${(at.cx - crop.w / 2) * 100}%`, top: `${(at.cy - crop.h / 2) * 100}%`, width: `${crop.w * 100}%`, height: `${crop.h * 100}%` }}
            />
          </div>
          <p className="text-[11px] text-faint">Drag the frame to set a keyframe at {formatTimecode(local)} (clip time). Manual keyframes always win over the automatic path.</p>
          {!track.data ? (
            <Notice>
              No face tracking for this clip yet — without it the export uses a centred crop.{' '}
              <Button size="sm" variant="ghost" loading={busy} icon={<ScanFace className="size-3.5" />} onClick={() => void submit([{ type: 'media.analyze_subjects', projectId, assetIds: [clip.assetId!], fps: 1, label: 'Track faces for reframing' }], { label: 'Face tracking' })}>
                Track faces
              </Button>
            </Notice>
          ) : (
            <p className="text-[11px] text-dim">
              {samples.length} tracked sample{samples.length === 1 ? '' : 's'} · {keys.length} keyframe{keys.length === 1 ? '' : 's'} ({manual.length} manual){stored ? ' · saved on the clip' : ' · computed automatically at export'}
            </p>
          )}
          {cut.length > 0 && <Notice tone="warning">A face would be cut at {cut.slice(0, 4).map((t) => formatTimecode(t)).join(', ')} — two people are too far apart for {aspect}. Add a keyframe favouring the speaker, or use Fit / Blurred background for this clip.</Notice>}
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="ghost" icon={<Wand2 className="size-3.5" />} disabled={!samples.length} onClick={() => store(manual, 'Reframe path')}>
              Save path on the clip
            </Button>
            {stored && (
              <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => {
                  const next = { ...(clip.reframe ?? {}) };
                  delete next[aspect];
                  onChange({ reframe: Object.keys(next).length ? next : null }, 'Clear reframe');
                }}>
                Clear
              </Button>
            )}
          </div>
          {manual.length > 0 && (
            <ul className="space-y-0.5 text-[11px] text-dim">
              {manual.map((k) => (
                <li key={k.t} className="flex items-center gap-2">
                  <span className="timecode">{formatTimecode(k.t)}</span>
                  <span>
                    centre {Math.round(k.cx * 100)}%, {Math.round(k.cy * 100)}%
                  </span>
                  <button type="button" className="ml-auto cursor-pointer text-faint hover:text-fg" onClick={() => store(manual.filter((x) => x !== k), 'Remove reframe keyframe')}>
                    remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {dialog}
    </div>
  );
}
