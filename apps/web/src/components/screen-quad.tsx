import { useRef, useState } from 'react';
import type { StagePoint } from '@az-studio/shared';
import { useMediaUrls } from '../lib/media';
import { cx } from './ui';

export type Quad = [StagePoint, StagePoint, StagePoint, StagePoint];

export const DEFAULT_QUAD: Quad = [
  { x: 0.4, y: 0.35 },
  { x: 0.6, y: 0.35 },
  { x: 0.6, y: 0.65 },
  { x: 0.4, y: 0.65 },
];

const LABELS = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];

/**
 * Four draggable corners over a still (clockwise from top-left, 0–1 of the frame). Used for the default
 * position of a protected screen in static shots; moving shots are tracked automatically.
 */
export function ScreenQuadEditor({ assetId, value, onChange, className }: { assetId: string | null; value: Quad; onChange: (q: Quad) => void; className?: string }) {
  const urls = useMediaUrls(assetId);
  const ref = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  // The frame keeps the still's own proportions so corner coordinates are fractions of the real frame.
  const [aspect, setAspect] = useState(16 / 9);
  const W = Math.round(1000 * aspect);
  const move = (e: { clientX: number; clientY: number }) => {
    if (drag === null || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const p = { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
    onChange(value.map((c, i) => (i === drag ? { x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 } : c)) as Quad);
  };
  return (
    <div className={cx('relative mx-auto max-h-[60vh] w-full overflow-hidden rounded-xl border border-line bg-black', className)} style={{ aspectRatio: String(aspect) }}>
      {urls?.file ? (
        <img
          src={urls.file}
          alt="Screen reference"
          className="absolute inset-0 size-full"
          draggable={false}
          onLoad={(e) => {
            const img = e.currentTarget;
            if (img.naturalWidth && img.naturalHeight) setAspect(img.naturalWidth / img.naturalHeight);
          }}
        />
      ) : (
        <div className="absolute inset-0 grid place-items-center p-4 text-center text-xs text-faint">{assetId ? 'Loading…' : 'Choose a reference still to place the corners on'}</div>
      )}
      <svg ref={ref} viewBox={`0 0 ${W} 1000`} preserveAspectRatio="none" className="absolute inset-0 size-full touch-none" onPointerMove={move} onPointerUp={() => setDrag(null)} onPointerLeave={() => setDrag(null)} role="img" aria-label="Screen corners">
        <polygon points={value.map((c) => `${c.x * W},${c.y * 1000}`).join(' ')} fill="rgba(76,141,255,0.18)" stroke="#4c8dff" strokeWidth={4} />
        {value.map((c, i) => (
          <circle
            key={LABELS[i]}
            cx={c.x * W}
            cy={c.y * 1000}
            r={18}
            fill={drag === i ? '#ffffff' : '#4c8dff'}
            stroke="#0a101b"
            strokeWidth={4}
            className="cursor-grab"
            onPointerDown={(e) => {
              e.stopPropagation();
              setDrag(i);
              (e.target as Element).setPointerCapture?.(e.pointerId);
            }}
          >
            <title>{LABELS[i]}</title>
          </circle>
        ))}
      </svg>
    </div>
  );
}
