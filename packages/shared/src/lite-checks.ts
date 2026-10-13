import { shotImageId, type LiteSpec, type LiteStage } from './lite';
import { clipPreroll, type LiteAssembly } from './lite-assemble';
import { cueProblems } from './lite-subtitles';
import type { LiteTiming } from './lite-timing';
import { motionInBounds } from './motion';

/**
 * Film Studio Lite checks before a final export. `deterministic` findings are measured facts about the
 * composition (missing media, gaps, exposed edges, cut-off narration, overlapping subtitles…);
 * `heuristic` findings are editorial suggestions (repetitive movement, monotonous pacing…); `model`
 * findings come from an optional, billable review. Every finding links to the scene it concerns.
 */

export interface LiteFinding {
  id: string;
  severity: 'error' | 'warning' | 'info';
  basis: 'deterministic' | 'heuristic' | 'model';
  kind: string;
  message: string;
  stage: LiteStage;
  sceneId: string | null;
  shotId: string | null;
  at: number | null;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export interface LiteCheckInput {
  spec: LiteSpec;
  timing: LiteTiming;
  assembly: LiteAssembly;
  /** Scenes whose narration take was made from different text or voice settings. */
  staleNarration: string[];
  /** Mean luminance (0–1) of the subtitle band of each image, when measured in the browser. */
  captionBandLuma?: Record<string, number>;
}

export function liteExportChecks(input: LiteCheckInput): LiteFinding[] {
  const { spec, timing, assembly } = input;
  const out: LiteFinding[] = [];
  let n = 0;
  const add = (f: Omit<LiteFinding, 'id'>) => out.push({ ...f, id: `f${++n}` });
  const stageOf = (kind: string): LiteStage => (kind.startsWith('motion') || kind === 'timeline' || kind === 'no_shots' ? 'edit' : kind.includes('image') || kind.includes('asset') ? 'scenes' : kind.includes('narration') || kind.includes('music') || kind.includes('ambience') || kind.includes('cue') || kind.includes('subtitle') || kind.includes('font') ? 'sound' : 'edit');

  for (const i of assembly.issues) add({ severity: i.severity, basis: 'deterministic', kind: i.kind, message: i.message, stage: stageOf(i.kind), sceneId: i.sceneId, shotId: i.shotId, at: i.at });
  if (!spec.scenes.length) add({ severity: 'error', basis: 'deterministic', kind: 'empty', message: 'The film has no scenes yet.', stage: 'scenes', sceneId: null, shotId: null, at: null });
  for (const id of input.staleNarration) {
    const s = spec.scenes.find((x) => x.id === id);
    add({ severity: 'error', basis: 'deterministic', kind: 'narration_stale', message: `The narration of ${s?.title || 'a scene'} was recorded before its text or voice changed. Re-voice it (or choose the take deliberately).`, stage: 'sound', sceneId: id, shotId: null, at: null });
  }

  const D = assembly.durationSec;
  const pic = assembly.state.clips.filter((c) => c.trackId === 'lt_pic').sort((a, b) => a.start - b.start);
  // Uncovered picture (unmarked black): every instant from 0 to the end is a picture or deliberate black.
  let cursor = 0;
  for (const c of pic) {
    const from = c.start - clipPreroll(c);
    if (from > cursor + 0.05) add({ severity: 'error', basis: 'deterministic', kind: 'gap', message: `No picture from ${r1(cursor)} s to ${r1(from)} s (accidental black).`, stage: 'edit', sceneId: timing.scenes.find((s) => from >= s.blackStart - 0.05 && from <= s.start + s.duration)?.sceneId ?? null, shotId: null, at: cursor });
    cursor = Math.max(cursor, c.start + c.duration);
  }
  if (D > 0 && cursor < D - 0.05) add({ severity: 'error', basis: 'deterministic', kind: 'gap', message: `No picture from ${r1(cursor)} s to the end (${r1(D)} s).`, stage: 'edit', sceneId: timing.scenes[timing.scenes.length - 1]?.sceneId ?? null, shotId: null, at: cursor });

  for (const c of pic) {
    if (c.motion && !motionInBounds(c.motion)) add({ severity: 'error', basis: 'deterministic', kind: 'out_of_bounds', message: `${c.label}: the camera move would show beyond the image edge.`, stage: 'edit', sceneId: null, shotId: c.shotId, at: c.start });
    if (c.duration < 1.2 && !c.intentional) add({ severity: 'warning', basis: 'deterministic', kind: 'short_shot', message: `${c.label} lasts only ${r1(c.duration)} s.`, stage: 'edit', sceneId: null, shotId: c.shotId, at: c.start });
  }

  // Narration: never cut off, never overlapping.
  const voice = assembly.state.clips.filter((c) => c.trackId === 'lt_voice').sort((a, b) => a.start - b.start);
  voice.forEach((c, i) => {
    const next = voice[i + 1];
    if (c.start + c.duration > D + 0.01) add({ severity: 'error', basis: 'deterministic', kind: 'narration_cut', message: `${c.label} runs past the end of the film.`, stage: 'edit', sceneId: c.id.replace(/^lv_/, ''), shotId: null, at: c.start });
    if (next && c.start + c.duration > next.start + 0.01) add({ severity: 'error', basis: 'deterministic', kind: 'narration_overlap', message: `${c.label} overlaps the next line.`, stage: 'edit', sceneId: c.id.replace(/^lv_/, ''), shotId: null, at: next.start });
  });
  for (const st of timing.scenes) {
    if (st.overrunSec > 0.5) add({ severity: 'warning', basis: 'deterministic', kind: 'locked_overrun', message: `${spec.scenes[st.index]!.title || `Scene ${st.index + 1}`}: the narration needs ${r1(st.overrunSec)} s more than the locked shots, so the last shot holds longer.`, stage: 'edit', sceneId: st.sceneId, shotId: null, at: st.start });
  }

  // Ending: room after the last line and a resolved, fading end.
  const lastVoice = voice[voice.length - 1];
  if (lastVoice) {
    const after = D - (lastVoice.start + lastVoice.duration);
    if (after < 2) add({ severity: 'warning', basis: 'deterministic', kind: 'ending_short', message: `Only ${r1(after)} s remain after the last line — the ending may feel cut off (increase the closing hold).`, stage: 'edit', sceneId: timing.scenes[timing.scenes.length - 1]?.sceneId ?? null, shotId: null, at: lastVoice.start + lastVoice.duration });
  }
  const lastPic = pic[pic.length - 1];
  if (lastPic && lastPic.fadeOut < 0.5) add({ severity: 'warning', basis: 'deterministic', kind: 'ending_abrupt', message: 'The final picture does not fade out.', stage: 'edit', sceneId: null, shotId: lastPic.shotId, at: D });
  const musicAtEnd = assembly.state.clips.filter((c) => c.role === 'music' && Math.abs(c.start + c.duration - D) < 0.06);
  if (spec.sound.music.mode !== 'none' && musicAtEnd.some((c) => c.fadeOut < 1.5)) add({ severity: 'warning', basis: 'deterministic', kind: 'music_abrupt', message: 'The music stops at the end without a fade.', stage: 'sound', sceneId: null, shotId: null, at: D });

  // Levels: speech above everything (clipping is measured on the final render).
  if (spec.sound.levels.voiceDb > 3) add({ severity: 'warning', basis: 'deterministic', kind: 'voice_hot', message: 'The narration level is above +3 dB and may clip before loudness normalisation.', stage: 'sound', sceneId: null, shotId: null, at: null });
  if (spec.sound.levels.musicDb - spec.sound.duck.depthDb > spec.sound.levels.voiceDb - 10) add({ severity: 'warning', basis: 'deterministic', kind: 'music_masks_voice', message: 'Under narration the music sits less than 10 dB below the voice; lower the music or duck it further so every word stays clear.', stage: 'sound', sceneId: null, shotId: null, at: null });

  // Subtitles.
  if (spec.subtitles.enabled) for (const p of cueProblems(assembly.cues)) add({ severity: p.kind === 'overlap' ? 'error' : 'warning', basis: 'deterministic', kind: `subtitle_${p.kind}`, message: p.message, stage: 'sound', sceneId: p.sceneId, shotId: null, at: assembly.cues[p.index]?.start ?? null });
  if (spec.subtitles.enabled && spec.subtitles.contrast === 'shadow' && input.captionBandLuma) {
    for (const c of pic) {
      const l = c.assetId ? input.captionBandLuma[c.assetId] : undefined;
      const hasCue = assembly.cues.some((q) => q.start < c.start + c.duration && q.end > c.start);
      if (l !== undefined && l > 0.72 && hasCue) add({ severity: 'warning', basis: 'heuristic', kind: 'subtitle_contrast', message: `${c.label}: the bottom of this image is very bright, so white subtitles may be hard to read — use the outline or box style.`, stage: 'sound', sceneId: null, shotId: c.shotId, at: c.start });
    }
  }
  return [...out, ...liteContinuityReview(spec, timing)];
}

/** Editorial suggestions from the plan itself (no model call). */
export function liteContinuityReview(spec: LiteSpec, timing: LiteTiming): LiteFinding[] {
  const out: LiteFinding[] = [];
  let n = 0;
  const add = (f: Omit<LiteFinding, 'id' | 'basis'>) => out.push({ ...f, basis: 'heuristic', id: `h${++n}` });
  const flat = spec.scenes.flatMap((scene, si) => scene.shots.map((shot, k) => ({ scene, shot, t: timing.scenes[si]?.shots[k] })));

  // Same camera movement many times in a row.
  let run = 1;
  for (let i = 1; i < flat.length; i++) {
    const same = flat[i]!.shot.motion.preset === flat[i - 1]!.shot.motion.preset;
    run = same ? run + 1 : 1;
    if (run === 4) add({ severity: 'info', kind: 'repeated_motion', message: `Four shots in a row use the same movement (${flat[i]!.shot.motion.preset.replace('_', ' ')}). Vary it, or hold one still.`, stage: 'edit', sceneId: flat[i]!.scene.id, shotId: flat[i]!.shot.id, at: flat[i]!.t?.start ?? null });
  }
  const moving = flat.filter((f) => f.shot.motion.preset !== 'still').length;
  if (flat.length >= 6 && moving === flat.length) add({ severity: 'info', kind: 'no_stillness', message: 'Every shot moves. A few still holds give emotional lines and reveals room to land.', stage: 'edit', sceneId: null, shotId: null, at: null });

  // Monotonous pacing: nearly identical shot lengths.
  const lens = flat.map((f) => f.t?.duration ?? f.shot.durationSec);
  if (lens.length >= 6) {
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
    const cv = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length) / Math.max(1e-6, mean);
    if (cv < 0.12) add({ severity: 'info', kind: 'monotonous_pacing', message: `Shot lengths barely vary (about ${mean.toFixed(1)} s each). Let some images breathe longer and cut others sooner.`, stage: 'edit', sceneId: null, shotId: null, at: null });
  }
  // One unrelated image held for too long.
  for (const f of flat) if ((f.t?.duration ?? 0) > 28) add({ severity: 'info', kind: 'long_hold', message: `${f.scene.title || 'A scene'} holds one image for ${Math.round(f.t!.duration)} s — consider another visual beat.`, stage: 'scenes', sceneId: f.scene.id, shotId: f.shot.id, at: f.t!.start });

  // Image reuse padding the film.
  const uses = new Map<string, number>();
  for (const f of flat) {
    const id = shotImageId(spec, f.shot);
    if (id) uses.set(id, (uses.get(id) ?? 0) + 1);
  }
  for (const [, count] of uses) if (count >= 3) add({ severity: 'info', kind: 'image_reuse', message: `One image appears in ${count} shots. Reframing works sparingly; a new image may serve the story better.`, stage: 'scenes', sceneId: null, shotId: null, at: null });

  // Same character without likeness references (continuity relies on text alone).
  for (const c of spec.bible.characters) {
    const appears = flat.filter((f) => f.shot.characterIds.includes(c.id)).length;
    if (appears >= 2 && !c.refAssetIds.length) add({ severity: 'warning', kind: 'no_likeness', message: `${c.name} appears in ${appears} shots without a likeness reference — faces may differ between images. Approve a reference image in the visual bible.`, stage: 'story', sceneId: null, shotId: null, at: null });
  }
  // Dissolve between every scene.
  const sceneDissolves = spec.scenes.slice(1).filter((s) => s.transitionIn === 'dissolve').length;
  if (spec.scenes.length >= 5 && sceneDissolves === spec.scenes.length - 1) add({ severity: 'info', kind: 'dissolve_everywhere', message: 'Every scene change dissolves. Keep dissolves for passages of time or mood; cut elsewhere.', stage: 'edit', sceneId: null, shotId: null, at: null });
  // Shots with no brief or image direction.
  for (const f of flat) if (!f.shot.brief.trim() && !shotImageId(spec, f.shot)) add({ severity: 'info', kind: 'no_brief', message: `${f.scene.title || 'A scene'} has a shot without an image brief.`, stage: 'scenes', sceneId: f.scene.id, shotId: f.shot.id, at: f.t?.start ?? null });
  return out;
}
