import { useMemo, useRef } from 'react';
import { RotateCcw } from 'lucide-react';
import { MOTION_PRESET_INTENT, MOTION_PRESET_LABELS, MOTION_PRESETS, aspectNumber, coverSize, rectFraming, resolveShotMotion, type MotionIssue, type MotionPreset, type NRect, type ShotMotion } from '@az-studio/shared';
import { useMediaUrls } from '../../lib/media';
import { Badge, Button, cx, Slider, Tip } from '../ui';


/** Tiny looping examples of each movement (the frame moves over a stand-in picture). */
const EXAMPLE_CSS = `
@keyframes lite-push_in { from { transform: scale(1); } to { transform: scale(0.8); } }
@keyframes lite-pull_out { from { transform: scale(0.8); } to { transform: scale(1); } }
@keyframes lite-pan_left { from { transform: translateX(12%) scale(0.82); } to { transform: translateX(-12%) scale(0.82); } }
@keyframes lite-pan_right { from { transform: translateX(-12%) scale(0.82); } to { transform: translateX(12%) scale(0.82); } }
@keyframes lite-tilt_up { from { transform: translateY(12%) scale(0.82); } to { transform: translateY(-12%) scale(0.82); } }
@keyframes lite-tilt_down { from { transform: translateY(-12%) scale(0.82); } to { transform: translateY(12%) scale(0.82); } }
@keyframes lite-drift { from { transform: translate(-8%, -6%) scale(0.85); } to { transform: translate(8%, 6%) scale(0.8); } }
@keyframes lite-still { from { transform: scale(0.9); } to { transform: scale(0.9); } }
`;

export function MotionExample({ preset, className }: { preset: MotionPreset; className?: string }) {
  return (
    <span className={cx('relative inline-block h-[27px] w-12 overflow-hidden rounded-[5px] bg-gradient-to-br from-[#36507d] via-[#1d2a44] to-[#0b1020]', className)} aria-hidden>
      <style>{EXAMPLE_CSS}</style>
      <span className="absolute top-[35%] left-[55%] size-2 rounded-full bg-[#f4b84a]/80" />
      <span className="absolute inset-[3px] rounded-[3px] border border-white/80" style={{ animation: `lite-${preset} 2.6s ease-in-out infinite alternate` }} />
    </span>
  );
}

export function MotionPresetPicker({ value, onChange }: { value: MotionPreset; onChange: (p: MotionPreset) => void }) {
  return (
    <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4" role="radiogroup" aria-label="Camera movement">
      {MOTION_PRESETS.map((p) => (
        <Tip key={p} label={MOTION_PRESET_INTENT[p]}>
          <button type="button" role="radio" aria-checked={value === p} onClick={() => onChange(p)} className={cx('flex cursor-pointer items-center gap-2 rounded-lg border px-2 py-1.5 text-left text-xs transition-colors', value === p ? 'border-accent/60 bg-accent/10 text-fg' : 'border-line text-dim hover:border-line-strong hover:text-fg')}>
            <MotionExample preset={p} />
            {MOTION_PRESET_LABELS[p]}
          </button>
        </Tip>
      ))}
    </div>
  );
}

interface Props {
  assetId: string;
  dims: { w: number; h: number } | null;
  motion: ShotMotion;
  aspect: string;
  durationSec: number;
  outWidth: number;
  onChange: (m: ShotMotion) => void;
}

/**
 * Start (blue) and end (amber) framing over the real image. Drag a frame to move it, drag its corner to
 * zoom, click elsewhere to set the focal point. Hand-set frames apply to this format only; other formats
 * keep following the preset and focal point.
 */
export function FramingEditor({ assetId, dims, motion, aspect, durationSec, outWidth, onChange }: Props) {
  const urls = useMediaUrls(assetId);
  const box = useRef<HTMLDivElement>(null);
  const resolved = useMemo(() => resolveShotMotion(motion, dims ?? { w: null, h: null }, { aspect, durationSec, outWidth }), [motion, dims, aspect, durationSec, outWidth]);
  const imgAspect = dims ? dims.w / dims.h : aspectNumber(aspect);
  const manual = Boolean(motion.manual?.[aspect]);
  const src = dims ?? { w: imgAspect, h: 1 };

  const setFrames = (from: NRect, to: NRect) => {
    const out = aspectNumber(aspect);
    onChange({ ...motion, manual: { ...(motion.manual ?? {}), [aspect]: { from: rectFraming(from, src, out), to: rectFraming(to, src, out) } } });
  };

  const drag = (e: React.PointerEvent, which: 'from' | 'to', mode: 'move' | 'zoom') => {
    e.stopPropagation();
    e.preventDefault();
    const el = box.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY };
    const base = { from: { ...resolved.motion.from }, to: { ...resolved.motion.to } };
    const cover = coverSize(src, aspectNumber(aspect));
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - start.x) / rect.width;
      const dy = (ev.clientY - start.y) / rect.height;
      const r = { ...base[which] };
      if (mode === 'move') {
        r.x = Math.max(0, Math.min(1 - r.w, r.x + dx));
        r.y = Math.max(0, Math.min(1 - r.h, r.y + dy));
      } else {
        const cx = r.x + r.w / 2;
        const cy = r.y + r.h / 2;
        const w = Math.max(cover.w / 2.5, Math.min(cover.w, r.w + dx * 2));
        const h = (w / cover.w) * cover.h;
        r.w = w;
        r.h = h;
        r.x = Math.max(0, Math.min(1 - w, cx - w / 2));
        r.y = Math.max(0, Math.min(1 - h, cy - h / 2));
      }
      setFrames(which === 'from' ? r : base.from, which === 'to' ? r : base.to);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const setFocal = (e: React.MouseEvent) => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    onChange({ ...motion, focal: { x: Math.round(((e.clientX - r.left) / r.width) * 1000) / 1000, y: Math.round(((e.clientY - r.top) / r.height) * 1000) / 1000 } });
  };

  const frame = (r: NRect, tone: 'from' | 'to') => (
    <div
      className={cx('absolute cursor-move rounded-[3px] border-2', tone === 'from' ? 'border-accent-2 bg-accent/5' : 'border-warning bg-warning/5')}
      style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }}
      onPointerDown={(e) => drag(e, tone, 'move')}
      role="button"
      aria-label={tone === 'from' ? 'Start framing' : 'End framing'}
    >
      <span className={cx('absolute top-1 left-1 rounded px-1 text-[10px] font-medium', tone === 'from' ? 'bg-accent text-white' : 'bg-warning text-black')}>{tone === 'from' ? 'Start' : 'End'}</span>
      <span className={cx('absolute -right-1.5 -bottom-1.5 size-3 cursor-nwse-resize rounded-sm border-2 bg-black', tone === 'from' ? 'border-accent-2' : 'border-warning')} onPointerDown={(e) => drag(e, tone, 'zoom')} aria-label="Resize framing" role="button" />
    </div>
  );

  const issues = resolved.issues.filter((i: MotionIssue) => i.kind !== 'no_dimensions');
  return (
    <div className="space-y-3">
      <div className="relative mx-auto w-full overflow-hidden rounded-xl bg-black" style={{ aspectRatio: String(imgAspect), maxHeight: 420 }}>
        <div ref={box} className="absolute inset-0" onClick={setFocal}>
          {urls?.file || urls?.thumb ? <img src={urls.file ?? urls.thumb} alt="" className="absolute inset-0 size-full object-fill opacity-90" draggable={false} /> : <div className="absolute inset-0 animate-pulse bg-panel-2" />}
          <div className="absolute inset-0 bg-black/35" />
          {frame(resolved.motion.from, 'from')}
          {!(resolved.motion.from.x === resolved.motion.to.x && resolved.motion.from.y === resolved.motion.to.y && resolved.motion.from.w === resolved.motion.to.w) && frame(resolved.motion.to, 'to')}
          <span className="pointer-events-none absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-[#f4b84a]/70 shadow" style={{ left: `${motion.focal.x * 100}%`, top: `${motion.focal.y * 100}%` }} aria-label="Focal point" />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge tone={manual ? 'violet' : 'neutral'}>{manual ? `Hand-set for ${aspect}` : 'Follows the preset and focal point'}</Badge>
        {resolved.scale !== null && <Badge tone={resolved.scale > 1.5 ? 'danger' : resolved.scale > 1.12 ? 'warning' : 'success'}>{resolved.scale <= 1 ? 'Full resolution' : `Enlarged ${resolved.scale.toFixed(2)}×`}</Badge>}
        {manual && (
          <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => onChange({ ...motion, manual: Object.fromEntries(Object.entries(motion.manual ?? {}).filter(([k]) => k !== aspect)) })}>
            Back to preset
          </Button>
        )}
        <span className="text-faint">Click the image to set what must stay in view.</span>
      </div>
      {issues.length > 0 && (
        <ul className="space-y-1 text-xs">
          {issues.map((i, k) => (
            <li key={k} className={i.severity === 'error' ? 'text-danger' : i.severity === 'warning' ? 'text-warning' : 'text-faint'}>
              {i.message}
            </li>
          ))}
        </ul>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <div className="mb-1.5 flex items-center justify-between text-xs">
            <span className="text-dim">{/^(pan|tilt)/.test(motion.preset) ? 'Travel' : 'Amount of movement'}</span>
            <span className="timecode text-fg">{Math.round(motion.intensity * 100)} %</span>
          </div>
          <Slider label={/^(pan|tilt)/.test(motion.preset) ? 'Travel' : 'Amount of movement'} value={Math.round(motion.intensity * 100)} min={0} max={20} step={1} onChange={(v) => onChange({ ...motion, intensity: v / 100, manual: null })} />
        </div>
        <div className="text-xs text-dim">
          <p className="mb-1 text-faint">Easing</p>
          <div className="flex gap-1.5">
            {(['gentle', 'linear', 'ease_in_out'] as const).map((e) => (
              <button key={e} type="button" onClick={() => onChange({ ...motion, ease: e })} className={cx('cursor-pointer rounded-md border px-2 py-1', motion.ease === e ? 'border-accent/60 bg-accent/10 text-fg' : 'border-line hover:text-fg')}>
                {e === 'gentle' ? 'Gentle' : e === 'linear' ? 'Constant' : 'Ease in & out'}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
