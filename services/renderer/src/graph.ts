import { ENCODE_SETTINGS, reframeCropExpressions, type Clip, type RenderQuality, type TextStyle, type Track } from '@az-studio/shared';

/**
 * Pure FFmpeg planning for AZ Studio renders. The timeline is rendered as a sequence of video-only
 * segments (bounded memory for long films), concatenated losslessly, then muxed with one
 * full-length audio mix.
 */

export interface RenderAssetInfo {
  kind: 'image' | 'video' | 'audio' | 'document';
  storagePath: string;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  hasAudio: boolean | null;
}

export interface RenderSnapshot {
  tracks: Track[];
  clips: Clip[];
  fps: number;
  width: number;
  height: number;
  durationSec: number;
  quality: RenderQuality;
  assets: Record<string, RenderAssetInfo>;
}

export interface Segment {
  index: number;
  start: number;
  end: number;
}

const VISUAL: Clip['kind'][] = ['video', 'image', 'title'];
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Quotes a file path for use as a filter option value. Filter arguments are unescaped twice
 * (graph level, then option level), so ':' is escaped for the option level and the whole value is
 * single-quoted for the graph level.
 */
export function filterPath(p: string): string {
  return `'${p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\''")}'`;
}

export function frameRound(t: number, fps: number): number {
  return Math.round(t * fps) / fps;
}

/** Seconds of lead-in a clip needs before its start for its incoming transition. */
export function preroll(c: Clip): number {
  const t = c.transitionIn;
  return t.type === 'dissolve' || t.type === 'slide_left' || t.type === 'slide_right' ? t.duration : 0;
}

/** Track stacking order: first video track is the bottom layer; overlays sit above picture. */
export function trackLayers(tracks: Track[]): Track[] {
  const order = { video: 0, overlay: 1, caption: 2, audio: 3 } as const;
  return tracks.filter((t) => t.kind === 'video' || t.kind === 'overlay').sort((a, b) => order[a.kind] - order[b.kind] || tracks.indexOf(a) - tracks.indexOf(b));
}

/** Splits the timeline into segments that never cut through a transition. */
export function planSegments(snap: Pick<RenderSnapshot, 'clips' | 'durationSec' | 'fps'>, maxSegmentSec = 90): Segment[] {
  const total = frameRound(snap.durationSec, snap.fps);
  if (total <= 0) return [];
  // Segment boundaries must not split transitions or fades (their alpha ramps would restart).
  const forbidden: [number, number][] = [];
  for (const c of snap.clips) {
    if (!VISUAL.includes(c.kind)) continue;
    if (c.transitionIn.type !== 'cut') forbidden.push([c.start - preroll(c) - c.transitionIn.duration - 0.05, c.start + c.transitionIn.duration + 0.05]);
    if (c.fadeIn > 0) forbidden.push([c.start - 0.05, c.start + c.fadeIn + 0.05]);
    if (c.fadeOut > 0) forbidden.push([c.start + c.duration - c.fadeOut - 0.05, c.start + c.duration + 0.05]);
  }
  const inForbidden = (t: number) => forbidden.some(([a, b]) => t > a && t < b);
  const candidates = [...new Set(snap.clips.flatMap((c) => [c.start, c.start + c.duration]).map((t) => frameRound(t, snap.fps)))]
    .filter((t) => t > 0 && t < total && !inForbidden(t))
    .sort((a, b) => a - b);
  const segs: Segment[] = [];
  let s = 0;
  while (s < total - 1e-6) {
    const limit = s + maxSegmentSec;
    if (limit >= total) {
      segs.push({ index: segs.length, start: s, end: total });
      break;
    }
    let b = [...candidates].reverse().find((t) => t > s + 1 && t <= limit);
    if (b === undefined) {
      b = frameRound(limit, snap.fps);
      while (inForbidden(b) && b < total) b = frameRound(b + 1 / snap.fps, snap.fps);
    }
    b = Math.min(total, b);
    segs.push({ index: segs.length, start: s, end: b });
    s = b;
  }
  return segs;
}

// ---------------------------------------------------------------------------
// ASS subtitles (captions + title text) rendered by libass
// ---------------------------------------------------------------------------

function assColor(hex: string, alpha = 0): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const rgb = m ? m[1]! : 'FFFFFF';
  const r = rgb.slice(0, 2);
  const g = rgb.slice(2, 4);
  const b = rgb.slice(4, 6);
  return `&H${alpha.toString(16).padStart(2, '0').toUpperCase()}${b}${g}${r}`.toUpperCase();
}

function assTime(t: number): string {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${(cs % 100).toString().padStart(2, '0')}`;
}

function assEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\r?\n/g, '\\N');
}

function alignment(pos: Clip['position']): number {
  const col = pos?.align === 'left' ? 0 : pos?.align === 'right' ? 2 : 1;
  const row = pos?.anchor === 'top' ? 7 : pos?.anchor === 'middle' ? 4 : 1;
  return row + col;
}

/**
 * Karaoke / phrase highlighting for a lyric caption: `\kf` sweeps each word as it is sung, `\k`
 * lights whole phrases. Units are relative to the caption start; the visible clip window is `from`
 * seconds into the caption (a segment may start mid-caption).
 */
export function karaokeText(units: { text: string; start: number; end: number }[], mode: 'sweep' | 'instant', uppercase: boolean): string {
  const tag = mode === 'sweep' ? 'kf' : 'k';
  let t = 0;
  let out = '';
  units.forEach((u, i) => {
    const gap = Math.round((u.start - t) * 100);
    if (gap > 0) out += `{\\k${gap}}`;
    const dur = Math.max(1, Math.round((Math.max(u.end, u.start + 0.01) - Math.max(u.start, t)) * 100));
    const word = assEscape(uppercase ? u.text.toUpperCase() : u.text);
    out += `{\\${tag}${dur}}${word}${i < units.length - 1 ? ' ' : ''}`;
    t = Math.max(u.end, u.start + dur / 100);
  });
  return out;
}

/** Builds the ASS script for all caption and title text visible in a segment (times relative to it). */
export function buildAss(snap: RenderSnapshot, seg: Segment, skip: ReadonlySet<string> = new Set()): string | null {
  const visible = new Set(snap.tracks.filter((t) => !t.muted).map((t) => t.id));
  const texts = snap.clips.filter((c) => (c.kind === 'caption' || c.kind === 'title') && c.text.trim() && visible.has(c.trackId) && !skip.has(c.id) && c.start < seg.end && c.start + c.duration > seg.start);
  if (!texts.length) return null;
  const W = snap.width;
  const H = snap.height;
  const portrait = H > W;
  const styles: string[] = [];
  const events: string[] = [];
  texts.forEach((c, i) => {
    const st: TextStyle = c.style ?? { font: 'Inter', sizePct: 5, color: '#FFFFFF', background: null, bold: true, italic: false, uppercase: false, outline: 2, shadow: true };
    // Lyrics in a vertical export sit higher (clear of platform UI) and wrap in a narrower column.
    const lyricPortrait = portrait && Boolean(c.lyric) && c.lyric?.mode !== 'vertical';
    const size = Math.max(8, Math.round((st.sizePct / 100) * H * (lyricPortrait ? 0.82 : 1)));
    const boxed = Boolean(st.background) && c.kind === 'caption';
    const outline = boxed ? Math.max(4, Math.round(size * 0.18)) : Math.round((st.outline * H) / 1080);
    const marginV = Math.round(Math.max(lyricPortrait ? 0.2 : 0, c.position?.offset ?? 0.06) * H);
    const marginH = Math.round(W * (portrait && c.lyric ? 0.08 : 0.06));
    const highlight = c.karaoke?.length && c.lyric && c.lyric.mode !== 'line' && c.lyric.mode !== 'subtitle' ? st.highlight ?? '#F4B84A' : null;
    styles.push(
      [
        `Style: s${i}`,
        st.font,
        size,
        // Karaoke: text is drawn in SecondaryColour until sung, then PrimaryColour (the highlight).
        assColor(highlight ?? st.color),
        assColor(st.color),
        boxed ? assColor(st.background ?? '#000000', 0x40) : assColor('#000000', 0x10),
        boxed ? assColor(st.background ?? '#000000', 0x40) : assColor('#000000', 0x80),
        st.bold ? -1 : 0,
        st.italic ? -1 : 0,
        0,
        0,
        100,
        100,
        0,
        0,
        boxed ? 3 : 1,
        outline,
        st.shadow && !boxed ? Math.max(1, Math.round(H / 540)) : 0,
        alignment(c.position),
        marginH,
        marginH,
        marginV,
        1,
      ].join(','),
    );
    const start = Math.max(0, c.start - seg.start);
    const end = Math.min(seg.end, c.start + c.duration) - seg.start;
    const fi = Math.round(Math.min(c.fadeIn, c.duration / 2) * 1000);
    const fo = Math.round(Math.min(c.fadeOut, c.duration / 2) * 1000);
    // When a segment starts mid-caption, shift the highlight timing so it stays on the vocals.
    const into = Math.max(0, seg.start - c.start);
    const units = highlight && c.karaoke ? c.karaoke.map((u) => ({ ...u, start: Math.max(0, u.start - into), end: Math.max(0, u.end - into) })) : null;
    const body = units ? karaokeText(units, c.lyric?.mode === 'phrase' ? 'instant' : 'sweep', st.uppercase) : assEscape(st.uppercase ? c.text.toUpperCase() : c.text);
    events.push(`Dialogue: ${c.kind === 'title' ? 1 : 0},${assTime(start)},${assTime(end)},s${i},,0,0,0,,${fi || fo ? `{\\fad(${fi},${fo})}` : ''}${body}`);
  });
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...styles,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Video segment graph
// ---------------------------------------------------------------------------

export interface SegmentPlan {
  args: string[];
  filter: string;
  ass: string | null;
}

export interface GraphContext {
  resolve: (assetId: string) => string;
  filterScriptPath: string;
  assPath: string;
  fontsDir: string;
  outputPath: string;
  /** Output aspect key (16:9, 9:16, 1:1, 4:5): picks each clip's face-safe reframe path. */
  aspect?: string;
  /** Styled lyrics and credits for this segment (ASS with absolute timeline times). */
  sceneAss?: string | null;
  sceneAssPath?: string;
  /** Clips drawn by the text engine (not by the caption renderer). */
  handledText?: ReadonlySet<string>;
  /** Background-blur regions behind text boxes (absolute seconds, output px). */
  blurs?: { x: number; y: number; w: number; h: number; radius: number; start: number; end: number }[];
}

/** Face-safe reframe: a time-varying crop following the clip's subject path, scaled to the frame. */
export function reframeChain(c: Clip, aspect: string | undefined, src: { w: number | null; h: number | null }, W: number, H: number, timeOffset: number, label: string, out: string): string | null {
  const track = aspect ? c.reframe?.[aspect] : null;
  if (!track || !track.keyframes.length || !src.w || !src.h) return null;
  const e = reframeCropExpressions(track.keyframes, src.w, src.h, track.crop, Math.round(timeOffset * 1000) / 1000);
  return `[${label}]crop=w=${e.w}:h=${e.h}:x='${e.x}':y='${e.y}',scale=${W}:${H},setsar=1,format=yuva420p[${out}]`;
}

function fitChain(fit: Clip['fit'], W: number, H: number, label: string, out: string): string {
  if (fit === 'fit') return `[${label}]scale=${W}:${H}:force_original_aspect_ratio=decrease,format=yuva420p,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black@0[${out}]`;
  if (fit === 'blur') {
    return (
      `[${label}]split=2[${out}bg][${out}fg];` +
      `[${out}bg]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=luma_radius=${Math.round(W / 40)}:luma_power=2[${out}b];` +
      `[${out}fg]scale=${W}:${H}:force_original_aspect_ratio=decrease[${out}f];` +
      `[${out}b][${out}f]overlay=(W-w)/2:(H-h)/2,format=yuva420p[${out}]`
    );
  }
  return `[${label}]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},format=yuva420p[${out}]`;
}

export function buildSegment(snap: RenderSnapshot, seg: Segment, ctx: GraphContext): SegmentPlan {
  const W = snap.width;
  const H = snap.height;
  const fps = snap.fps;
  const segDur = r3(seg.end - seg.start);
  const enc = ENCODE_SETTINGS[snap.quality];
  const args: string[] = ['-hide_banner', '-y', '-nostdin', '-progress', 'pipe:1', '-nostats'];
  const filters: string[] = [`color=c=black:s=${W}x${H}:r=${fps}:d=${segDur},format=yuva420p[base]`];
  let current = 'base';
  let inputIndex = 0;
  const hidden = new Set(snap.tracks.filter((t) => t.muted).map((t) => t.id));

  for (const track of trackLayers(snap.tracks)) {
    if (hidden.has(track.id)) continue;
    const clips = snap.clips.filter((c) => c.trackId === track.id && VISUAL.includes(c.kind)).sort((a, b) => a.start - b.start);
    clips.forEach((c, idx) => {
      const pre = preroll(c);
      const visStart = c.start - pre;
      const visEnd = c.start + c.duration;
      if (visEnd <= seg.start + 1e-6 || visStart >= seg.end - 1e-6) return;
      const localStart = Math.max(0, visStart - seg.start);
      const localEnd = Math.min(segDur, visEnd - seg.start);
      const span = r3(localEnd - localStart);
      if (span <= 0) return;
      const label = `v${inputIndex}`;
      const next = clips[idx + 1];
      const vs = r3(localStart);

      if (c.kind === 'title') {
        // Title card background (text itself is drawn by libass).
        if (!c.style?.background) return;
        filters.push(`color=c=${c.style.background.replace('#', '0x')}:s=${W}x${H}:r=${fps}:d=${span},format=yuva420p${fadeFilters(c, 0, localStart, seg, span)},setpts=PTS-STARTPTS+${vs}/TB[${label}]`);
      } else {
        const asset = c.assetId ? snap.assets[c.assetId] : undefined;
        if (!c.assetId || !asset) return;
        const file = ctx.resolve(c.assetId);
        let reframed: string | null = null;
        if (c.kind === 'video') {
          // Source time at the start of the visible window; freeze the first frame if the pre-roll needs handles.
          const srcAtVisible = c.inPoint + (seg.start + localStart - c.start);
          const seek = Math.max(0, srcAtVisible);
          const pad = Math.max(0, -srcAtVisible);
          args.push('-ss', String(r3(seek)), '-t', String(r3(span - pad + 0.1)), '-i', file);
          filters.push(`[${inputIndex}:v]fps=${fps},setsar=1${pad > 0 ? `,tpad=start_duration=${r3(pad)}:start_mode=clone` : ''}[${label}src]`);
          // Stream time t shows source time seek + t − pad, i.e. clip-local time t + (seek − pad − inPoint).
          reframed = reframeChain(c, ctx.aspect, { w: asset.width, h: asset.height }, W, H, seek - pad - c.inPoint, `${label}src`, `${label}fit`);
        } else {
          args.push('-loop', '1', '-framerate', String(fps), '-t', String(span), '-i', file);
          const frames = Math.max(1, Math.round(span * fps));
          const total = Math.max(1, Math.round((c.duration + pre) * fps));
          const offset = Math.round((seg.start + localStart - visStart) * fps);
          filters.push(
            c.kenBurns
              ? `[${inputIndex}:v]scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${W * 2}:${H * 2},zoompan=z='min(1+0.12*(on+${offset})/${total},1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${fps},trim=end_frame=${frames}[${label}src]`
              : `[${inputIndex}:v]fps=${fps},setsar=1[${label}src]`,
          );
        }
        filters.push(reframed ?? fitChain(c.kenBurns && c.kind === 'image' ? 'fill' : c.fit, W, H, `${label}src`, `${label}fit`));
        filters.push(`[${label}fit]trim=duration=${span},setpts=PTS-STARTPTS${fadeFilters(c, 0, localStart, seg, span, next)},setpts=PTS+${vs}/TB[${label}]`);
        inputIndex++;
      }
      const overlayX = slideX(c, vs);
      filters.push(`[${current}][${label}]overlay=x=${overlayX}:y=0:eof_action=pass:enable='between(t,${vs},${r3(localEnd)})'[o${label}]`);
      current = `o${label}`;

      // Dip-to-white flash centred on the cut.
      if (c.transitionIn.type === 'dip_white') {
        const d = c.transitionIn.duration;
        const cut = c.start - seg.start;
        const ws = r3(Math.max(0, cut - d / 2));
        filters.push(
          `color=c=white:s=${W}x${H}:r=${fps}:d=${r3(d)},format=yuva420p,fade=t=in:st=0:d=${r3(d / 2)}:alpha=1,fade=t=out:st=${r3(d / 2)}:d=${r3(d / 2)}:alpha=1,setpts=PTS-STARTPTS+${ws}/TB[w${label}]`,
        );
        filters.push(`[${current}][w${label}]overlay=eof_action=pass:enable='between(t,${ws},${r3(ws + d)})'[ow${label}]`);
        current = `ow${label}`;
      }
    });
  }

  (ctx.blurs ?? []).forEach((b, k) => {
    const x = Math.max(0, Math.round(b.x));
    const y = Math.max(0, Math.round(b.y));
    const w = Math.max(2, Math.min(W - x, Math.round(b.w)));
    const h = Math.max(2, Math.min(H - y, Math.round(b.h)));
    const radius = Math.max(1, Math.min(Math.floor(Math.min(w, h) / 2) - 1, Math.round(b.radius)));
    filters.push(`[${current}]split=2[bl${k}a][bl${k}b];[bl${k}b]crop=${w}:${h}:${x}:${y},boxblur=luma_radius=${radius}:luma_power=2:chroma_radius=${Math.max(1, Math.floor(radius / 2))}[bl${k}c];[bl${k}a][bl${k}c]overlay=${x}:${y}:enable='between(t,${r3(b.start - seg.start)},${r3(b.end - seg.start)})'[blo${k}]`);
    current = `blo${k}`;
  });
  const ass = buildAss(snap, seg, ctx.handledText);
  let final = current;
  if (ass) {
    filters.push(`[${current}]subtitles=filename=${filterPath(ctx.assPath)}:fontsdir=${filterPath(ctx.fontsDir)}[subs]`);
    final = 'subs';
  }
  if (ctx.sceneAss && ctx.sceneAssPath) {
    // Scene events carry absolute timeline times: shift the frames there for libass, then back.
    filters.push(`[${final}]setpts=PTS+${r3(seg.start)}/TB,subtitles=filename=${filterPath(ctx.sceneAssPath)}:fontsdir=${filterPath(ctx.fontsDir)},setpts=PTS-${r3(seg.start)}/TB[scene]`);
    final = 'scene';
  }
  filters.push(`[${final}]format=yuv420p,trim=duration=${segDur},setpts=PTS-STARTPTS[vout]`);
  const filter = filters.join(';\n');
  args.push(
    '-filter_complex_script',
    ctx.filterScriptPath,
    '-map',
    '[vout]',
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    enc.preset,
    '-crf',
    String(snap.quality === 'final' ? Math.max(10, enc.crf - 4) : enc.crf - 2),
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(fps),
    '-g',
    String(fps * 2),
    '-t',
    String(segDur),
    ctx.outputPath,
  );
  return { args, filter, ass };
}

export { fitChain };

/** Alpha fades for fade in/out and the incoming/outgoing halves of transitions (times in clip-local stream time). */
function fadeFilters(c: Clip, visLocal: number, localStart: number, seg: Segment, span: number, next?: Clip): string {
  const parts: string[] = [];
  const clipStartLocal = c.start - seg.start - localStart + visLocal; // stream time where the clip proper starts
  const clipEndLocal = c.start + c.duration - seg.start - localStart + visLocal;
  const t = c.transitionIn;
  if (t.type === 'dissolve') parts.push(`fade=t=in:st=${r3(clipStartLocal - t.duration)}:d=${r3(t.duration)}:alpha=1`);
  if (t.type === 'dip_black') parts.push(`fade=t=in:st=${r3(clipStartLocal)}:d=${r3(t.duration / 2)}:alpha=1`);
  if (c.fadeIn > 0) parts.push(`fade=t=in:st=${r3(clipStartLocal)}:d=${r3(c.fadeIn)}:alpha=1`);
  const outD = next && next.transitionIn.type === 'dip_black' && Math.abs(next.start - (c.start + c.duration)) < 0.05 ? next.transitionIn.duration / 2 : 0;
  if (outD > 0) parts.push(`fade=t=out:st=${r3(clipEndLocal - outD)}:d=${r3(outD)}:alpha=1`);
  if (c.fadeOut > 0) parts.push(`fade=t=out:st=${r3(clipEndLocal - c.fadeOut)}:d=${r3(c.fadeOut)}:alpha=1`);
  // Keep only fades that intersect the rendered span.
  const keep = parts.filter((p) => {
    const st = Number(/st=([-\d.]+)/.exec(p)?.[1] ?? 0);
    const d = Number(/d=([\d.]+)/.exec(p)?.[1] ?? 0);
    return st + d > 0 && st < span;
  });
  return keep.length ? `,${keep.join(',')}` : '';
}

function slideX(c: Clip, vs: number): string {
  const t = c.transitionIn;
  if (t.type !== 'slide_left' && t.type !== 'slide_right') return '0';
  const d = r3(t.duration);
  const sign = t.type === 'slide_left' ? '' : '-';
  return `'if(lt(t,${r3(vs + d)}),${sign}main_w*(1-(t-${vs})/${d}),0)'`;
}

// ---------------------------------------------------------------------------
// Audio mix
// ---------------------------------------------------------------------------

/**
 * FFmpeg expression for piecewise-linear gain keyframes (clip-local `t`), multiplied by `gain`.
 * Values are held before the first and after the last keyframe.
 */
export function automationExpr(points: { t: number; gain: number }[], gain: number): string {
  const pts = [...points].filter((p) => Number.isFinite(p.t) && Number.isFinite(p.gain)).sort((a, b) => a.t - b.t);
  if (!pts.length) return String(gain);
  let expr = String(r3(pts[pts.length - 1]!.gain));
  for (let k = pts.length - 1; k > 0; k--) {
    const a = pts[k - 1]!;
    const b = pts[k]!;
    const seg = b.t - a.t < 1e-3 ? String(r3(b.gain)) : `${r3(a.gain)}+(${r3(b.gain - a.gain)})*(t-${r3(a.t)})/${r3(b.t - a.t)}`;
    expr = `if(lt(t,${r3(b.t)}),${seg},${expr})`;
  }
  expr = `if(lt(t,${r3(pts[0]!.t)}),${r3(pts[0]!.gain)},${expr})`;
  return `${r3(gain)}*(${expr})`;
}

type Bus = 'dialogue' | 'music' | 'other';

/** Which mix bus a clip feeds: Omni's production sound and dialogue drive the ducking of music. */
function busOf(c: Clip): Bus {
  if (c.kind === 'video' || c.role === 'dialogue') return 'dialogue';
  if (c.duck || c.role === 'music') return 'music';
  return 'other';
}

/** Sidechain ratio for a target reduction under dialogue (dB). */
export function duckRatio(db: number): number {
  return Math.max(2, Math.min(20, Math.round((db <= 6 ? 3 : db <= 12 ? 3 + ((db - 6) / 6) * 5 : 8 + ((db - 12) / 6) * 8) * 10) / 10));
}

export function buildAudioMix(snap: RenderSnapshot, resolve: (assetId: string) => string, output: string, filterScriptPath: string): { args: string[]; filter: string } {
  const enc = ENCODE_SETTINGS[snap.quality];
  const tracks = new Map(snap.tracks.map((t) => [t.id, t]));
  const args: string[] = ['-hide_banner', '-y', '-nostdin', '-progress', 'pipe:1', '-nostats'];
  const filters: string[] = [];
  const buses: Record<Bus, string[]> = { dialogue: [], music: [], other: [] };
  let duckDb = 0;
  let i = 0;
  for (const c of snap.clips) {
    const track = tracks.get(c.trackId);
    if (!track || track.muted || !c.assetId) continue;
    const asset = snap.assets[c.assetId];
    if (!asset) continue;
    const isAudio = c.kind === 'audio';
    const isVideoWithSound = c.kind === 'video' && c.useSourceAudio && asset.hasAudio;
    if (!isAudio && !isVideoWithSound) continue;
    const gain = r3(c.volume * (track.kind === 'audio' ? track.volume : 1));
    if (gain <= 0) continue;
    args.push('-ss', String(r3(c.inPoint)), '-t', String(r3(c.duration)), '-i', resolve(c.assetId));
    const fi = Math.max(0.02, c.fadeIn);
    const fo = Math.max(0.02, c.fadeOut);
    const delay = Math.round(c.start * 1000);
    const bus = busOf(c);
    // Music crossfades use an equal-power curve so the level never dips between movements.
    const curve = bus === 'music' ? ':curve=qsin' : '';
    const volume = c.volumeAutomation?.length ? `volume='${automationExpr(c.volumeAutomation, gain)}':eval=frame` : `volume=${gain}`;
    filters.push(
      `[${i}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=duration=${r3(c.duration)},asetpts=PTS-STARTPTS,${volume},afade=t=in:st=0:d=${r3(fi)}${curve},afade=t=out:st=${r3(Math.max(0, c.duration - fo))}:d=${r3(fo)}${curve},adelay=${delay}:all=1[a${i}]`,
    );
    buses[bus].push(`[a${i}]`);
    if (bus === 'music' && c.duck) duckDb = Math.max(duckDb, c.duckDb ?? 12);
    i++;
  }
  const D = r3(snap.durationSec);
  const all = [...buses.dialogue, ...buses.music, ...buses.other];
  const master = snap.quality === 'final' ? 'loudnorm=I=-14:TP=-1.5:LRA=11' : 'alimiter=limit=0.95';
  const tail = `apad,atrim=duration=${D},${master},aresample=48000[aout]`;
  if (!all.length) {
    args.push('-f', 'lavfi', '-t', String(D), '-i', 'anullsrc=r=48000:cl=stereo');
    filters.push(`[0:a]atrim=duration=${D}[aout]`);
  } else if (duckDb > 0 && buses.dialogue.length && buses.music.length) {
    // Automatic ducking: the score is compressed by the dialogue/production-sound bus, so it drops under
    // speech and important effects and rises again in the gaps.
    const mix = (labels: string[], out: string) => (labels.length === 1 ? `${labels[0]}anull[${out}]` : `${labels.join('')}amix=inputs=${labels.length}:normalize=0:dropout_transition=0[${out}]`);
    filters.push(mix(buses.dialogue, 'dlg'));
    filters.push(mix(buses.music, 'mus'));
    // sidechaincompress stops when its key input ends: pad the dialogue key to the full length so the
    // score keeps playing after the last line.
    filters.push('[dlg]asplit=2[dlgmix][dlgkey]');
    filters.push(`[dlgkey]apad=whole_dur=${D}[dlgsc]`);
    filters.push(`[mus][dlgsc]sidechaincompress=threshold=0.02:ratio=${duckRatio(duckDb)}:attack=20:release=450:knee=3:makeup=1[ducked]`);
    const rest = ['[dlgmix]', '[ducked]', ...buses.other];
    filters.push(`${rest.join('')}amix=inputs=${rest.length}:normalize=0:dropout_transition=0,${tail}`);
  } else {
    filters.push(`${all.join('')}amix=inputs=${all.length}:normalize=0:dropout_transition=0,${tail}`);
  }
  args.push('-filter_complex_script', filterScriptPath, '-map', '[aout]', '-c:a', 'aac', '-b:a', enc.audioBitrate, '-ar', '48000', '-t', String(D), output);
  return { args, filter: filters.join(';\n') };
}

export function concatList(files: string[]): string {
  return files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n') + '\n';
}

export function muxArgs(video: string, audio: string, output: string, durationSec: number, metadata: Record<string, string>): string[] {
  const meta = Object.entries(metadata).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]);
  return ['-hide_banner', '-y', '-nostdin', '-i', video, '-i', audio, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'copy', '-t', String(r3(durationSec)), '-movflags', '+faststart', ...meta, output];
}
