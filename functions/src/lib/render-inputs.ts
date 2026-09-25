import {
  aspectValue,
  computeReframe,
  EXPORT_PRESETS,
  type AssetDoc,
  type Box,
  type Clip,
  type CreditSequenceDoc,
  type ExportPreset,
  type LyricStyleDoc,
  type RenderTextInputs,
  type SectionLabel,
  type SongDoc,
  type SubjectSample,
  type TimelineDoc,
} from '@az-studio/shared';
import { col, db } from './firebase';

interface SubjectTrack {
  samples: { t: number; faces: { box: Box; confidence: number }[]; people: { box: Box; score: number }[] }[];
}

const clipEnd = (c: Clip) => c.start + c.duration;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const round = (b: Box): Box => ({ x: r3(b.x), y: r3(b.y), w: r3(b.w), h: r3(b.h) });

/**
 * Resolves what the renderer needs beyond the timeline: lyric styles and locked placements, sections
 * and translations of lyric lines, credit sequences, uploaded fonts, face tracks for lyric placement,
 * and face-safe reframe paths for clips whose shape differs from the export's.
 */
export async function renderInputs(uid: string, projectId: string, tl: Pick<TimelineDoc, 'clips' | 'tracks'>, preset: ExportPreset['id'], assets: Map<string, AssetDoc>): Promise<{ text: RenderTextInputs; clips: Clip[]; notes: string[] }> {
  const aspect = EXPORT_PRESETS[preset].aspect;
  const pref = col.projects().doc(projectId);
  const notes: string[] = [];
  const text: RenderTextInputs = { aspect, lyricStyles: {}, sections: {}, translations: {}, credits: {}, fonts: [], faces: {} };
  const fontAssets = new Map<string, string>();

  // Lyric styles by song (a song without a style keeps the simple caption style of its clips).
  const songIds = [...new Set(tl.clips.map((c) => c.lyric?.songId).filter((x): x is string => Boolean(x)))];
  for (const songId of songIds) {
    const [trackSnap, songSnap] = await Promise.all([pref.collection('lyricsTracks').where('songId', '==', songId).limit(1).get(), col.songs(projectId).doc(songId).get()]);
    const song = songSnap.data() as SongDoc | undefined;
    const sheet = song?.lyricsSheet;
    if (sheet) {
      const sectionOf = new Map(sheet.sections.map((s) => [s.id, s.label as SectionLabel]));
      text.sections[songId] = Object.fromEntries(sheet.lines.map((l) => [l.id, l.sectionId ? sectionOf.get(l.sectionId) ?? null : null]));
      const tr = sheet.lines.filter((l) => l.translation?.trim());
      if (tr.length) text.translations[songId] = Object.fromEntries(tr.map((l) => [l.id, l.translation!.trim()]));
    }
    const track = trackSnap.docs[0]?.data() as { styleId?: string | null; placements?: Partial<Record<string, Record<string, { x: number; y: number; locked: boolean }>>> } | undefined;
    if (!track?.styleId) continue;
    const styleSnap = await pref.collection('lyricStyles').doc(track.styleId).get();
    if (!styleSnap.exists) {
      notes.push('A lyric style used by this song no longer exists; its lines use the caption style.');
      continue;
    }
    const style = styleSnap.data() as LyricStyleDoc;
    text.lyricStyles[songId] = { style: { global: style.global, sections: style.sections ?? {}, fonts: style.fonts ?? [] }, placements: track.placements?.[aspect] ?? {} };
    for (const f of style.fonts ?? []) {
      if (!f.licenceConfirmed) {
        notes.push(`The font “${f.family}” is not used: its licence has not been confirmed.`);
        continue;
      }
      fontAssets.set(f.family, f.assetId);
    }
  }

  // Credit sequences.
  const seqIds = [...new Set(tl.clips.map((c) => c.credits?.sequenceId).filter((x): x is string => Boolean(x)))];
  if (seqIds.length) {
    const snaps = await db.getAll(...seqIds.map((id) => pref.collection('creditSequences').doc(id)));
    for (const s of snaps) if (s.exists) text.credits[s.id] = { ...(s.data() as CreditSequenceDoc), id: s.id };
  }

  // Uploaded fonts (owned, ready files only).
  if (fontAssets.size) {
    const snaps = await db.getAll(...[...fontAssets.values()].map((id) => col.assets().doc(id)));
    for (const [family, id] of fontAssets) {
      const a = snaps.find((s) => s.id === id);
      if (!a?.exists || a.get('ownerUid') !== uid || a.get('status') !== 'ready' || !/\.(ttf|otf)$/i.test(String(a.get('fileName') ?? ''))) {
        notes.push(`The font “${family}” is not available (upload a .ttf or .otf file).`);
        continue;
      }
      text.fonts.push({ family, storagePath: String(a.get('storagePath')) });
    }
  }

  // Face tracks of the picture (for lyric placement and reframing).
  const pictureIds = [...new Set(tl.clips.filter((c) => (c.kind === 'video' || c.kind === 'image') && c.assetId).map((c) => c.assetId!))];
  const tracks = new Map<string, SubjectTrack>();
  if (pictureIds.length) {
    const snaps = await db.getAll(...pictureIds.map((id) => pref.collection('subjectTracks').doc(id)));
    for (const s of snaps) if (s.exists) tracks.set(s.id, s.data() as SubjectTrack);
  }
  const lyricSpans = tl.clips.filter((c) => c.lyric).map((c) => ({ start: c.start, end: clipEnd(c) }));
  for (const c of tl.clips) {
    if (!c.assetId || !tracks.has(c.assetId) || (c.kind !== 'video' && c.kind !== 'image')) continue;
    if (!lyricSpans.some((l) => l.start < clipEnd(c) && l.end > c.start)) continue;
    const from = c.inPoint;
    const to = c.inPoint + c.duration;
    const kept = tracks.get(c.assetId)!.samples.filter((s) => s.t >= from - 1 && s.t <= to + 1).map((s) => ({ t: r3(s.t), boxes: s.faces.filter((f) => f.confidence >= 0.5).map((f) => round(f.box)) })).filter((s) => s.boxes.length);
    text.faces[c.assetId] = [...(text.faces[c.assetId] ?? []), ...kept].filter((s, i, all) => all.findIndex((x) => x.t === s.t) === i).slice(0, 400);
  }

  // Face-safe reframing: clips whose shape differs from the export follow their subjects.
  const dst = aspectValue(aspect);
  let missing = 0;
  const clips = tl.clips.map((c) => {
    if (c.kind !== 'video' || !c.assetId || c.reframe?.[aspect]?.keyframes?.length) return c;
    if (c.fit !== 'fill' && c.fit !== 'smart') return c;
    const a = assets.get(c.assetId);
    if (!a?.width || !a.height) return c;
    const src = a.width / a.height;
    if (Math.abs(src - dst) / dst < 0.02) return c;
    const track = tracks.get(c.assetId);
    if (!track) {
      missing++;
      return c;
    }
    const samples: SubjectSample[] = track.samples
      .filter((s) => s.t >= c.inPoint - 0.5 && s.t <= c.inPoint + c.duration + 0.5)
      .map((s) => ({ t: r3(s.t - c.inPoint), subjects: [...s.faces.filter((f) => f.confidence >= 0.5).map((f) => ({ box: f.box, kind: 'face' as const })), ...s.people.filter((p) => p.score >= 0.5).map((p) => ({ box: p.box, kind: 'person' as const }))] }));
    const path = computeReframe(samples, src, dst);
    if (path.cutHeads.length) notes.push(`“${c.label || a.title}”: a face cannot stay whole in the ${aspect} frame at ${path.cutHeads.slice(0, 3).map((t) => `${t.toFixed(1)} s`).join(', ')} (two people too far apart) — consider “Fit” or “Blur” for this clip.`);
    return { ...c, reframe: { ...(c.reframe ?? {}), [aspect]: path } };
  });
  if (missing) notes.push(`${missing} clip${missing === 1 ? '' : 's'} differ from the ${aspect} frame but have no face tracking yet, so ${missing === 1 ? 'it is' : 'they are'} centre-cropped. Run “Track faces” in the editor for face-safe reframing.`);
  return { text, clips, notes };
}
