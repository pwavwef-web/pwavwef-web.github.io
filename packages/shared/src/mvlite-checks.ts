import { clipPreroll } from './lite-assemble';
import { motionInBounds } from './motion';
import { mvShotImageId, type MvLiteSpec, type MvSong, type MvStage } from './mvlite';
import { MV_TRACKS, type MvAssembly } from './mvlite-assemble';
import type { MvTiming } from './mvlite-timing';

/**
 * Music Video Lite checks before a final export. `deterministic` findings are measured facts about the
 * composition (missing media, gaps, exposed edges, lyrics out of sync, overlapping captions…); `heuristic`
 * findings are editorial suggestions (repetitive movement, monotonous cutting, long holds…). Every finding
 * links to the stage and section it concerns.
 */

export interface MvFinding {
  id: string;
  severity: 'error' | 'warning' | 'info';
  basis: 'deterministic' | 'heuristic' | 'model';
  kind: string;
  message: string;
  stage: MvStage;
  sectionId: string | null;
  shotId: string | null;
  at: number | null;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

function stageOf(kind: string): MvStage {
  if (kind.includes('song') || kind.includes('lyric') || kind === 'no_grid' || kind === 'font_substituted') return 'song';
  if (kind.includes('image') || kind.includes('asset')) return 'shots';
  return 'edit';
}

export function mvExportChecks(input: { spec: MvLiteSpec; timing: MvTiming; assembly: MvAssembly; song: MvSong | null }): MvFinding[] {
  const { spec, timing, assembly, song } = input;
  const out: MvFinding[] = [];
  let n = 0;
  const add = (f: Omit<MvFinding, 'id'>) => out.push({ ...f, id: `f${++n}` });

  for (const i of assembly.issues) add({ severity: i.severity, basis: 'deterministic', kind: i.kind, message: i.message, stage: stageOf(i.kind), sectionId: i.sectionId, shotId: i.shotId, at: i.at });
  if (song && !spec.sections.length) add({ severity: 'error', basis: 'deterministic', kind: 'empty', message: 'The video has no sections yet — plan the shots.', stage: 'shots', sectionId: null, shotId: null, at: null });

  // Lyric sheet quality (the captions are only as good as the synchronisation).
  const sheet = song?.sheet ?? null;
  if (song && sheet && spec.lyrics.enabled && !song.instrumental) {
    if (sheet.status !== 'approved') add({ severity: 'warning', basis: 'deterministic', kind: 'lyrics_unapproved', message: 'The lyrics have not been approved — read them through on the Song stage before the final export.', stage: 'song', sectionId: null, shotId: null, at: null });
    if (sheet.requiresLanguageVerification && !sheet.languageVerifiedAt) add({ severity: 'warning', basis: 'deterministic', kind: 'lyrics_language', message: `The lyrics are in ${sheet.languageName ?? 'a language'} AI handles poorly — a fluent speaker should verify them.`, stage: 'song', sectionId: null, shotId: null, at: null });
    const weak = sheet.lines.filter((l) => l.end !== null && l.start !== null && l.end > timing.songStart && l.start < timing.songEnd && (l.flags.includes('unaligned') || l.flags.includes('low_confidence') || l.flags.includes('no_vocal_match')));
    if (weak.length) add({ severity: 'warning', basis: 'deterministic', kind: 'lyrics_weak_timing', message: `${weak.length} lyric line(s) have uncertain timing (for example “${weak[0]!.text.slice(0, 50)}”) — listen and adjust them on the Song stage.`, stage: 'song', sectionId: null, shotId: null, at: weak[0]!.start !== null ? Math.max(0, weak[0]!.start - timing.songStart) : null });
    if (sheet.timing.status === 'approximate') add({ severity: 'warning', basis: 'deterministic', kind: 'lyrics_approximate', message: 'The lyric timing is approximate (not aligned to the vocals) — synchronise it before the final export.', stage: 'song', sectionId: null, shotId: null, at: null });
  }
  // Overlapping captions.
  const caps = [...assembly.captions].sort((a, b) => a.start - b.start);
  caps.forEach((c, i) => {
    const next = caps[i + 1];
    if (next && c.start + c.duration > next.start + 0.02) add({ severity: 'error', basis: 'deterministic', kind: 'lyrics_overlap', message: `The caption “${c.text.slice(0, 40)}” overlaps the next line.`, stage: 'song', sectionId: null, shotId: null, at: next.start });
  });

  const D = assembly.durationSec;
  const pic = assembly.state.clips.filter((c) => c.trackId === MV_TRACKS.picture).sort((a, b) => a.start - b.start);
  // Every instant from 0 to the end shows a picture (no accidental black).
  let cursor = 0;
  for (const c of pic) {
    const from = c.start - clipPreroll(c);
    if (from > cursor + 0.05) add({ severity: 'error', basis: 'deterministic', kind: 'gap', message: `No picture from ${r1(cursor)} s to ${r1(from)} s (accidental black).`, stage: 'edit', sectionId: null, shotId: null, at: cursor });
    cursor = Math.max(cursor, c.start + c.duration);
  }
  if (D > 0 && pic.length && cursor < D - 0.05) add({ severity: 'error', basis: 'deterministic', kind: 'gap', message: `No picture from ${r1(cursor)} s to the end (${r1(D)} s).`, stage: 'edit', sectionId: null, shotId: null, at: cursor });
  for (const c of pic) if (c.motion && !motionInBounds(c.motion)) add({ severity: 'error', basis: 'deterministic', kind: 'out_of_bounds', message: `${c.label}: the camera move would show beyond the image edge.`, stage: 'edit', sectionId: null, shotId: c.shotId, at: c.start });
  const lastPic = pic[pic.length - 1];
  if (lastPic && lastPic.fadeOut < 0.5) add({ severity: 'warning', basis: 'deterministic', kind: 'ending_abrupt', message: 'The final picture does not fade out.', stage: 'edit', sectionId: null, shotId: lastPic.shotId, at: D });

  // Cuts off the grid.
  const off = timing.sections.flatMap((s) => s.shots.filter((x) => !x.onGrid).map((x) => ({ s, x })));
  if (timing.gridded && off.length) add({ severity: 'info', basis: 'deterministic', kind: 'off_beat', message: `${off.length} cut(s) do not land on the ${spec.setup.cutOn === 'beat' ? 'beat' : 'bar line'} (the shots are too short to snap) — fewer shots or cut on any beat.`, stage: 'edit', sectionId: off[0]!.s.sectionId, shotId: off[0]!.x.shotId, at: off[0]!.x.start });

  return [...out, ...mvEditorialReview(spec, timing)];
}

/** Editorial suggestions from the plan itself (no model call). */
export function mvEditorialReview(spec: MvLiteSpec, timing: MvTiming): MvFinding[] {
  const out: MvFinding[] = [];
  let n = 0;
  const add = (f: Omit<MvFinding, 'id' | 'basis'>) => out.push({ ...f, basis: 'heuristic', id: `h${++n}` });
  const byId = new Map(spec.sections.map((s) => [s.id, s]));
  const flat = timing.sections.flatMap((st) => st.shots.map((t, k) => ({ section: byId.get(st.sectionId)!, shot: byId.get(st.sectionId)!.shots[k]!, t })));

  let run = 1;
  for (let i = 1; i < flat.length; i++) {
    run = flat[i]!.shot.motion.preset === flat[i - 1]!.shot.motion.preset ? run + 1 : 1;
    if (run === 5) add({ severity: 'info', kind: 'repeated_motion', message: `Five shots in a row use the same movement (${flat[i]!.shot.motion.preset.replace('_', ' ')}). Vary it, or hold one still.`, stage: 'edit', sectionId: flat[i]!.section.id, shotId: flat[i]!.shot.id, at: flat[i]!.t.start });
  }
  const lens = flat.map((f) => f.t.duration);
  if (lens.length >= 8) {
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
    const cv = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length) / Math.max(1e-6, mean);
    if (cv < 0.1) add({ severity: 'info', kind: 'monotonous_cutting', message: `Every shot lasts about ${mean.toFixed(1)} s. Cut faster in high-energy sections and let quiet ones breathe.`, stage: 'edit', sectionId: null, shotId: null, at: null });
  }
  for (const f of flat) if (f.t.duration > 16) add({ severity: 'info', kind: 'long_hold', message: `${f.section.name || f.section.label} holds one image for ${Math.round(f.t.duration)} s — consider another shot.`, stage: 'shots', sectionId: f.section.id, shotId: f.shot.id, at: f.t.start });
  const uses = new Map<string, number>();
  for (const f of flat) {
    const id = mvShotImageId(spec, f.shot);
    if (id) uses.set(id, (uses.get(id) ?? 0) + 1);
  }
  for (const [, count] of uses) if (count >= 4) add({ severity: 'info', kind: 'image_reuse', message: `One image appears in ${count} shots. Reuse works as a chorus callback; elsewhere a new image may serve the song better.`, stage: 'shots', sectionId: null, shotId: null, at: null });
  for (const c of spec.bible.characters) {
    const appears = flat.filter((f) => f.shot.characterIds.includes(c.id)).length;
    if (appears >= 2 && !c.refAssetIds.length) add({ severity: 'warning', kind: 'no_likeness', message: `${c.name} appears in ${appears} shots without a likeness reference — faces may differ between images. Add a reference image on the Concept stage.`, stage: 'concept', sectionId: null, shotId: null, at: null });
  }
  for (const f of flat) if (!f.shot.brief.trim() && !mvShotImageId(spec, f.shot)) add({ severity: 'info', kind: 'no_brief', message: `${f.section.name || f.section.label} has a shot without an image brief.`, stage: 'shots', sectionId: f.section.id, shotId: f.shot.id, at: f.t.start });
  return out;
}
