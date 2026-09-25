import { Replace, Scissors, Trash2 } from 'lucide-react';
import { DEFAULT_TEXT_STYLE, formatTimecode, TEXT_FONTS, TRANSITION_TYPES, type Clip, type FitMode, type TextPosition, type TextStyle, type TimelineState, type TransitionType } from '@az-studio/shared';
import { Button, Field, Input, Segmented, Select, Slider, Textarea, Toggle } from '../../components/ui';
import { ReframeEditor } from '../../components/reframe-editor';

const TRANSITION_LABEL: Record<TransitionType, string> = { cut: 'Cut', dissolve: 'Dissolve', dip_black: 'Dip to black', dip_white: 'Dip to white', slide_left: 'Slide from right', slide_right: 'Slide from left' };

export function Inspector({
  projectId,
  state,
  clip,
  onChange,
  onTiming,
  onSplit,
  onDelete,
  onReplace,
  time,
}: {
  projectId: string;
  state: TimelineState;
  clip: Clip | null;
  onChange: (patch: Partial<Clip>, label: string) => void;
  onTiming: (patch: { start?: number; duration?: number; inPoint?: number }) => void;
  onSplit: () => void;
  onDelete: () => void;
  /** Swaps the clip's media while keeping its timing, trims, transitions and levels. */
  onReplace: () => void;
  time: number;
}) {
  if (!clip) {
    return (
      <div className="p-4 text-sm text-faint">
        <p className="eyebrow mb-2">Inspector</p>
        Select a clip to edit timing, transitions, audio and text. Drag media from the bin onto a track.
        <ul className="mt-4 space-y-1 text-xs">
          <li>
            <kbd className="text-dim">Space</kbd> play / pause
          </li>
          <li>
            <kbd className="text-dim">S</kbd> split at playhead
          </li>
          <li>
            <kbd className="text-dim">Delete</kbd> remove clip
          </li>
          <li>
            <kbd className="text-dim">Ctrl+Z</kbd> / <kbd className="text-dim">Ctrl+Shift+Z</kbd> undo / redo
          </li>
          <li>
            <kbd className="text-dim">← →</kbd> step one frame
          </li>
        </ul>
      </div>
    );
  }
  const track = state.tracks.find((t) => t.id === clip.trackId);
  const isText = clip.kind === 'caption' || clip.kind === 'title';
  const isVisual = clip.kind === 'video' || clip.kind === 'image' || clip.kind === 'title';
  const hasAudio = clip.kind === 'audio' || clip.kind === 'video';
  const style: TextStyle = clip.style ?? DEFAULT_TEXT_STYLE;
  const pos: TextPosition = clip.position ?? { anchor: 'bottom', offset: 0.08, align: 'center' };
  const canSplit = time > clip.start + 0.1 && time < clip.start + clip.duration - 0.1;
  return (
    <div className="space-y-5 p-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="eyebrow">{clip.kind} clip</p>
          <p className="truncate text-sm text-fg">{clip.label || clip.text || track?.name}</p>
        </div>
        <div className="flex gap-1">
          {(clip.kind === 'video' || clip.kind === 'image' || clip.kind === 'audio') && (
            <Button size="sm" variant="ghost" onClick={onReplace} icon={<Replace className="size-3.5" />}>
              Replace
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={!canSplit} onClick={onSplit} icon={<Scissors className="size-3.5" />}>
            Split
          </Button>
          <Button size="sm" variant="danger" onClick={onDelete} icon={<Trash2 className="size-3.5" />}>
            Delete
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label={`Start ${formatTimecode(clip.start)}`}>
          <Input type="number" step={0.1} min={0} value={Math.round(clip.start * 100) / 100} onChange={(e) => onTiming({ start: Number(e.target.value) })} />
        </Field>
        <Field label="Duration (s)">
          <Input type="number" step={0.1} min={0.1} value={Math.round(clip.duration * 100) / 100} onChange={(e) => onTiming({ duration: Number(e.target.value) })} />
        </Field>
        {(clip.kind === 'video' || clip.kind === 'audio') && (
          <Field label={`Source in-point${clip.sourceDuration ? ` (of ${clip.sourceDuration.toFixed(1)}s)` : ''}`}>
            <Input type="number" step={0.1} min={0} value={Math.round(clip.inPoint * 100) / 100} onChange={(e) => onTiming({ inPoint: Number(e.target.value) })} />
          </Field>
        )}
      </div>

      {isVisual && (
        <div className="space-y-3">
          <p className="eyebrow">Picture</p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Transition in">
              <Select value={clip.transitionIn.type} onChange={(e) => onChange({ transitionIn: { type: e.target.value as TransitionType, duration: e.target.value === 'cut' ? 0 : Math.max(0.3, clip.transitionIn.duration || 0.8) } }, 'Transition')}>
                {TRANSITION_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TRANSITION_LABEL[t]}
                  </option>
                ))}
              </Select>
            </Field>
            {clip.transitionIn.type !== 'cut' && (
              <Field label={`Length ${clip.transitionIn.duration.toFixed(1)}s`}>
                <Slider label="Transition length" min={0.1} max={Math.min(3, clip.duration)} step={0.1} value={clip.transitionIn.duration} onChange={(v) => onChange({ transitionIn: { ...clip.transitionIn, duration: v } }, 'Transition length')} />
              </Field>
            )}
            <Field label={`Fade in ${clip.fadeIn.toFixed(1)}s`}>
              <Slider label="Fade in" min={0} max={Math.min(5, clip.duration / 2)} step={0.1} value={clip.fadeIn} onChange={(v) => onChange({ fadeIn: v }, 'Fade in')} />
            </Field>
            <Field label={`Fade out ${clip.fadeOut.toFixed(1)}s`}>
              <Slider label="Fade out" min={0} max={Math.min(5, clip.duration / 2)} step={0.1} value={clip.fadeOut} onChange={(v) => onChange({ fadeOut: v }, 'Fade out')} />
            </Field>
          </div>
          {clip.kind !== 'title' && (
            <Field label="Fit to frame" hint="Used when the export aspect differs from the clip (e.g. square from 16:9).">
              <Segmented label="Fit" size="sm" value={clip.fit} onChange={(v: FitMode) => onChange({ fit: v }, 'Fit')} options={[{ value: 'smart', label: 'Smart (face-safe)' }, { value: 'fill', label: 'Fill (crop)' }, { value: 'fit', label: 'Fit (bars)' }, { value: 'blur', label: 'Blurred bg' }]} />
            </Field>
          )}
          {clip.kind === 'video' && (clip.fit === 'smart' || clip.fit === 'fill') && <ReframeEditor projectId={projectId} clip={clip} time={time} onChange={onChange} />}
          {clip.kind === 'image' && <Toggle checked={clip.kenBurns} onChange={(v) => onChange({ kenBurns: v }, 'Ken Burns')} label="Slow push-in (Ken Burns)" />}
        </div>
      )}

      {hasAudio && (
        <div className="space-y-3">
          <p className="eyebrow">Audio</p>
          {clip.kind === 'video' && <Toggle checked={clip.useSourceAudio} onChange={(v) => onChange({ useSourceAudio: v }, 'Clip audio')} label="Use the clip’s own audio" description="Omni clips include generated dialogue, music and effects." />}
          {(clip.kind === 'audio' || clip.useSourceAudio) && (
            <Field label={`Clip volume ${Math.round(clip.volume * 100)}%`}>
              <Slider label="Clip volume" min={0} max={2} step={0.05} value={clip.volume} onChange={(v) => onChange({ volume: v }, 'Volume')} />
            </Field>
          )}
          {clip.kind === 'audio' && (
            <div className="grid grid-cols-2 gap-3">
              <Field label={`Fade in ${clip.fadeIn.toFixed(1)}s`}>
                <Slider label="Audio fade in" min={0} max={Math.min(10, clip.duration / 2)} step={0.1} value={clip.fadeIn} onChange={(v) => onChange({ fadeIn: v }, 'Fade in')} />
              </Field>
              <Field label={`Fade out ${clip.fadeOut.toFixed(1)}s`}>
                <Slider label="Audio fade out" min={0} max={Math.min(10, clip.duration / 2)} step={0.1} value={clip.fadeOut} onChange={(v) => onChange({ fadeOut: v }, 'Fade out')} />
              </Field>
            </div>
          )}
          {clip.kind === 'audio' && (
            <Field label="Role in the mix">
              <Segmented label="Audio role" size="sm" value={clip.role ?? 'effects'} onChange={(v) => onChange({ role: v, duck: v === 'music' ? clip.duck ?? true : false }, 'Audio role')} options={[{ value: 'music', label: 'Music' }, { value: 'dialogue', label: 'Dialogue' }, { value: 'effects', label: 'Effects' }]} />
            </Field>
          )}
          {clip.kind === 'audio' && clip.role === 'music' && (
            <>
              <Toggle checked={Boolean(clip.duck)} onChange={(v) => onChange({ duck: v }, 'Ducking')} label="Duck under dialogue" description="Lowers automatically while dialogue and important effects play." />
              {clip.duck && (
                <Field label={`Duck depth ${clip.duckDb ?? 12} dB`}>
                  <Slider label="Duck depth" min={6} max={18} step={1} value={clip.duckDb ?? 12} onChange={(v) => onChange({ duckDb: v }, 'Duck depth')} />
                </Field>
              )}
              {clip.volumeAutomation?.length ? (
                <div className="flex items-center justify-between gap-2 text-[11px] text-faint">
                  <span>Volume automation: {clip.volumeAutomation.length} keyframes (from the score cue sheet)</span>
                  <Button size="sm" variant="ghost" onClick={() => onChange({ volumeAutomation: null }, 'Clear automation')}>
                    Clear
                  </Button>
                </div>
              ) : null}
            </>
          )}
          {clip.songId && <p className="text-[11px] text-faint">Song clip — lyric captions follow it when it is moved, trimmed or split.</p>}
          {clip.volume > 1 && <p className="text-[11px] text-faint">Gain above 100% is applied in the render; the preview plays at 100%.</p>}
        </div>
      )}

      {isText && (
        <div className="space-y-3">
          <p className="eyebrow">Text</p>
          {clip.lyric && <p className="text-[11px] text-faint">Lyric caption ({clip.lyric.mode}) — timing comes from the song’s lyric sheet. Correct the words on the Song tab, then Resync lyrics.</p>}
          <Textarea rows={3} value={clip.text} disabled={Boolean(clip.lyric)} onChange={(e) => onChange({ text: e.target.value }, 'Text')} aria-label="Text" />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Font">
              <Select value={style.font} onChange={(e) => onChange({ style: { ...style, font: e.target.value as TextStyle['font'] } }, 'Font')}>
                {TEXT_FONTS.map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </Select>
            </Field>
            <Field label={`Size ${style.sizePct}%`}>
              <Slider label="Text size" min={2} max={20} step={0.5} value={style.sizePct} onChange={(v) => onChange({ style: { ...style, sizePct: v } }, 'Text size')} />
            </Field>
            <Field label="Colour">
              <Input type="color" value={style.color} onChange={(e) => onChange({ style: { ...style, color: e.target.value } }, 'Text colour')} className="h-9 !p-1" />
            </Field>
            <Field label={clip.kind === 'title' ? 'Card background' : 'Caption box'}>
              <div className="flex items-center gap-2">
                <Input type="color" value={style.background ?? '#000000'} onChange={(e) => onChange({ style: { ...style, background: e.target.value } }, 'Background')} className="h-9 !p-1" disabled={!style.background} />
                <Toggle checked={Boolean(style.background)} onChange={(v) => onChange({ style: { ...style, background: v ? '#05070B' : null } }, 'Background')} label="" />
              </div>
            </Field>
          </div>
          <div className="flex flex-wrap gap-4">
            <Toggle checked={style.bold} onChange={(v) => onChange({ style: { ...style, bold: v } }, 'Bold')} label="Bold" />
            <Toggle checked={style.uppercase} onChange={(v) => onChange({ style: { ...style, uppercase: v } }, 'Uppercase')} label="Uppercase" />
            <Toggle checked={style.shadow} onChange={(v) => onChange({ style: { ...style, shadow: v } }, 'Shadow')} label="Shadow" />
          </div>
          <Field label={`Outline ${style.outline}px`}>
            <Slider label="Outline" min={0} max={8} step={1} value={style.outline} onChange={(v) => onChange({ style: { ...style, outline: v } }, 'Outline')} />
          </Field>
          <Field label="Position">
            <Segmented label="Vertical position" size="sm" value={pos.anchor} onChange={(v) => onChange({ position: { ...pos, anchor: v } }, 'Position')} options={[{ value: 'top', label: 'Top' }, { value: 'middle', label: 'Middle' }, { value: 'bottom', label: 'Bottom' }]} />
          </Field>
          <Field label="Alignment">
            <Segmented label="Alignment" size="sm" value={pos.align} onChange={(v) => onChange({ position: { ...pos, align: v } }, 'Alignment')} options={[{ value: 'left', label: 'Left' }, { value: 'center', label: 'Centre' }, { value: 'right', label: 'Right' }]} />
          </Field>
          {pos.anchor !== 'middle' && (
            <Field label={`Edge offset ${Math.round(pos.offset * 100)}%`}>
              <Slider label="Edge offset" min={0} max={0.4} step={0.01} value={pos.offset} onChange={(v) => onChange({ position: { ...pos, offset: v } }, 'Offset')} />
            </Field>
          )}
        </div>
      )}
    </div>
  );
}
