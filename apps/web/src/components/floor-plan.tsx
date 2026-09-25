import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { FloorItem, FloorItemKind } from '@az-studio/shared';
import { cx } from './ui';

export const FLOOR_COLOURS: Record<FloorItemKind, { fill: string; stroke: string }> = {
  wall: { fill: '#8a93a6', stroke: '#c7cfdd' },
  door: { fill: '#b7773a', stroke: '#f0b273' },
  window: { fill: '#3f7fb8', stroke: '#8cc4f2' },
  furniture: { fill: '#5b4a8a', stroke: '#a996e6' },
  light: { fill: '#c9a227', stroke: '#ffe27a' },
  object: { fill: '#3d7a5a', stroke: '#7fd3a6' },
  sign: { fill: '#b8456a', stroke: '#f28bb0' },
  zone: { fill: 'rgba(76,141,255,0.12)', stroke: '#4c8dff' },
  camera: { fill: '#222a38', stroke: '#e9eef7' },
};

const S = 1000;

/**
 * Top-down plan in normalised coordinates (0–1, north at the top). Items can be dragged when editable;
 * extra SVG (blocking entities, cameras, arrows) is drawn on top through `children`.
 */
export function FloorPlan({ items, planSizeM, editable, selectedId, onSelect, onMove, children, className, onBackgroundPointer }: { items: FloorItem[]; planSizeM: number; editable?: boolean; selectedId?: string | null; onSelect?: (id: string | null) => void; onMove?: (id: string, x: number, y: number) => void; children?: ReactNode; className?: string; onBackgroundPointer?: (p: { x: number; y: number }, e: ReactPointerEvent<SVGSVGElement>) => void }) {
  const ref = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number } | null>(null);
  const toPlan = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };
  const metres = Math.max(1, Math.round(planSizeM));
  const step = S / metres;
  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${S} ${S}`}
      className={cx('aspect-square w-full touch-none rounded-xl border border-line bg-[#0a101b] select-none', className)}
      onPointerMove={(e) => {
        if (!drag || !onMove) return;
        const p = toPlan(e);
        onMove(drag.id, Math.min(1.2, Math.max(-0.2, p.x - drag.dx)), Math.min(1.2, Math.max(-0.2, p.y - drag.dy)));
      }}
      onPointerUp={() => setDrag(null)}
      onPointerLeave={() => setDrag(null)}
      onPointerDown={(e) => {
        if (e.target === ref.current || (e.target as SVGElement).dataset.bg) {
          onSelect?.(null);
          onBackgroundPointer?.(toPlan(e), e);
        }
      }}
      role="img"
      aria-label="Top-down plan (north at the top)"
    >
      <rect x={0} y={0} width={S} height={S} fill="transparent" data-bg="1" />
      {metres <= 60 &&
        Array.from({ length: metres + 1 }, (_, i) => (
          <g key={i} data-bg="1">
            <line x1={i * step} y1={0} x2={i * step} y2={S} stroke="rgba(150,172,214,0.08)" strokeWidth={1} data-bg="1" />
            <line x1={0} y1={i * step} x2={S} y2={i * step} stroke="rgba(150,172,214,0.08)" strokeWidth={1} data-bg="1" />
          </g>
        ))}
      <text x={S / 2} y={24} textAnchor="middle" fill="#8c9ab3" fontSize={20} data-bg="1">
        N
      </text>
      <text x={S - 8} y={S - 10} textAnchor="end" fill="#5d6a82" fontSize={16} data-bg="1">
        {metres} m
      </text>
      {items.map((it) => {
        const c = FLOOR_COLOURS[it.kind];
        const w = Math.max(6, it.w * S);
        const h = Math.max(6, it.h * S);
        const x = it.x * S;
        const y = it.y * S;
        const sel = it.id === selectedId;
        return (
          <g
            key={it.id}
            transform={`rotate(${it.rotation} ${x + w / 2} ${y + h / 2})`}
            className={editable ? 'cursor-move' : undefined}
            onPointerDown={(e) => {
              e.stopPropagation();
              onSelect?.(it.id);
              if (!editable || it.locked) return;
              const p = toPlan(e);
              setDrag({ id: it.id, dx: p.x - it.x, dy: p.y - it.y });
              (e.target as Element).setPointerCapture?.(e.pointerId);
            }}
          >
            <rect x={x} y={y} width={w} height={h} rx={it.kind === 'zone' ? 12 : 3} fill={c.fill} stroke={sel ? '#ffffff' : c.stroke} strokeWidth={sel ? 4 : 2} strokeDasharray={it.kind === 'zone' ? '10 6' : undefined} />
            {it.locked && <circle cx={x + w - 6} cy={y + 6} r={5} fill="#ffe27a" />}
            <text x={x + w / 2} y={y + h / 2 + 6} textAnchor="middle" fill="#e9eef7" fontSize={Math.min(22, Math.max(12, w / 6))} pointerEvents="none">
              {(it.label || it.kind).slice(0, 18)}
            </text>
          </g>
        );
      })}
      {children}
    </svg>
  );
}
