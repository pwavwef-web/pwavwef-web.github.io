import { lipSyncClip } from '../../../functions/src/workers/lipsync';
import { col, loadState, patchState, say, studioOwner } from './common';
import { SHOTS } from './shots';

// Usage: 13-lipsync.ts shots=5,8,26,27 [aspects=16:9,9:16] [tier=standard|pro]
// Lip-syncs the artist's singing close-ups to the isolated vocal stem (cleaner than the full mix), using the studio's lip-sync workflow
// (fal.ai sync-lipsync, key from Secret Manager). The result replaces the clip in the shot selection; the original stays in the shot's takes/library.
const only = (process.argv.find((a) => a.startsWith('shots='))?.slice(6) ?? '').split(',').filter(Boolean).map(Number);
const aspects = (process.argv.find((a) => a.startsWith('aspects='))?.slice(8) ?? '16:9,9:16').split(',') as ('16:9' | '9:16')[];
const tier = (process.argv.find((a) => a.startsWith('tier='))?.slice(5) ?? 'standard') as 'standard' | 'pro';
const owner = await studioOwner();
let st = loadState();
const vocals = (await col.assets().doc(st.stems.vocals).get()).data()!;
const lip: Record<string, any> = st.lipsync ?? {};
for (const aspect of aspects) {
  for (const n of only) {
    const s = SHOTS.find((x) => x.n === n)!;
    const key = `${aspect}|${n}`;
    const srcId = st.selection?.[aspect]?.[n] ?? st.genResults?.[`${aspect}|${n}|1080p`]?.assetId;
    if (!srcId) { say(`${key}: no clip yet`); continue; }
    if (lip[key]?.source === srcId && lip[key]?.assetId) { say(`${key}: already lip-synced (${lip[key].assetId})`); continue; }
    const src = (await col.assets().doc(srcId).get()).data()!;
    say(`${key}: lip-sync ${s.title} from ${s.start}s (${src.durationSec}s clip)`);
    const out = await lipSyncClip(
      { id: `lipsync-${aspect.replace(':', 'x')}-${n}-${Date.now().toString(36)}`, ownerUid: owner.uid, projectId: st.projectId },
      { source: { assetId: srcId, storagePath: src.storagePath, title: src.title, durationSec: src.durationSec }, audio: { assetId: st.stems.vocals, storagePath: vocals.storagePath, startSec: s.start }, tier, shotId: st.shotIds[aspect][n] },
      async (stage, v) => say(`  ${key} ${stage} ${Math.round(v * 100)}%`),
    );
    lip[key] = { source: srcId, assetId: out.assetId, costUsd: out.costUsd, requestId: out.requestId };
    st = patchState({ lipsync: lip });
    say(`${key}: done → ${out.assetId} ($${out.costUsd})`);
  }
}
void vocals;
