import { col, loadState, say } from './common';
const st = loadState();
const wanted = new Set(Object.values(st.renders ?? {}).map((r: any) => r.result?.assetIds?.[0]).filter(Boolean));
const snap = await col.renders().where('projectId', '==', st.projectId).get();
const latest = snap.docs.filter((d) => d.get('quality') === 'final').sort((a, b) => (b.get('createdAt')?.toMillis?.() ?? 0) - (a.get('createdAt')?.toMillis?.() ?? 0)).slice(0, 2);
for (const d of latest) {
  const r: any = d.data();
  console.log('RENDER', d.id, r.preset, `${r.width}x${r.height}@${r.fps}`, `${r.durationSec}s`, 'out', r.outputAssetId, 'insp', JSON.stringify(r.finalInspection));
  const fi = r.finalInspection?.id ? (await col.sub(st.projectId, 'finalInspections').doc(r.finalInspection.id).get()).data() : null;
  if (fi) { console.log('  readiness', fi.readiness, 'score', fi.score, 'errors', fi.errors, 'warnings', fi.warnings, 'override', JSON.stringify(fi.override)); for (const f of fi.findings ?? []) console.log(`   - [${f.severity}] ${f.check} @${f.startSec ?? ''}: ${String(f.message).slice(0, 260)}${f.overridden ? ' (accepted)' : ''}`); }
}
void wanted; say('done');
