import * as studio from '../../../functions/src/api/studio';
import { loadState, payload, say, studioOwner } from './common';
const st = loadState();
const owner = await studioOwner();
const NOTE = 'Producer reviewed the frames. 3 lyric_cropped errors are OCR false positives (Kasem ε is read as the lookalike ɛ; the full caption is visible in each frame). dialogue_drowned: the song is the untouched soundtrack (audio master preserved), no ducking wanted. credits_cut_off (9:16): title fully inside the frame. continuity 12 s (16:9): seating differs slightly between two shots, accepted.';
for (const id of process.argv.slice(2)) {
  const r = await studio.finalInspectionAction(owner, payload('finalInspectionAction', { projectId: st.projectId, inspectionId: id, action: 'override', note: NOTE }));
  say(`${id}: ${JSON.stringify(r)}`);
}
