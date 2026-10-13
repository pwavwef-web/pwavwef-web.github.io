import * as actions from '../../../functions/src/api/actions';
import { col, loadState, payload, say, studioOwner } from './common';
const st = loadState();
const owner = await studioOwner();
// 1. Titles of this project's assets: the upload helper prefixed "QA · ".
const mine = await col.assets().where('projectId', '==', st.projectId).get();
let renamed = 0;
for (const d of mine.docs) { const t = String(d.get('title') ?? ''); if (t.startsWith('QA · ')) { await d.ref.update({ title: t.slice(5) }); renamed++; } }
say(`renamed ${renamed} assets`);
// 2. The two uploads left in the library by the failed first run (detached when that duplicate project was deleted).
const stray = await col.assets().where('ownerUid', '==', owner.uid).where('projectId', '==', null).get();
for (const d of stray.docs) {
  const t = String(d.get('title') ?? '');
  const created = d.get('createdAt')?.toMillis?.() ?? 0;
  if ((t === 'QA · De N Lei — Come Learn Kasem.wav' || t === 'QA · 1.jpg') && Date.now() - created < 6 * 3600_000) {
    say(`deleting stray ${d.id} "${t}" (${d.get('kind')})`);
    await actions.deleteAsset(owner, payload('deleteAsset', { assetId: d.id }));
  }
}
